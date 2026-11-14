import { randomUUID, createHash } from 'node:crypto';
import { ORG, profile, transaction, audit } from './store.mjs';
import { reconcileApprovals, redactEvidenceQuotes } from './drafts.mjs';
import { AppError, requireValue, text, publicUrl } from './validation.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';

const stages = ['NOT_STARTED', 'CONTACTED', 'REPLIED', 'MEETING', 'SAMPLE', 'QUOTATION', 'WON'];
const activityStage = {
  EMAIL_SENT: 'CONTACTED', REPLY_RECEIVED: 'REPLIED', MEETING_SCHEDULED: 'MEETING',
  SAMPLE_REQUESTED: 'SAMPLE', SAMPLE_SENT: 'SAMPLE', QUOTATION_SENT: 'QUOTATION',
  FOLLOW_UP: null, DEAL_WON: 'WON', DEAL_LOST: 'LOST',
};
const transitions = {
  START_REVIEW: { from: ['NEW', 'NEEDS_EVIDENCE', 'REASSESSMENT_REQUIRED'], to: 'REVIEWING' },
  QUALIFY: { from: ['REVIEWING'], to: 'QUALIFIED' },
  REQUEST_EVIDENCE: { from: ['NEW', 'REVIEWING'], to: 'NEEDS_EVIDENCE' },
  REJECT: { from: ['REVIEWING'], to: 'REJECTED' },
  ARCHIVE: { from: ['NEW', 'REVIEWING', 'NEEDS_EVIDENCE', 'QUALIFIED', 'REASSESSMENT_REQUIRED'], to: 'ARCHIVED' },
  REOPEN: { from: ['ARCHIVED', 'REJECTED'], to: 'REVIEWING' },
};
function version(row, body) {
  requireValue(row.version === body.expected_version, '记录已更新，请重新打开详情后操作。', undefined, 409, 'VERSION_CONFLICT');
}
function opportunity(db, id) {
  const row = db.prepare('SELECT o.*, a.brand_name, a.website FROM opportunities o JOIN accounts a ON a.id=o.account_id AND a.organization_id=o.organization_id WHERE o.id=? AND o.organization_id=?').get(id, ORG);
  requireValue(row, '商机不存在。', undefined, 404, 'NOT_FOUND');
  return row;
}
function evidence(db, id) {
  const row = db.prepare('SELECT * FROM evidence WHERE id=? AND organization_id=?').get(id, ORG);
  requireValue(row, '证据不存在。', undefined, 404, 'NOT_FOUND');
  return row;
}
function contact(db, id) {
  const row = db.prepare(`SELECT c.*, s.reason AS suppression_reason FROM contacts c
    LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
    WHERE c.id=? AND c.organization_id=?`).get(id, ORG);
  requireValue(row, '联系人不存在。', undefined, 404, 'NOT_FOUND');
  return row;
}
function history(db, id, action, reason, details = {}) {
  db.prepare('INSERT INTO opportunity_history VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), ORG, id, action, reason, JSON.stringify({ ...details, actor: 'LOCAL_OWNER' }), new Date().toISOString());
  audit(db, action, id);
}
export function reassessQualified(db, reason, evidenceId) {
  const rows = evidenceId
    ? db.prepare(`SELECT DISTINCT o.id FROM opportunities o JOIN opportunity_evidence oe ON oe.opportunity_id=o.id AND oe.organization_id=o.organization_id
        WHERE o.organization_id=? AND o.qualification_status='QUALIFIED' AND oe.evidence_id=?`).all(ORG, evidenceId)
    : db.prepare("SELECT id FROM opportunities WHERE organization_id=? AND qualification_status='QUALIFIED'").all(ORG);
  for (const row of rows) {
    db.prepare("UPDATE opportunities SET qualification_status='REASSESSMENT_REQUIRED', version=version+1, updated_at=? WHERE id=? AND organization_id=?")
      .run(new Date().toISOString(), row.id, ORG);
    history(db, row.id, 'REASSESSMENT_REQUIRED', reason, { evidence_id: evidenceId ?? null });
  }
}
function recomputeStage(db, id) {
  const activities = db.prepare('SELECT activity_type FROM sales_activities WHERE opportunity_id=? AND organization_id=? AND voided_at IS NULL').all(id, ORG);
  const terminal = activities.find(x => ['DEAL_WON', 'DEAL_LOST'].includes(x.activity_type));
  const stage = terminal ? activityStage[terminal.activity_type] : stages[Math.max(0, ...activities.map(x => stages.indexOf(activityStage[x.activity_type])))];
  db.prepare('UPDATE opportunities SET sales_stage=?, version=version+1, updated_at=? WHERE id=? AND organization_id=?')
    .run(stage, new Date().toISOString(), id, ORG);
  return stage;
}
function detail(db, id) {
  const item = opportunity(db, id);
  return {
    ...item,
    evidence: db.prepare('SELECT e.*,p.product_name,p.product_category,p.status AS product_status FROM evidence e LEFT JOIN account_products p ON p.id=e.product_id AND p.organization_id=e.organization_id WHERE e.organization_id=? AND e.account_id=? ORDER BY e.created_at DESC,e.id').all(ORG, item.account_id),
    references: db.prepare('SELECT role, evidence_id, evidence_version FROM opportunity_evidence WHERE organization_id=? AND opportunity_id=?').all(ORG, id),
    contacts: db.prepare(`SELECT c.*, s.reason AS suppression_reason FROM contacts c
      LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
      WHERE c.organization_id=? AND c.account_id=? ORDER BY c.created_at DESC, c.id`).all(ORG, item.account_id),
    activities: db.prepare(`SELECT s.*, COALESCE(json_extract(s.contact_snapshot,'$.full_name'), c.full_name) AS full_name, COALESCE(json_extract(s.contact_snapshot,'$.email'), c.email) AS email FROM sales_activities s LEFT JOIN contacts c ON c.id=s.contact_id AND c.organization_id=s.organization_id
      WHERE s.organization_id=? AND s.opportunity_id=? ORDER BY s.occurred_at DESC, s.created_at DESC, s.id`).all(ORG, id),
    history: db.prepare('SELECT action, reason, snapshot, created_at FROM opportunity_history WHERE organization_id=? AND opportunity_id=? ORDER BY created_at DESC, rowid DESC').all(ORG, id)
      .map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) })),
  };
}

