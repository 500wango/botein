import { createHash, randomUUID } from 'node:crypto';
import { getEnabledScope } from './catalog.mjs';
import { reconcileApprovals, redactEvidenceQuotes } from './drafts.mjs';
import { evaluateOpportunityFit } from './fit.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';
import { ORG, audit, profile, requestContext, resolveAssignee, transaction } from './store.mjs';
import { AppError, publicUrl, optionalPublicUrl, requireValue, text } from './validation.mjs';

const ROLE_RELEVANCE = ['DECISION_MAKER', 'PROCUREMENT', 'OPERATIONS', 'SALES', 'GENERAL', 'UNKNOWN'];
const stages = ['NOT_STARTED', 'CONTACTED', 'REPLIED', 'MEETING', 'SAMPLE', 'QUOTATION', 'WON'];
const ALL_STAGES = [...stages, 'LOST'];
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

function opportunity(db, id, orgId = ORG) {
  const row = db.prepare('SELECT o.*, a.brand_name, a.website FROM opportunities o JOIN accounts a ON a.id=o.account_id AND a.organization_id=o.organization_id WHERE o.id=? AND o.organization_id=?').get(id, orgId);
  requireValue(row, '商机不存在。', undefined, 404, 'NOT_FOUND');
  return {
    ...row,
    fit_checks: row.fit_checks ? JSON.parse(row.fit_checks) : [],
  };
}

function evidence(db, id, orgId = ORG) {
  const row = db.prepare('SELECT * FROM evidence WHERE id=? AND organization_id=?').get(id, orgId);
  requireValue(row, '证据不存在。', undefined, 404, 'NOT_FOUND');
  return row;
}

function contact(db, id, orgId = ORG) {
  const row = db.prepare(`SELECT c.*, s.reason AS suppression_reason FROM contacts c
    LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
    WHERE c.id=? AND c.organization_id=?`).get(id, orgId);
  requireValue(row, '联系人不存在。', undefined, 404, 'NOT_FOUND');
  return row;
}

function history(db, id, action, reason, details = {}, ctx = null) {
  const { orgId, actor } = requestContext(ctx);
  db.prepare('INSERT INTO opportunity_history (id,organization_id,opportunity_id,action,reason,snapshot,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), orgId, id, action, reason, JSON.stringify({ ...details, actor }), new Date().toISOString());
  audit(db, action, id, details, ctx);
}

export function refreshAccountOpportunitiesFit(db, accountId, orgId = ORG) {
  const opps = db.prepare('SELECT id, account_id, product_category, estimated_order_quantity FROM opportunities WHERE organization_id=? AND account_id=?').all(orgId, accountId);
  const now = new Date().toISOString();
  for (const opp of opps) {
    const fit = evaluateOpportunityFit(db, opp, orgId);
    db.prepare('UPDATE opportunities SET fit_status=?, fit_checks=?, updated_at=? WHERE id=? AND organization_id=?')
      .run(fit.fit_status, JSON.stringify(fit.fit_checks), now, opp.id, orgId);
  }
}

export function reassessQualified(db, reason, evidenceId, ctx = null) {
  const { orgId } = requestContext(ctx);
  const rows = evidenceId
    ? db.prepare(`SELECT DISTINCT o.id FROM opportunities o JOIN opportunity_evidence oe ON oe.opportunity_id=o.id AND oe.organization_id=o.organization_id
        WHERE o.organization_id=? AND o.qualification_status='QUALIFIED' AND oe.evidence_id=?`).all(orgId, evidenceId)
    : db.prepare("SELECT id FROM opportunities WHERE organization_id=? AND qualification_status='QUALIFIED'").all(orgId);
  for (const row of rows) {
    db.prepare("UPDATE opportunities SET qualification_status='REASSESSMENT_REQUIRED', version=version+1, updated_at=? WHERE id=? AND organization_id=?")
      .run(new Date().toISOString(), row.id, orgId);
    history(db, row.id, 'REASSESSMENT_REQUIRED', reason, { evidence_id: evidenceId ?? null }, ctx);
  }
}

function recomputeStage(db, id, orgId = ORG) {
  const activities = db.prepare('SELECT activity_type FROM sales_activities WHERE opportunity_id=? AND organization_id=? AND voided_at IS NULL').all(id, orgId);
  const terminal = activities.find(x => ['DEAL_WON', 'DEAL_LOST'].includes(x.activity_type));
  const stage = terminal ? activityStage[terminal.activity_type] : stages[Math.max(0, ...activities.map(x => stages.indexOf(activityStage[x.activity_type])))];
  db.prepare('UPDATE opportunities SET sales_stage=?, version=version+1, updated_at=? WHERE id=? AND organization_id=?')
    .run(stage, new Date().toISOString(), id, orgId);
  return stage;
}

function detail(db, id, orgId = ORG) {
  const item = opportunity(db, id, orgId);
  const liveFit = evaluateOpportunityFit(db, item, orgId);
  return {
    ...item,
    fit_status: item.fit_status || liveFit.fit_status,
    fit_checks: item.fit_checks?.length ? item.fit_checks : liveFit.fit_checks,
    evidence: db.prepare('SELECT e.*,p.product_name,p.product_category,p.status AS product_status FROM evidence e LEFT JOIN account_products p ON p.id=e.product_id AND p.organization_id=e.organization_id WHERE e.organization_id=? AND e.account_id=? ORDER BY e.created_at DESC,e.id').all(orgId, item.account_id),
    references: db.prepare('SELECT role, evidence_id, evidence_version FROM opportunity_evidence WHERE organization_id=? AND opportunity_id=?').all(orgId, id),
    contacts: db.prepare(`SELECT c.*, s.reason AS suppression_reason FROM contacts c
      LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
      WHERE c.organization_id=? AND c.account_id=? ORDER BY c.created_at DESC, c.id`).all(orgId, item.account_id),
    activities: db.prepare(`SELECT s.*, COALESCE(json_extract(s.contact_snapshot,'$.full_name'), c.full_name) AS full_name, COALESCE(json_extract(s.contact_snapshot,'$.email'), c.email) AS email FROM sales_activities s LEFT JOIN contacts c ON c.id=s.contact_id AND c.organization_id=s.organization_id
      WHERE s.organization_id=? AND s.opportunity_id=? ORDER BY s.occurred_at DESC, s.created_at DESC, s.id`).all(orgId, id),
    history: db.prepare('SELECT action, reason, snapshot, created_at FROM opportunity_history WHERE organization_id=? AND opportunity_id=? ORDER BY created_at DESC, rowid DESC').all(orgId, id)
      .map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) })),
  };
}

