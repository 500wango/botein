import { reconcileApprovals } from './drafts.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';
import { ORG, audit, requestContext, transaction } from './store.mjs';
import { AppError, optionalPublicUrl, publicUrl, requireValue, text } from './validation.mjs';

const ROLE_RELEVANCE = ['DECISION_MAKER', 'PROCUREMENT', 'OPERATIONS', 'SALES', 'GENERAL', 'UNKNOWN'];

export function contactsApi(db, path, method, body, query, ctx = null) {
  const { orgId } = requestContext(ctx);
  if (path === '/contact-suppressions' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const total = db.prepare('SELECT count(*) AS n FROM contact_suppressions WHERE organization_id=?').get(orgId).n;
    const base = `SELECT s.email,s.reason,s.created_at,
      (SELECT count(*) FROM contacts c WHERE c.organization_id=s.organization_id AND c.email=s.email) AS contact_count
      FROM contact_suppressions s WHERE s.organization_id=?`;
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY s.created_at DESC, s.email DESC LIMIT ?`).all(orgId, limit + 1)
      : db.prepare(`${base} AND ${olderThan('s.created_at', 's.email')} ORDER BY s.created_at DESC, s.email DESC LIMIT ?`)
        .all(orgId, cursor[0], cursor[0], cursor[1], limit + 1);
    return { status: 200, body: { ...pageRows(rows, limit, row => [row.created_at, row.email]), total } };
  }
  if (path === '/contact-suppressions/lift' && method === 'POST') {
    const email = text(body.email, 'email', 254).toLowerCase();
    const reason = text(body.reason, 'reason', 1000);
    requireValue(reason.length >= 5, '请填写至少 5 个字的解除禁联原因。', 'reason');
    requireValue(body.confirmed === true, '请确认客户已明确撤回退订或书面同意恢复联系。', 'confirmed');
    return transaction(db, () => {
      const existing = db.prepare('SELECT * FROM contact_suppressions WHERE organization_id=? AND email=?').get(orgId, email);
      requireValue(existing, '该邮箱不在禁止联系名单中。', 'email', 404, 'NOT_FOUND');
      db.prepare('DELETE FROM contact_suppressions WHERE organization_id=? AND email=?').run(orgId, email);
      // Contacts lifted from suppression must go through fresh verification before reuse.
      db.prepare("UPDATE contacts SET verification_status='STALE', version=version+1, checked_at=NULL WHERE organization_id=? AND email=? AND verification_status='VERIFIED'")
        .run(orgId, email);
      audit(db, 'CONTACT_SUPPRESSION_LIFTED', email, { reason, previous_reason: existing.reason }, ctx);
      reconcileApprovals(db, null, ctx);
      return { status: 200, body: { email, lifted: true } };
    });
  }
  if (path === '/contacts' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const q = String(query.get('q') ?? '').trim().slice(0, 100);
    const term = q.replace(/[\\%_]/g, '\\$&');
    const filter = q ? `AND (c.full_name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR a.brand_name LIKE ? ESCAPE '\\' OR c.department LIKE ? ESCAPE '\\')` : '';
    const filterParams = q ? [`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`] : [];
    const total = db.prepare(`SELECT count(*) AS n FROM contacts c
      JOIN accounts a ON a.id=c.account_id AND a.organization_id=c.organization_id
      WHERE c.organization_id=? ${filter}`).get(orgId, ...filterParams).n;
    const base = `SELECT c.*,a.brand_name,s.reason AS suppression_reason
      FROM contacts c JOIN accounts a ON a.id=c.account_id AND a.organization_id=c.organization_id
      LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
      WHERE c.organization_id=? ${filter}`;
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`).all(orgId, ...filterParams, limit + 1)
      : db.prepare(`${base} AND ${olderThan('c.created_at', 'c.id')} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`)
        .all(orgId, ...filterParams, cursor[0], cursor[0], cursor[1], limit + 1);
    return { status: 200, body: { ...pageRows(rows, limit, row => [row.created_at, row.id]), total } };
  }
  const match = path.match(/^\/contacts\/([^/]+)$/);
  if (!match) throw new AppError(404, 'NOT_FOUND', '接口不存在。');
  const get = () => {
    const row = db.prepare(`SELECT c.*,a.brand_name,s.reason AS suppression_reason
      FROM contacts c JOIN accounts a ON a.id=c.account_id AND a.organization_id=c.organization_id
      LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
      WHERE c.id=? AND c.organization_id=?`).get(match[1], orgId);
    requireValue(row, '联系人不存在。', undefined, 404, 'NOT_FOUND');
    return row;
  };
  if (method === 'GET') return {
    status: 200,
    body: {
      ...get(),
      history: db.prepare("SELECT action,details,created_at FROM audit_logs WHERE organization_id=? AND object_id=? AND action LIKE 'CONTACT_%' ORDER BY created_at DESC,rowid DESC")
        .all(orgId, match[1]).map(r => ({ ...r, details: JSON.parse(r.details) })),
    },
  };
  if (method === 'PATCH') return transaction(db, () => {
    const row = get();
    requireValue(row.version === body.expected_version, '联系人已更新，请重新打开。', undefined, 409, 'VERSION_CONFLICT');
    requireValue(body.account_id === undefined || body.account_id === row.account_id, '联系人不能转移品牌，请新增对应品牌联系人。', 'account_id');
    requireValue(body.email === undefined || text(body.email, 'email', 254).toLowerCase() === row.email, '邮箱作为历史联系渠道保留，换邮箱请新增联系人。', 'email');
    const roleRelevance = body.role_relevance !== undefined
      ? text(body.role_relevance, 'role_relevance', 32).toUpperCase()
      : (row.role_relevance || 'UNKNOWN');
    requireValue(ROLE_RELEVANCE.includes(roleRelevance), '请选择有效的职能相关度。', 'role_relevance');
    const data = {
      full_name: text(body.full_name, 'full_name', 100),
      job_title: text(body.job_title ?? '', 'job_title', 100, false),
      department: body.department !== undefined ? text(body.department, 'department', 80, false) : (row.department ?? ''),
      linkedin_url: body.linkedin_url !== undefined ? optionalPublicUrl(body.linkedin_url, 'linkedin_url') : (row.linkedin_url ?? ''),
      role_relevance: roleRelevance,
      source_url: publicUrl(body.source_url, 'source_url'),
    };
    if (Object.keys(data).every(k => data[k] === (row[k] ?? ''))) return { status: 200, body: { ...row, unchanged: true } };
    const reason = text(body.reason, 'reason', 1500);
    db.prepare(`UPDATE contacts SET full_name=?,job_title=?,department=?,linkedin_url=?,role_relevance=?,source_url=?,
      verification_status='STALE',version=version+1,checked_at=NULL WHERE id=? AND organization_id=?`)
      .run(data.full_name, data.job_title, data.department, data.linkedin_url, data.role_relevance, data.source_url, row.id, orgId);
    audit(db, 'CONTACT_UPDATED', row.id, {
      reason,
      before: { full_name: row.full_name, job_title: row.job_title, department: row.department, linkedin_url: row.linkedin_url, role_relevance: row.role_relevance, source_url: row.source_url, email: row.email, version: row.version },
      after: { ...data, email: row.email, version: row.version + 1 },
    }, ctx);
    reconcileApprovals(db, { accountId: row.account_id }, ctx);
    return { status: 200, body: get() };
  });
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