// Local-owner manual workflow. No model calls or outbound contact actions.
export function salesApi(db, path, method, body, query) {
  let match;
  if ((match = path.match(/^\/evidence\/([^/]+)\/(verify|invalidate|purge)$/)) && method === 'POST') {
    const [, id, action] = match;
    return transaction(db, () => {
      const row = evidence(db, id); version(row, body);
      const reason = text(body.reason, 'reason', 1000);
      if (action === 'purge') {
        requireValue(!row.purged_at, '原文已按保留政策清除。', undefined, 409, 'INVALID_TRANSITION');
        requireValue(body.confirmed === true, '请确认清除原文且不可恢复，依赖它的批准将失效。', 'confirmed');
        const now = new Date().toISOString();
        db.prepare(`UPDATE evidence SET raw_text='',verification_status='INVALIDATED',checked_at=NULL,verification_note='',
          purged_at=?,purge_reason=?,version=version+1 WHERE id=? AND organization_id=?`).run(now, reason, id, ORG);
        const redacted = redactEvidenceQuotes(db, id);
        const assessmentsRedacted = db.prepare(`UPDATE signal_assessments
          SET observed_facts='[]',business_hypotheses='[]',missing_information='[]'
          WHERE organization_id=? AND evidence_id=?`).run(ORG, id).changes;
        reassessQualified(db, `证据原文已按保留政策清除：${reason}`, id);
        audit(db, 'EVIDENCE_PURGED', id, { reason, purged_at: now, previous_status: row.verification_status, previous_version: row.version, quotes_redacted: redacted, assessments_redacted: assessmentsRedacted });
        reconcileApprovals(db);
        return { status: 200, body: evidence(db, id) };
      }
      requireValue(!row.purged_at, '原文已按保留政策清除，不能重新核验或标记失效。', undefined, 409, 'INVALID_TRANSITION');
      if (action === 'verify') {
        requireValue(row.source_url, '请重新录入带来源的证据后核验，原文记录不会被改写。', 'reason');
        if (row.product_id) {
          const product = db.prepare('SELECT * FROM account_products WHERE id=? AND account_id=? AND organization_id=?').get(row.product_id, row.account_id, ORG);
          requireValue(product?.status === 'ACTIVE', '关联产品已归档，请先修订归属或恢复产品。');
          db.prepare('UPDATE evidence SET product_version=? WHERE id=? AND organization_id=?').run(product.version, id, ORG);
        }
        requireValue(body.confirmed === true, '请确认已打开来源并核对原文和品牌归属。', 'confirmed');
        requireValue(row.verification_status !== 'INVALIDATED', '被证伪的证据保留历史，请录入正确证据。', undefined, 409, 'INVALID_TRANSITION');
      }
      db.prepare('UPDATE evidence SET verification_status=?, version=version+1, checked_at=?, verification_note=? WHERE id=? AND organization_id=?')
        .run(action === 'verify' ? 'VERIFIED' : 'INVALIDATED', new Date().toISOString(), reason, id, ORG);
      if (action === 'invalidate') reassessQualified(db, `引用证据失效：${reason}`, id);
      audit(db, action === 'verify' ? 'EVIDENCE_VERIFIED_MANUALLY' : 'EVIDENCE_INVALIDATED', id, { reason, previous_status: row.verification_status, previous_version: row.version });
      reconcileApprovals(db);
      return { status: 200, body: evidence(db, id) };
    });
  }
  if (path === '/opportunities' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const status = query.get('status') ?? 'ALL';
    requireValue(['ALL', 'PENDING', 'QUALIFIED', 'REJECTED', 'ARCHIVED'].includes(status), '请选择有效审核状态。', 'status');
    const pending = ['NEW', 'REVIEWING', 'NEEDS_EVIDENCE', 'REASSESSMENT_REQUIRED'];
    const filter = status === 'PENDING' ? `AND o.qualification_status IN (${pending.map(() => '?').join(',')})`
      : status === 'ALL' ? '' : 'AND o.qualification_status = ?';
    const filterParams = status === 'PENDING' ? pending : status === 'ALL' ? [] : [status];
    const total = db.prepare(`SELECT count(*) AS n FROM opportunities o WHERE o.organization_id=? ${filter}`)
      .get(ORG, ...filterParams).n;
    const base = `SELECT o.*, a.brand_name FROM opportunities o JOIN accounts a ON a.id=o.account_id AND a.organization_id=o.organization_id
      WHERE o.organization_id=? ${filter}`;
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY o.updated_at DESC, o.id DESC LIMIT ?`).all(ORG, ...filterParams, limit + 1)
      : db.prepare(`${base} AND ${olderThan('o.updated_at', 'o.id')} ORDER BY o.updated_at DESC, o.id DESC LIMIT ?`)
        .all(ORG, ...filterParams, cursor[0], cursor[0], cursor[1], limit + 1);
    return { status: 200, body: { ...pageRows(rows, limit, row => [row.updated_at, row.id]), total } };
  }
  if (path === '/opportunities/options' && method === 'GET') {
    return { status: 200, body: { items: db.prepare(`SELECT o.id,o.qualification_status,o.sales_stage,a.brand_name
      FROM opportunities o JOIN accounts a ON a.id=o.account_id AND a.organization_id=o.organization_id
      WHERE o.organization_id=? ORDER BY o.updated_at DESC, o.id DESC`).all(ORG) } };
  }
  if (path === '/opportunities' && method === 'POST') {
    const accountId = text(body.account_id, 'account_id', 100), reason = text(body.reason, 'reason', 2000);
    return transaction(db, () => {
      requireValue(db.prepare('SELECT id FROM accounts WHERE id=? AND organization_id=?').get(accountId, ORG), '品牌不存在。', 'account_id', 404, 'NOT_FOUND');
      const existing = db.prepare('SELECT id FROM opportunities WHERE account_id=? AND organization_id=? AND product_category=?').get(accountId, ORG, 'LAUNDRY_PODS');
      if (existing) return { status: 200, body: { ...opportunity(db, existing.id), reused: true } };
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO opportunities (id,organization_id,account_id,reason,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, ORG, accountId, reason, now, now);
      history(db, id, 'CREATED_MANUALLY', reason);
      return { status: 201, body: opportunity(db, id) };
    });
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)$/)) && method === 'GET') return { status: 200, body: detail(db, match[1]) };
  if ((match = path.match(/^\/opportunities\/([^/]+)\/transitions$/)) && method === 'POST') {
    return transaction(db, () => {
      const item = opportunity(db, match[1]); version(item, body);
      const transition = Object.hasOwn(transitions, body.action) ? transitions[body.action] : null;
      requireValue(transition && transition.from.includes(item.qualification_status), '当前状态不允许这个操作。', undefined, 409, 'INVALID_TRANSITION');
      if (body.action === 'START_REVIEW' && item.qualification_status === 'NEEDS_EVIDENCE') {
        requireValue(db.prepare("SELECT id FROM evidence WHERE organization_id=? AND account_id=? AND verification_status='VERIFIED' AND checked_at>? LIMIT 1").get(ORG, item.account_id, item.updated_at), '请先补充或重新核验所缺证据，再恢复审核。');
      }
      const reason = text(body.reason, 'reason', 2000);
      let pending = item.pending_info, factoryVersion = item.factory_version;
      const refs = [];
      if (body.action === 'QUALIFY') {
        const factory = profile(db);
        requireValue(factory.status === 'ACTIVE' && factory.supported_products.includes('LAUNDRY_PODS') && factory.target_markets.includes('US'), '工厂档案尚未启用或能力不匹配，请先核对。');
        requireValue(body.no_known_conflict === true, '已知存在硬约束冲突的商机不能审核合格。', 'no_known_conflict');
        pending = text(body.pending_info, 'pending_info', 2000);
        for (const role of ['PRODUCT', 'MARKET', 'REASON']) {
          const id = text(body[`${role.toLowerCase()}_evidence_id`], `${role.toLowerCase()}_evidence_id`, 100);
          const source = evidence(db, id);
          requireValue(source.account_id === item.account_id && source.verification_status === 'VERIFIED', '请选择本品牌已核验的证据。', `${role.toLowerCase()}_evidence_id`);
          if (source.product_id) {
            const product = db.prepare('SELECT product_category,status FROM account_products WHERE id=? AND account_id=? AND organization_id=?').get(source.product_id, item.account_id, ORG);
            requireValue(product?.status === 'ACTIVE' && product.product_category === item.product_category, '所选产品证据不属于首发品类或产品已归档。', `${role.toLowerCase()}_evidence_id`);
          }
          if (role === 'MARKET') requireValue(source.checked_at && Date.now() - Date.parse(source.checked_at) <= 7 * 86400000, '美国在售证据已超过 7 天，请重新核验。', 'market_evidence_id');
          refs.push({ role, id, version: source.version });
        }
        requireValue(body.facts_confirmed === true, '请确认所选证据分别支持品类、美国在售及开发理由。', 'facts_confirmed');
        db.prepare('DELETE FROM opportunity_evidence WHERE opportunity_id=? AND organization_id=?').run(item.id, ORG);
        for (const ref of refs) db.prepare('INSERT INTO opportunity_evidence VALUES (?,?,?,?,?)').run(ORG, item.id, ref.id, ref.role, ref.version);
        factoryVersion = factory.version;
      }
      db.prepare('UPDATE opportunities SET qualification_status=?, reason=?, pending_info=?, factory_version=?, version=version+1, updated_at=? WHERE id=? AND organization_id=?')
        .run(transition.to, body.action === 'QUALIFY' ? reason : item.reason, pending, factoryVersion, new Date().toISOString(), item.id, ORG);
      history(db, item.id, body.action, reason, { from: item.qualification_status, to: transition.to, references: refs, factory_version: factoryVersion, pending_info: pending });
      reconcileApprovals(db);
      return { status: 200, body: opportunity(db, item.id) };
    });
  }
  if (path === '/contacts' && method === 'POST') {
    const accountId = text(body.account_id, 'account_id', 100);
    const name = text(body.full_name, 'full_name', 100), title = text(body.job_title ?? '', 'job_title', 100, false);
    const email = text(body.email, 'email', 254).toLowerCase();
    requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), '请填写有效邮箱；格式校验不代表邮箱可投递。', 'email');
    const source = publicUrl(body.source_url, 'source_url');
    return transaction(db, () => {
      requireValue(db.prepare('SELECT id FROM accounts WHERE id=? AND organization_id=?').get(accountId, ORG), '品牌不存在。', 'account_id', 404, 'NOT_FOUND');
      const existing = db.prepare('SELECT id FROM contacts WHERE account_id=? AND organization_id=? AND email=?').get(accountId, ORG, email);
      if (existing) return { status: 200, body: { ...contact(db, existing.id), reused: true } };
      const id = randomUUID();
      db.prepare('INSERT INTO contacts (id,organization_id,account_id,full_name,job_title,email,source_url,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, ORG, accountId, name, title, email, source, new Date().toISOString());
      audit(db, 'CONTACT_RECORDED', id);
      return { status: 201, body: contact(db, id) };
    });
  }
  if ((match = path.match(/^\/contacts\/([^/]+)\/(verify|suppress|stale)$/)) && method === 'POST') {
    return transaction(db, () => {
      const [, id, action] = match, row = contact(db, id); version(row, body);
      const reason = text(body.reason, 'reason', 1000);
      if (action === 'verify') {
        requireValue(!row.suppression_reason, '该联系渠道已禁止联系，不能重新核验为可用。');
        requireValue(body.confirmed === true, '请确认已核对公开来源中的身份、职能和渠道。', 'confirmed');
      }
      if (action === 'suppress') db.prepare('INSERT INTO contact_suppressions VALUES (?,?,?,?) ON CONFLICT(organization_id,email) DO NOTHING').run(ORG, row.email, reason, new Date().toISOString());
      db.prepare('UPDATE contacts SET verification_status=?, version=version+1, checked_at=? WHERE id=? AND organization_id=?')
        .run(action === 'verify' ? 'VERIFIED' : action === 'stale' ? 'STALE' : row.verification_status, new Date().toISOString(), id, ORG);
      audit(db, `CONTACT_${action.toUpperCase()}`, id, { reason, previous_status: row.verification_status, previous_version: row.version });
      reconcileApprovals(db);
      return { status: 200, body: contact(db, id) };
    });
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)\/activities$/)) && method === 'POST') {
    const id = match[1];
    const type = text(body.activity_type, 'activity_type', 40);
    requireValue(Object.hasOwn(activityStage, type), '活动类型不支持。', 'activity_type');
    const key = text(body.idempotency_key, 'idempotency_key', 128);
    requireValue(typeof body.occurred_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(body.occurred_at), '请选择实际发生时间。', 'occurred_at');
    const occurred = new Date(body.occurred_at);
    requireValue(Number.isFinite(occurred.getTime()) && occurred.getTime() <= Date.now() && occurred.toISOString().slice(0, 10) === body.occurred_at.slice(0, 10), '活动时间无效或在未来。', 'occurred_at');
    const notes = text(body.notes ?? '', 'notes', 2000, type === 'DEAL_LOST');
    const sentiment = type === 'REPLY_RECEIVED' ? body.reply_sentiment : 'UNKNOWN';
    requireValue(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'UNKNOWN'].includes(sentiment), '请选择回复性质。', 'reply_sentiment');
    const contactId = body.contact_id ? text(body.contact_id, 'contact_id', 100) : null;
    requireValue(!['EMAIL_SENT', 'REPLY_RECEIVED'].includes(type) || contactId, '邮件和回复记录需要联系人。', 'contact_id');
    if (type === 'EMAIL_SENT') requireValue(body.sent_confirmed === true, '请确认已经在外部邮箱实际发送。', 'sent_confirmed');
    let cents = null, currency = '';
    if (type === 'DEAL_WON' && body.amount !== '' && body.amount != null) {
      const amount = String(body.amount);
      requireValue(/^\d{1,10}(?:\.\d{1,2})?$/.test(amount), '金额应为非负数，最多两位小数；未知可留空。', 'amount');
      const [whole, fraction = ''] = amount.split('.'); cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      currency = text(body.currency, 'currency', 3).toUpperCase();
      requireValue(['USD', 'CNY', 'EUR'].includes(currency), '请选择 USD、CNY 或 EUR。', 'currency');
    }
    const draftVersionId = body.draft_version_id ? text(body.draft_version_id, 'draft_version_id', 100) : null;
    const normalized = { id, type, contactId, draftVersionId, occurred_at: occurred.toISOString(), notes, sentiment, cents, currency };
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    return transaction(db, () => {
      const item = opportunity(db, id);
      const replay = db.prepare('SELECT * FROM sales_activities WHERE organization_id=? AND idempotency_key=?').get(ORG, key);
      if (replay) {
        requireValue(replay.request_hash === hash, '相同提交标识对应不同内容，请重新打开记录表单。', undefined, 409, 'IDEMPOTENCY_CONFLICT');
        return { status: 200, body: { ...replay, sales_stage: item.sales_stage, replayed: true } };
      }
      version(item, body);
      const person = contactId ? contact(db, contactId) : null;
      requireValue(!person || person.account_id === item.account_id, '联系人必须属于当前商机品牌。', 'contact_id');
      if (['DEAL_WON', 'DEAL_LOST'].includes(type)) requireValue(!['WON', 'LOST'].includes(item.sales_stage), '已存在成交或丢单结论，请先作废错误活动再更正。', undefined, 409, 'INVALID_TRANSITION');
      if (draftVersionId) {
        const draft = db.prepare('SELECT v.contact_id, d.opportunity_id FROM draft_versions v JOIN drafts d ON d.id=v.draft_id AND d.organization_id=v.organization_id WHERE v.id=? AND v.organization_id=?').get(draftVersionId, ORG);
        requireValue(type === 'EMAIL_SENT' && draft?.opportunity_id === id && draft.contact_id === contactId, '发送记录引用的草稿必须属于此商机和联系人。', 'draft_version_id');
      }
      const activityId = randomUUID();
      db.prepare(`INSERT INTO sales_activities (id,organization_id,opportunity_id,contact_id,activity_type,occurred_at,notes,reply_sentiment,amount_cents,currency,idempotency_key,request_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(activityId, ORG, id, contactId, type, occurred.toISOString(), notes, sentiment, cents, currency, key, hash, new Date().toISOString());
      if (draftVersionId) db.prepare('UPDATE sales_activities SET draft_version_id=? WHERE id=? AND organization_id=?').run(draftVersionId, activityId, ORG);
      if (person) db.prepare('UPDATE sales_activities SET contact_snapshot=? WHERE id=? AND organization_id=?')
        .run(JSON.stringify({ full_name: person.full_name, job_title: person.job_title, email: person.email, source_url: person.source_url, version: person.version, provenance: 'AT_RECORDING' }), activityId, ORG);
      const stage = recomputeStage(db, id);
      reconcileApprovals(db);
      history(db, id, 'ACTIVITY_RECORDED', notes || type, { activity_id: activityId, activity_type: type, occurred_at: occurred.toISOString(), sales_stage: stage, verification_method: 'USER_REPORTED' });
      return { status: 201, body: { id: activityId, sales_stage: stage, verification_method: 'USER_REPORTED', warning: person?.suppression_reason ? '该渠道已禁止联系，本次仅补记实际历史，不恢复可联系状态。' : null } };
    });
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)\/activities\/([^/]+)\/void$/)) && method === 'POST') {
    return transaction(db, () => {
      const item = opportunity(db, match[1]); version(item, body);
      const activity = db.prepare('SELECT id, voided_at FROM sales_activities WHERE id=? AND opportunity_id=? AND organization_id=?').get(match[2], item.id, ORG);
      requireValue(activity, '活动不存在。', undefined, 404, 'NOT_FOUND');
      requireValue(!activity.voided_at, '这条活动已作废。', undefined, 409, 'INVALID_TRANSITION');
      const reason = text(body.reason, 'reason', 1000);
      db.prepare('UPDATE sales_activities SET voided_at=?,void_reason=? WHERE id=? AND organization_id=?').run(new Date().toISOString(), reason, activity.id, ORG);
      const stage = recomputeStage(db, item.id);
      history(db, item.id, 'ACTIVITY_VOIDED', reason, { activity_id: activity.id, sales_stage: stage });
      return { status: 200, body: { sales_stage: stage } };
    });
  }
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
