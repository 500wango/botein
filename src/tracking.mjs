import { createHash, randomUUID } from 'node:crypto';
import { ORG, audit, transaction } from './store.mjs';
import { AppError, requireValue, text } from './validation.mjs';
import { newerThan, pageParams, pageRows } from './pagination.mjs';

function timestamp(value, field) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value), '请填写有效时间。', field);
  const date = new Date(value);
  requireValue(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19), '时间无效。', field);
  return date.toISOString();
}
function dateOnly(value, field) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), '请填写有效日期。', field);
  const date = new Date(`${value}T00:00:00.000Z`);
  requireValue(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, '日期无效。', field);
  return date;
}
function taskData(body) {
  return { title: text(body.title, 'title', 160), notes: text(body.notes ?? '', 'notes', 2000, false), due_at: timestamp(body.due_at, 'due_at') };
}
function task(db, id) {
  const row = db.prepare('SELECT * FROM follow_up_tasks WHERE organization_id=? AND id=?').get(ORG, id);
  requireValue(row, '待办不存在。', undefined, 404, 'NOT_FOUND');
  return row;
}
export function trackingApi(db, path, method, body, query) {
  if (path === '/follow-up-tasks' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const status = query.get('status') ?? 'ALL';
    requireValue(['ALL', 'OPEN', 'OVERDUE', 'TODAY', 'DONE', 'CANCELLED'].includes(status), '请选择有效待办范围。', 'status');
    let filter = '', filterParams = [];
    if (['OPEN', 'DONE', 'CANCELLED'].includes(status)) {
      filter = 'AND t.status = ?'; filterParams = [status];
    } else if (status === 'OVERDUE') {
      filter = "AND t.status = 'OPEN' AND t.due_at < ?"; filterParams = [new Date().toISOString()];
    } else if (status === 'TODAY') {
      const from = timestamp(query.get('from'), 'from'), to = timestamp(query.get('to'), 'to');
      requireValue(from < to, '今天的时间范围无效。', 'from');
      filter = "AND t.status = 'OPEN' AND t.due_at >= ? AND t.due_at < ?"; filterParams = [from, to];
    }
    const total = db.prepare(`SELECT count(*) AS n FROM follow_up_tasks t WHERE t.organization_id=? ${filter}`)
      .get(ORG, ...filterParams).n;
    const base = `SELECT t.*, a.brand_name, o.qualification_status, o.sales_stage
      FROM follow_up_tasks t JOIN opportunities o ON o.id=t.opportunity_id AND o.organization_id=t.organization_id
      JOIN accounts a ON a.id=o.account_id AND a.organization_id=o.organization_id
      WHERE t.organization_id=? ${filter}`;
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY t.due_at ASC, t.id ASC LIMIT ?`).all(ORG, ...filterParams, limit + 1)
      : db.prepare(`${base} AND ${newerThan('t.due_at', 't.id')} ORDER BY t.due_at ASC, t.id ASC LIMIT ?`)
        .all(ORG, ...filterParams, cursor[0], cursor[0], cursor[1], limit + 1);
    return { status: 200, body: { ...pageRows(rows, limit, row => [row.due_at, row.id]), total, generated_at: new Date().toISOString() } };
  }
  if (path === '/follow-up-tasks' && method === 'POST') {
    const data = taskData(body), idempotencyKey = text(body.idempotency_key, 'idempotency_key', 128);
    const opportunityId = text(body.opportunity_id, 'opportunity_id', 100);
    const hash = createHash('sha256').update(JSON.stringify({ opportunityId, ...data })).digest('hex');
    return transaction(db, () => {
      requireValue(db.prepare('SELECT id FROM opportunities WHERE id=? AND organization_id=?').get(opportunityId, ORG), '商机不存在。', 'opportunity_id', 404, 'NOT_FOUND');
      const existing = db.prepare('SELECT * FROM follow_up_tasks WHERE organization_id=? AND idempotency_key=?').get(ORG, idempotencyKey);
      if (existing) {
        requireValue(existing.request_hash === hash, '相同提交标识对应不同内容，请重新打开表单。', undefined, 409, 'IDEMPOTENCY_CONFLICT');
        return { status: 200, body: { ...existing, replayed: true } };
      }
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare(`INSERT INTO follow_up_tasks (id,organization_id,opportunity_id,title,notes,due_at,idempotency_key,request_hash,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, ORG, opportunityId, data.title, data.notes, data.due_at, idempotencyKey, hash, now, now);
      audit(db, 'FOLLOW_UP_CREATED', id, { opportunity_id: opportunityId, ...data });
      return { status: 201, body: task(db, id) };
    });
  }
  const match = path.match(/^\/follow-up-tasks\/([^/]+)$/);
  if (match && method === 'PATCH') {
    return transaction(db, () => {
      const current = task(db, match[1]);
      requireValue(body.expected_version === current.version, '待办已更新，请重新打开后操作。', undefined, 409, 'VERSION_CONFLICT');
      const data = taskData({ ...current, ...body });
      const status = body.status ?? current.status;
      requireValue(['OPEN', 'DONE', 'CANCELLED'].includes(status), '请选择有效待办状态。', 'status');
      if (body.opportunity_id !== undefined) requireValue(body.opportunity_id === current.opportunity_id, '已创建的待办不能转移商机。', 'opportunity_id');
      const reason = text(body.reason ?? '', 'reason', 1000, status !== current.status);
      const now = new Date().toISOString();
      const closedAt = status === 'OPEN' ? null : status === current.status ? current.closed_at : now;
      db.prepare('UPDATE follow_up_tasks SET title=?,notes=?,due_at=?,status=?,closed_at=?,version=version+1,updated_at=? WHERE id=? AND organization_id=?')
        .run(data.title, data.notes, data.due_at, status, closedAt, now, current.id, ORG);
      audit(db, 'FOLLOW_UP_UPDATED', current.id, {
        opportunity_id: current.opportunity_id, reason,
        before: { title: current.title, notes: current.notes, due_at: current.due_at, status: current.status }, after: { ...data, status },
      });
      return { status: 200, body: task(db, current.id) };
    });
  }
  if (path === '/analytics/funnel' && method === 'GET') return { status: 200, body: funnel(db, query) };
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}

