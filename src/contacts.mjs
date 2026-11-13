import { ORG, audit, transaction } from './store.mjs';
import { requireValue, text, publicUrl, AppError } from './validation.mjs';
import { reconcileApprovals } from './drafts.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';

export function contactsApi(db, path, method, body, query) {
  if (path === '/contact-suppressions' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const total = db.prepare('SELECT count(*) AS n FROM contact_suppressions WHERE organization_id=?').get(ORG).n;
    const base = `SELECT s.email,s.reason,s.created_at,
      (SELECT count(*) FROM contacts c WHERE c.organization_id=s.organization_id AND c.email=s.email) AS contact_count
      FROM contact_suppressions s WHERE s.organization_id=?`;
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY s.created_at DESC, s.email DESC LIMIT ?`).all(ORG, limit + 1)
      : db.prepare(`${base} AND ${olderThan('s.created_at', 's.email')} ORDER BY s.created_at DESC, s.email DESC LIMIT ?`)
        .all(ORG, cursor[0], cursor[0], cursor[1], limit + 1);
    return { status: 200, body: { ...pageRows(rows, limit, row => [row.created_at, row.email]), total } };
  }
  if (path === '/contacts' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const q = String(query.get('q') ?? '').trim().slice(0, 100);
    const term = q.replace(/[\\%_]/g, '\\$&');
    const filter = q ? `AND (c.full_name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR a.brand_name LIKE ? ESCAPE '\\')` : '';
    const filterParams = q ? [`%${term}%`, `%${term}%`, `%${term}%`] : [];
    const total = db.prepare(`SELECT count(*) AS n FROM contacts c
      JOIN accounts a ON a.id=c.account_id AND a.organization_id=c.organization_id
      WHERE c.organization_id=? ${filter}`).get(ORG, ...filterParams).n;
    const base = `SELECT c.*,a.brand_name,s.reason AS suppression_reason
      FROM contacts c JOIN accounts a ON a.id=c.account_id AND a.organization_id=c.organization_id
      LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
      WHERE c.organization_id=? ${filter}`;
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`).all(ORG, ...filterParams, limit + 1)
      : db.prepare(`${base} AND ${olderThan('c.created_at', 'c.id')} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`)
        .all(ORG, ...filterParams, cursor[0], cursor[0], cursor[1], limit + 1);
    return { status: 200, body: { ...pageRows(rows, limit, row => [row.created_at, row.id]), total } };
  }
  const match = path.match(/^\/contacts\/([^/]+)$/);
  if (!match) throw new AppError(404, 'NOT_FOUND', '接口不存在。');
  const get = () => {
    const row = db.prepare(`SELECT c.*,a.brand_name,s.reason AS suppression_reason
      FROM contacts c JOIN accounts a ON a.id=c.account_id AND a.organization_id=c.organization_id
      LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
      WHERE c.id=? AND c.organization_id=?`).get(match[1], ORG);
    requireValue(row, '联系人不存在。', undefined, 404, 'NOT_FOUND'); return row;
  };
  if (method === 'GET') return { status: 200, body: {
    ...get(), history: db.prepare("SELECT action,details,created_at FROM audit_logs WHERE organization_id=? AND object_id=? AND action LIKE 'CONTACT_%' ORDER BY created_at DESC,rowid DESC")
      .all(ORG, match[1]).map(r => ({ ...r, details: JSON.parse(r.details) })),
  } };
  if (method === 'PATCH') return transaction(db, () => {
    const row = get();
    requireValue(row.version === body.expected_version, '联系人已更新，请重新打开。', undefined, 409, 'VERSION_CONFLICT');
    requireValue(body.account_id === undefined || body.account_id === row.account_id, '联系人不能转移品牌，请新增对应品牌联系人。', 'account_id');
    requireValue(body.email === undefined || text(body.email, 'email', 254).toLowerCase() === row.email, '邮箱作为历史联系渠道保留，换邮箱请新增联系人。', 'email');
    const data = { full_name: text(body.full_name, 'full_name', 100), job_title: text(body.job_title ?? '', 'job_title', 100, false), source_url: publicUrl(body.source_url, 'source_url') };
    if (Object.keys(data).every(k => data[k] === row[k])) return { status: 200, body: { ...row, unchanged: true } };
    const reason = text(body.reason, 'reason', 1500);
    db.prepare("UPDATE contacts SET full_name=?,job_title=?,source_url=?,verification_status='STALE',version=version+1,checked_at=NULL WHERE id=? AND organization_id=?")
      .run(data.full_name, data.job_title, data.source_url, row.id, ORG);
    audit(db, 'CONTACT_UPDATED', row.id, { reason, before: { full_name: row.full_name, job_title: row.job_title, source_url: row.source_url, email: row.email, version: row.version }, after: { ...data, email: row.email, version: row.version+1 } });
    reconcileApprovals(db);
    return { status: 200, body: get() };
  });
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