// Local-owner / workspace manual workflow. No model calls or outbound contact actions.
export function salesApi(db, path, method, body, query, ctx = null) {
  const { orgId } = requestContext(ctx);
  let match;
  if ((match = path.match(/^\/evidence\/([^/]+)\/(verify|invalidate|purge)$/)) && method === 'POST') {
    const [, id, action] = match;
    return transaction(db, () => {
      const row = evidence(db, id, orgId); version(row, body);
      const reason = text(body.reason, 'reason', 1000);
      if (action === 'purge') {
        requireValue(!row.purged_at, '原文已按保留政策清除。', undefined, 409, 'INVALID_TRANSITION');
        requireValue(body.confirmed === true, '请确认清除原文且不可恢复，依赖它的批准将失效。', 'confirmed');
        const now = new Date().toISOString();
        db.prepare(`UPDATE evidence SET raw_text='',verification_status='INVALIDATED',checked_at=NULL,verification_note='',
          purged_at=?,purge_reason=?,version=version+1 WHERE id=? AND organization_id=?`).run(now, reason, id, orgId);
        const redacted = redactEvidenceQuotes(db, id, orgId);
        const assessmentsRedacted = db.prepare(`UPDATE signal_assessments
          SET observed_facts='[]',business_hypotheses='[]',missing_information='[]'
          WHERE organization_id=? AND evidence_id=?`).run(orgId, id).changes;
        reassessQualified(db, `证据原文已按保留政策清除：${reason}`, id, ctx);
        refreshAccountOpportunitiesFit(db, row.account_id, orgId);
        audit(db, 'EVIDENCE_PURGED', id, { reason, purged_at: now, previous_status: row.verification_status, previous_version: row.version, quotes_redacted: redacted, assessments_redacted: assessmentsRedacted }, ctx);
        reconcileApprovals(db, { accountId: row.account_id }, ctx);
        return { status: 200, body: evidence(db, id, orgId) };
      }
      requireValue(!row.purged_at, '原文已按保留政策清除，不能重新核验或标记失效。', undefined, 409, 'INVALID_TRANSITION');
      if (action === 'verify') {
        requireValue(row.source_url, '请重新录入带来源的证据后核验，原文记录不会被改写。', 'reason');
        let verifiedProductVersion = row.product_version;
        if (row.product_id) {
          const product = db.prepare('SELECT * FROM account_products WHERE id=? AND account_id=? AND organization_id=?').get(row.product_id, row.account_id, orgId);
          requireValue(product?.status === 'ACTIVE', '关联产品已归档，请先修订归属或恢复产品。');
          db.prepare('UPDATE evidence SET product_version=? WHERE id=? AND organization_id=?').run(product.version, id, orgId);
          verifiedProductVersion = product.version;
        }
        requireValue(body.confirmed === true, '请确认已打开来源并核对原文和品牌归属。', 'confirmed');
        requireValue(row.verification_status !== 'INVALIDATED', '被证伪的证据保留历史，请录入正确证据。', undefined, 409, 'INVALID_TRANSITION');
        db.prepare('UPDATE evidence SET verification_status=?, version=version+1, checked_at=?, verification_note=? WHERE id=? AND organization_id=?')
          .run('VERIFIED', new Date().toISOString(), reason, id, orgId);
        // Refreshing checked_at on an already-verified non-expired record with unchanged product keeps active qualification refs in sync.
        if (row.verification_status === 'VERIFIED' && row.availability_status !== 'EXPIRED' && (!row.product_id || verifiedProductVersion === row.product_version)) {
          db.prepare('UPDATE opportunity_evidence SET evidence_version=? WHERE organization_id=? AND evidence_id=? AND evidence_version=?')
            .run(row.version + 1, orgId, id, row.version);
        }
      } else {
        db.prepare('UPDATE evidence SET verification_status=?, version=version+1, checked_at=?, verification_note=? WHERE id=? AND organization_id=?')
          .run('INVALIDATED', new Date().toISOString(), reason, id, orgId);
        reassessQualified(db, `引用证据失效：${reason}`, id, ctx);
      }
      refreshAccountOpportunitiesFit(db, row.account_id, orgId);
      audit(db, action === 'verify' ? 'EVIDENCE_VERIFIED_MANUALLY' : 'EVIDENCE_INVALIDATED', id, { reason, previous_status: row.verification_status, previous_version: row.version }, ctx);
      reconcileApprovals(db, { accountId: row.account_id }, ctx);
      return { status: 200, body: evidence(db, id, orgId) };
    });
  }
  if (path === '/opportunities' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const status = query.get('status') ?? 'ALL';
    requireValue(['ALL', 'PENDING', 'QUALIFIED', 'REJECTED', 'ARCHIVED'].includes(status), '请选择有效审核状态。', 'status');
    const fitFilter = query.get('fit_status') ?? 'ALL';
    requireValue(['ALL', 'ELIGIBLE', 'NEEDS_REVIEW', 'NOT_FIT'].includes(fitFilter), '请选择有效适配状态。', 'fit_status');
    const stageFilter = query.get('sales_stage') ?? 'ALL';
    requireValue(stageFilter === 'ALL' || ALL_STAGES.includes(stageFilter), '请选择有效销售阶段。', 'sales_stage');
    const hasContact = query.get('has_contact') ?? 'ALL';
    requireValue(['ALL', 'USABLE', 'NONE'].includes(hasContact), '请选择有效联系人筛选条件。', 'has_contact');
    const categoryFilter = query.get('product_category') ? String(query.get('product_category')).trim().slice(0, 40) : 'ALL';
    const assignedFilter = query.get('assigned_to') ? String(query.get('assigned_to')).trim().slice(0, 64) : '';
    const q = String(query.get('q') ?? '').trim().slice(0, 100);

    const pending = ['NEW', 'REVIEWING', 'NEEDS_EVIDENCE', 'REASSESSMENT_REQUIRED'];
    const clauses = [];
    const filterParams = [];
    if (status === 'PENDING') {
      clauses.push(`o.qualification_status IN (${pending.map(() => '?').join(',')})`);
      filterParams.push(...pending);
    } else if (status !== 'ALL') {
      clauses.push('o.qualification_status = ?');
      filterParams.push(status);
    }
    if (fitFilter !== 'ALL') {
      clauses.push('o.fit_status = ?');
      filterParams.push(fitFilter);
    }
    if (stageFilter !== 'ALL') {
      clauses.push('o.sales_stage = ?');
      filterParams.push(stageFilter);
    }
    if (categoryFilter && categoryFilter !== 'ALL') {
      clauses.push('o.product_category = ?');
      filterParams.push(categoryFilter);
    }
    if (hasContact === 'USABLE') {
      clauses.push(`EXISTS (
        SELECT 1 FROM contacts c
        LEFT JOIN contact_suppressions cs ON cs.organization_id=c.organization_id AND cs.email=c.email
        WHERE c.organization_id=o.organization_id AND c.account_id=o.account_id
          AND c.verification_status='VERIFIED' AND cs.email IS NULL
      )`);
    } else if (hasContact === 'NONE') {
      clauses.push(`NOT EXISTS (
        SELECT 1 FROM contacts c
        LEFT JOIN contact_suppressions cs ON cs.organization_id=c.organization_id AND cs.email=c.email
        WHERE c.organization_id=o.organization_id AND c.account_id=o.account_id
          AND c.verification_status='VERIFIED' AND cs.email IS NULL
      )`);
    }
    if (assignedFilter) {
      clauses.push('o.assigned_to = ?');
      filterParams.push(assignedFilter);
    }
    if (q) {
      const term = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push(`(a.brand_name LIKE ? ESCAPE '\\' OR a.normalized_domain LIKE ? ESCAPE '\\')`);
      filterParams.push(term, term);
    }
    const filter = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) AS n FROM opportunities o JOIN accounts a ON a.id=o.account_id AND a.organization_id=o.organization_id WHERE o.organization_id=? ${filter}`)
      .get(orgId, ...filterParams).n;
    const base = `SELECT o.*, a.brand_name FROM opportunities o JOIN accounts a ON a.id=o.account_id AND a.organization_id=o.organization_id
      WHERE o.organization_id=? ${filter}`;
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY o.updated_at DESC, o.id DESC LIMIT ?`).all(orgId, ...filterParams, limit + 1)
      : db.prepare(`${base} AND ${olderThan('o.updated_at', 'o.id')} ORDER BY o.updated_at DESC, o.id DESC LIMIT ?`)
        .all(orgId, ...filterParams, cursor[0], cursor[0], cursor[1], limit + 1);
    const parsed = rows.map(row => ({
      ...row,
      fit_checks: row.fit_checks ? JSON.parse(row.fit_checks) : [],
    }));
    return { status: 200, body: { ...pageRows(parsed, limit, row => [row.updated_at, row.id]), total } };
  }
  if (path === '/opportunities/options' && method === 'GET') {
    return { status: 200, body: { items: db.prepare(`SELECT o.id,o.qualification_status,o.sales_stage,a.brand_name
      FROM opportunities o JOIN accounts a ON a.id=o.account_id AND a.organization_id=o.organization_id
      WHERE o.organization_id=? ORDER BY o.updated_at DESC, o.id DESC`).all(orgId) } };
  }
  if (path === '/opportunities' && method === 'POST') {
    const scope = getEnabledScope();
    const accountId = text(body.account_id, 'account_id', 100), reason = text(body.reason, 'reason', 2000);
    const productCategory = body.product_category ? text(body.product_category, 'product_category', 40) : scope.product_categories[0];
    requireValue(scope.product_categories.includes(productCategory), '所选品类尚未开通。', 'product_category');
    const estQty = body.estimated_order_quantity === undefined || body.estimated_order_quantity === null || body.estimated_order_quantity === ''
      ? null
      : Number(body.estimated_order_quantity);
    requireValue(estQty === null || (Number.isSafeInteger(estQty) && estQty > 0), '预估采购量必须为正整数。', 'estimated_order_quantity');
    return transaction(db, () => {
      requireValue(db.prepare('SELECT id FROM accounts WHERE id=? AND organization_id=?').get(accountId, orgId), '品牌不存在。', 'account_id', 404, 'NOT_FOUND');
      const existing = db.prepare('SELECT id FROM opportunities WHERE account_id=? AND organization_id=? AND product_category=?').get(accountId, orgId, productCategory);
      if (existing) return { status: 200, body: { ...opportunity(db, existing.id, orgId), reused: true } };
      const assignedTo = resolveAssignee(db, orgId, body.assigned_to, '');
      const id = randomUUID(), now = new Date().toISOString();
      const fit = evaluateOpportunityFit(db, { account_id: accountId, product_category: productCategory, estimated_order_quantity: estQty }, orgId);
      db.prepare(`INSERT INTO opportunities
        (id,organization_id,account_id,product_category,fit_status,fit_checks,assigned_to,cohort_assignee,estimated_order_quantity,reason,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, orgId, accountId, productCategory, fit.fit_status, JSON.stringify(fit.fit_checks), assignedTo, assignedTo, estQty, reason, now, now);
      history(db, id, 'CREATED_MANUALLY', reason, {}, ctx);
      return { status: 201, body: opportunity(db, id, orgId) };
    });
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)$/)) && method === 'GET') return { status: 200, body: detail(db, match[1], orgId) };
  if ((match = path.match(/^\/opportunities\/([^/]+)\/fit$/)) && method === 'PATCH') {
    return transaction(db, () => {
      const item = opportunity(db, match[1], orgId); version(item, body);
      const estQty = body.estimated_order_quantity === undefined
        ? item.estimated_order_quantity
        : (body.estimated_order_quantity === null || body.estimated_order_quantity === '' ? null : Number(body.estimated_order_quantity));
      requireValue(estQty === null || (Number.isSafeInteger(estQty) && estQty > 0), '预估采购量必须为正整数。', 'estimated_order_quantity');
      const fit = evaluateOpportunityFit(db, { ...item, estimated_order_quantity: estQty }, orgId);
      db.prepare('UPDATE opportunities SET estimated_order_quantity=?, fit_status=?, fit_checks=?, version=version+1, updated_at=? WHERE id=? AND organization_id=?')
        .run(estQty, fit.fit_status, JSON.stringify(fit.fit_checks), new Date().toISOString(), item.id, orgId);
      history(db, item.id, 'FIT_REASSESSED', body.reason ? text(body.reason, 'reason', 500) : '更新需求数量并重估工厂适配状态', {
        estimated_order_quantity: estQty, fit_status: fit.fit_status,
      }, ctx);
      return { status: 200, body: opportunity(db, item.id, orgId) };
    });
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)\/evaluate-fit$/)) && method === 'POST') {
    return transaction(db, () => {
      const item = opportunity(db, match[1], orgId);
      const fit = evaluateOpportunityFit(db, item, orgId);
      db.prepare('UPDATE opportunities SET fit_status=?, fit_checks=?, updated_at=? WHERE id=? AND organization_id=?')
        .run(fit.fit_status, JSON.stringify(fit.fit_checks), new Date().toISOString(), item.id, orgId);
      return { status: 200, body: opportunity(db, item.id, orgId) };
    });
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)\/assign$/)) && method === 'PATCH') {
    return transaction(db, () => {
      const item = opportunity(db, match[1], orgId); version(item, body);
      const assignee = resolveAssignee(db, orgId, body.assigned_to, '');
      const hasDecision = db.prepare("SELECT 1 FROM opportunity_history WHERE organization_id=? AND opportunity_id=? AND action IN ('QUALIFY','REJECT') LIMIT 1").get(orgId, item.id);
      const nextCohort = item.cohort_assignee
        ? item.cohort_assignee
        : (assignee || (!hasDecision ? '' : item.cohort_assignee));
      db.prepare('UPDATE opportunities SET assigned_to=?, cohort_assignee=?, version=version+1, updated_at=? WHERE id=? AND organization_id=?')
        .run(assignee, nextCohort, new Date().toISOString(), item.id, orgId);
      history(db, item.id, 'ASSIGNED', assignee ? `指派跟进负责人：${assignee}` : '已清除跟进负责人指派', { assigned_to: assignee, previous: item.assigned_to }, ctx);
      return { status: 200, body: opportunity(db, item.id, orgId) };
    });
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)\/history$/)) && method === 'GET') {
    const item = opportunity(db, match[1], orgId);
    const { limit, cursor } = pageParams(query);
    const total = db.prepare('SELECT count(*) AS n FROM opportunity_history WHERE organization_id=? AND opportunity_id=?').get(orgId, item.id).n;
    const base = 'SELECT id, action, reason, snapshot, created_at FROM opportunity_history WHERE organization_id=? AND opportunity_id=?';
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY created_at DESC, id DESC LIMIT ?`).all(orgId, item.id, limit + 1)
      : db.prepare(`${base} AND ${olderThan('created_at', 'id')} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(orgId, item.id, cursor[0], cursor[0], cursor[1], limit + 1);
    return {
      status: 200,
      body: {
        ...pageRows(rows.map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) })), limit, r => [r.created_at, r.id]),
        total,
      },
    };
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)\/transitions$/)) && method === 'POST') {
    return transaction(db, () => {
      const item = opportunity(db, match[1], orgId); version(item, body);
      const transition = Object.hasOwn(transitions, body.action) ? transitions[body.action] : null;
      requireValue(transition && transition.from.includes(item.qualification_status), '当前状态不允许这个操作。', undefined, 409, 'INVALID_TRANSITION');
      if (body.action === 'REOPEN') {
        requireValue(!ctx || ctx.role === 'OWNER', '仅工作区负责人（OWNER）可执行重新激活（REOPEN）操作。', undefined, 403, 'FORBIDDEN');
      }
      if (body.action === 'START_REVIEW' && item.qualification_status === 'NEEDS_EVIDENCE') {
        const lastReq = db.prepare(`SELECT created_at, id FROM audit_logs
          WHERE organization_id=? AND object_id=? AND action='REQUEST_EVIDENCE'
          ORDER BY created_at DESC, id DESC LIMIT 1`).get(orgId, item.id);
        const minCreatedAt = lastReq?.created_at ?? '';
        const fresh = db.prepare(`SELECT e.id FROM evidence e
          WHERE e.organization_id=? AND e.account_id=? AND e.verification_status='VERIFIED' AND COALESCE(e.availability_status,'AVAILABLE')<>'EXPIRED'
            AND (e.checked_at > ? OR EXISTS (
              SELECT 1 FROM audit_logs al
              WHERE al.organization_id=e.organization_id AND al.object_id=e.id
                AND al.action='EVIDENCE_VERIFIED_MANUALLY' AND al.created_at > ?
            ))
          LIMIT 1`).get(orgId, item.account_id, item.updated_at, minCreatedAt);
        requireValue(fresh, '请先补充或重新核验所缺证据，再恢复审核。');
      }
      const reason = text(body.reason, 'reason', 2000);
      let pending = item.pending_info, factoryVersion = item.factory_version;
      const refs = [];
      if (body.action === 'QUALIFY') {
        const factory = profile(db, orgId);
        requireValue(
          factory.status === 'ACTIVE' && factory.supported_products.includes(item.product_category) && factory.target_markets.length > 0,
          '工厂档案尚未启用或能力不匹配，请先核对。',
        );
        const liveFit = evaluateOpportunityFit(db, item, orgId);
        requireValue(liveFit.fit_status !== 'NOT_FIT', '该商机存在硬性适配或禁入市场冲突（NOT_FIT），不能审核合格。', 'no_known_conflict');
        requireValue(body.no_known_conflict === true, '已知存在硬约束冲突的商机不能审核合格。', 'no_known_conflict');
        pending = text(body.pending_info, 'pending_info', 2000);
        for (const role of ['PRODUCT', 'MARKET', 'REASON']) {
          const id = text(body[`${role.toLowerCase()}_evidence_id`], `${role.toLowerCase()}_evidence_id`, 100);
          const source = evidence(db, id, orgId);
          requireValue(source.account_id === item.account_id && source.verification_status === 'VERIFIED' && source.availability_status !== 'EXPIRED', '请选择本品牌已核验且未失效的证据。', `${role.toLowerCase()}_evidence_id`);
          if (source.product_id) {
            const product = db.prepare('SELECT product_category,status FROM account_products WHERE id=? AND account_id=? AND organization_id=?').get(source.product_id, item.account_id, orgId);
            requireValue(product?.status === 'ACTIVE' && product.product_category === item.product_category, '所选产品证据不属于当前商机品类或产品已归档。', `${role.toLowerCase()}_evidence_id`);
          }
          if (role === 'MARKET') requireValue(source.checked_at && Date.now() - Date.parse(source.checked_at) <= 7 * 86400000, '目标市场在售证据已超过 7 天，请重新核验。', 'market_evidence_id');
          refs.push({ role, id, version: source.version });
        }
        requireValue(body.facts_confirmed === true, '请确认所选证据分别支持品类、目标市场在售及开发理由。', 'facts_confirmed');
        db.prepare('DELETE FROM opportunity_evidence WHERE opportunity_id=? AND organization_id=?').run(item.id, orgId);
        for (const ref of refs) db.prepare('INSERT INTO opportunity_evidence VALUES (?,?,?,?,?)').run(orgId, item.id, ref.id, ref.role, ref.version);
        factoryVersion = factory.version;
      }
      const nextCohort = ['QUALIFY', 'REJECT'].includes(body.action) && !item.cohort_assignee && item.assigned_to
        ? item.assigned_to
        : item.cohort_assignee;
      db.prepare('UPDATE opportunities SET qualification_status=?, reason=?, pending_info=?, factory_version=?, cohort_assignee=?, version=version+1, updated_at=? WHERE id=? AND organization_id=?')
        .run(transition.to, body.action === 'QUALIFY' ? reason : item.reason, pending, factoryVersion, nextCohort, new Date().toISOString(), item.id, orgId);
      const fit = evaluateOpportunityFit(db, item, orgId);
      db.prepare('UPDATE opportunities SET fit_status=?, fit_checks=? WHERE id=? AND organization_id=?')
        .run(fit.fit_status, JSON.stringify(fit.fit_checks), item.id, orgId);
      history(db, item.id, body.action, reason, { from: item.qualification_status, to: transition.to, references: refs, factory_version: factoryVersion, pending_info: pending }, ctx);
      reconcileApprovals(db, { opportunityId: item.id }, ctx);
      return { status: 200, body: opportunity(db, item.id, orgId) };
    });
  }
  if (path === '/contacts' && method === 'POST') {
    const accountId = text(body.account_id, 'account_id', 100);
    const name = text(body.full_name, 'full_name', 100), title = text(body.job_title ?? '', 'job_title', 100, false);
    const department = text(body.department ?? '', 'department', 80, false);
    const linkedinUrl = optionalPublicUrl(body.linkedin_url ?? '', 'linkedin_url');
    const roleRelevance = text(body.role_relevance ?? 'UNKNOWN', 'role_relevance', 32, false).toUpperCase() || 'UNKNOWN';
    requireValue(ROLE_RELEVANCE.includes(roleRelevance), '请选择有效的职能相关度。', 'role_relevance');
    const email = text(body.email, 'email', 254).toLowerCase();
    requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), '请填写有效邮箱；格式校验不代表邮箱可投递。', 'email');
    const source = publicUrl(body.source_url, 'source_url');
    return transaction(db, () => {
      requireValue(db.prepare('SELECT id FROM accounts WHERE id=? AND organization_id=?').get(accountId, orgId), '品牌不存在。', 'account_id', 404, 'NOT_FOUND');
      const existing = db.prepare('SELECT id FROM contacts WHERE account_id=? AND organization_id=? AND email=?').get(accountId, orgId, email);
      if (existing) return { status: 200, body: { ...contact(db, existing.id, orgId), reused: true } };
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id,organization_id,account_id,full_name,job_title,email,source_url,department,linkedin_url,role_relevance,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, orgId, accountId, name, title, email, source, department, linkedinUrl, roleRelevance, new Date().toISOString());
      audit(db, 'CONTACT_RECORDED', id, { role_relevance: roleRelevance, department }, ctx);
      return { status: 201, body: contact(db, id, orgId) };
    });
  }
  if ((match = path.match(/^\/contacts\/([^/]+)\/(verify|suppress|stale)$/)) && method === 'POST') {
    return transaction(db, () => {
      const [, id, action] = match, row = contact(db, id, orgId); version(row, body);
      const reason = text(body.reason, 'reason', 1000);
      if (action === 'verify') {
        requireValue(!row.suppression_reason, '该联系渠道已禁止联系，不能重新核验为可用。');
        requireValue(body.confirmed === true, '请确认已核对公开来源中的身份、职能和渠道。', 'confirmed');
      }
      if (action === 'suppress') db.prepare('INSERT INTO contact_suppressions VALUES (?,?,?,?) ON CONFLICT(organization_id,email) DO NOTHING').run(orgId, row.email, reason, new Date().toISOString());
      db.prepare('UPDATE contacts SET verification_status=?, version=version+1, checked_at=? WHERE id=? AND organization_id=?')
        .run(action === 'verify' ? 'VERIFIED' : action === 'stale' ? 'STALE' : row.verification_status, new Date().toISOString(), id, orgId);
      audit(db, `CONTACT_${action.toUpperCase()}`, id, { reason, previous_status: row.verification_status, previous_version: row.version }, ctx);
      reconcileApprovals(db, { accountId: row.account_id }, ctx);
      return { status: 200, body: contact(db, id, orgId) };
    });
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)\/activities$/)) && method === 'GET') {
    const item = opportunity(db, match[1], orgId);
    const { limit, cursor } = pageParams(query);
    const total = db.prepare('SELECT count(*) AS n FROM sales_activities WHERE organization_id=? AND opportunity_id=?').get(orgId, item.id).n;
    const base = `SELECT s.*, COALESCE(json_extract(s.contact_snapshot,'$.full_name'), c.full_name) AS full_name,
      COALESCE(json_extract(s.contact_snapshot,'$.email'), c.email) AS email
      FROM sales_activities s LEFT JOIN contacts c ON c.id=s.contact_id AND c.organization_id=s.organization_id
      WHERE s.organization_id=? AND s.opportunity_id=?`;
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY s.occurred_at DESC, s.id DESC LIMIT ?`).all(orgId, item.id, limit + 1)
      : db.prepare(`${base} AND ${olderThan('s.occurred_at', 's.id')} ORDER BY s.occurred_at DESC, s.id DESC LIMIT ?`)
        .all(orgId, item.id, cursor[0], cursor[0], cursor[1], limit + 1);
    return { status: 200, body: { ...pageRows(rows, limit, r => [r.occurred_at, r.id]), total } };
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
      const item = opportunity(db, id, orgId);
      const replay = db.prepare('SELECT id, opportunity_id, contact_id, activity_type, occurred_at, notes, reply_sentiment, amount_cents, currency, created_at, draft_version_id, request_hash FROM sales_activities WHERE organization_id=? AND idempotency_key=?').get(orgId, key);
      if (replay) {
        requireValue(replay.request_hash === hash, '相同提交标识对应不同内容，请重新打开记录表单。', undefined, 409, 'IDEMPOTENCY_CONFLICT');
        const { request_hash: _ignoredHash, ...cleanReplay } = replay;
        return { status: 200, body: { ...cleanReplay, sales_stage: item.sales_stage, verification_method: 'USER_REPORTED', replayed: true } };
      }
      version(item, body);
      const person = contactId ? contact(db, contactId, orgId) : null;
      requireValue(!person || person.account_id === item.account_id, '联系人必须属于当前商机品牌。', 'contact_id');
      if (['DEAL_WON', 'DEAL_LOST'].includes(type)) requireValue(!['WON', 'LOST'].includes(item.sales_stage), '已存在成交或丢单结论，请先作废错误活动再更正。', undefined, 409, 'INVALID_TRANSITION');
      if (draftVersionId) {
        const draft = db.prepare('SELECT v.contact_id, d.opportunity_id FROM draft_versions v JOIN drafts d ON d.id=v.draft_id AND d.organization_id=v.organization_id WHERE v.id=? AND v.organization_id=?').get(draftVersionId, orgId);
        requireValue(type === 'EMAIL_SENT' && draft?.opportunity_id === id && draft.contact_id === contactId, '发送记录引用的草稿必须属于此商机和联系人。', 'draft_version_id');
      }
      const activityId = randomUUID();
      db.prepare(`INSERT INTO sales_activities (id,organization_id,opportunity_id,contact_id,activity_type,occurred_at,notes,reply_sentiment,amount_cents,currency,idempotency_key,request_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(activityId, orgId, id, contactId, type, occurred.toISOString(), notes, sentiment, cents, currency, key, hash, new Date().toISOString());
      if (draftVersionId) db.prepare('UPDATE sales_activities SET draft_version_id=? WHERE id=? AND organization_id=?').run(draftVersionId, activityId, orgId);
      if (person) db.prepare('UPDATE sales_activities SET contact_snapshot=? WHERE id=? AND organization_id=?')
        .run(JSON.stringify({ full_name: person.full_name, job_title: person.job_title, email: person.email, source_url: person.source_url, version: person.version, provenance: 'AT_RECORDING' }), activityId, orgId);
      const stage = recomputeStage(db, id, orgId);
      reconcileApprovals(db, { opportunityId: id }, ctx);
      history(db, id, 'ACTIVITY_RECORDED', notes || type, { activity_id: activityId, activity_type: type, occurred_at: occurred.toISOString(), sales_stage: stage, verification_method: 'USER_REPORTED' }, ctx);
      return { status: 201, body: { id: activityId, sales_stage: stage, verification_method: 'USER_REPORTED', warning: person?.suppression_reason ? '该渠道已禁止联系，本次仅补记实际历史，不恢复可联系状态。' : null } };
    });
  }
  if ((match = path.match(/^\/opportunities\/([^/]+)\/activities\/([^/]+)\/void$/)) && method === 'POST') {
    requireValue(!ctx || ctx.role === 'OWNER', '仅工作区负责人（OWNER）可作废销售活动记录。', undefined, 403, 'FORBIDDEN');
    return transaction(db, () => {
      const item = opportunity(db, match[1], orgId); version(item, body);
      const activity = db.prepare('SELECT id, voided_at FROM sales_activities WHERE id=? AND opportunity_id=? AND organization_id=?').get(match[2], item.id, orgId);
      requireValue(activity, '活动不存在。', undefined, 404, 'NOT_FOUND');
      requireValue(!activity.voided_at, '这条活动已作废。', undefined, 409, 'INVALID_TRANSITION');
      const reason = text(body.reason, 'reason', 1000);
      db.prepare('UPDATE sales_activities SET voided_at=?,void_reason=? WHERE id=? AND organization_id=?').run(new Date().toISOString(), reason, activity.id, orgId);
      const stage = recomputeStage(db, item.id, orgId);
      history(db, item.id, 'ACTIVITY_VOIDED', reason, { activity_id: activity.id, sales_stage: stage }, ctx);
      return { status: 200, body: { sales_stage: stage } };
    });
  }
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