function funnel(db, query) {
  const generated = new Date(), today = generated.toISOString().slice(0, 10);
  const defaultFrom = new Date(generated.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const from = query.get('from') ?? defaultFrom, to = query.get('to') ?? today;
  const start = dateOnly(from, 'from'), endDay = dateOnly(to, 'to');
  const asOf = timestamp(query.get('as_of') ?? generated.toISOString(), 'as_of');
  requireValue(start <= endDay, '开始日期不能晚于结束日期。', 'from');
  requireValue(asOf <= generated.toISOString(), '观察截止时间不能在未来。', 'as_of');
  requireValue(to <= asOf.slice(0, 10), '创建日期结束日不能晚于观察截止日。', 'to');
  const endExclusive = new Date(endDay.getTime() + 86400000).toISOString();
  const rows = db.prepare(`SELECT o.id, o.qualification_status,
    (SELECT h.action FROM opportunity_history h WHERE h.organization_id=o.organization_id AND h.opportunity_id=o.id
      AND h.action IN ('QUALIFY','REJECT') AND h.created_at<=? ORDER BY h.created_at, h.rowid LIMIT 1) AS first_decision
    FROM opportunities o WHERE o.organization_id=? AND o.created_at>=? AND o.created_at<? AND o.created_at<=?`)
    .all(asOf, ORG, start.toISOString(), endExclusive, asOf);
  const activities = db.prepare(`SELECT s.opportunity_id, s.activity_type, s.reply_sentiment FROM sales_activities s
    JOIN opportunities o ON o.id=s.opportunity_id AND o.organization_id=s.organization_id
    WHERE o.organization_id=? AND o.created_at>=? AND o.created_at<? AND o.created_at<=?
      AND s.occurred_at<=? AND s.voided_at IS NULL`).all(ORG, start.toISOString(), endExclusive, asOf, asOf);
  const countActivity = (type, sentiment) => new Set(activities.filter(a => a.activity_type === type && (!sentiment || a.reply_sentiment === sentiment)).map(a => a.opportunity_id)).size;
  const reviewed = rows.filter(r => r.first_decision !== null).length;
  const qualified = rows.filter(r => r.first_decision === 'QUALIFY').length;
  return {
    filters: { from, to, as_of: asOf, timezone: 'UTC', assigned_to: 'LOCAL_OWNER', product_category: 'LAUNDRY_PODS', market: 'US' },
    generated_at: generated.toISOString(),
    metrics: {
      candidates: rows.length, reviewed, qualified, qualification_rate: reviewed ? qualified / reviewed : null,
      contacted: countActivity('EMAIL_SENT'), positive_replies: countActivity('REPLY_RECEIVED', 'POSITIVE'),
      meetings: countActivity('MEETING_SCHEDULED'), sample_requests: countActivity('SAMPLE_REQUESTED'),
      quotations: countActivity('QUOTATION_SENT'), won: countActivity('DEAL_WON'), lost: countActivity('DEAL_LOST'),
    },
    current: {
      qualified: rows.filter(r => r.qualification_status === 'QUALIFIED').length,
      reassessment_required: rows.filter(r => r.qualification_status === 'REASSESSMENT_REQUIRED').length,
      pending: rows.filter(r => ['NEW', 'REVIEWING', 'NEEDS_EVIDENCE'].includes(r.qualification_status)).length,
    },
  };
}
