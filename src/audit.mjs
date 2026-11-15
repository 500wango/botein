import { requestContext } from './store.mjs';
import { AppError, requireValue } from './validation.mjs';

const MAX_LIMIT = 100;

function decodeCursor(value) {
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new AppError(422, 'INVALID_CURSOR', '分页标识无效。', 'cursor');
  }
  if (/^\d{1,15}$/.test(decoded)) return { rowid: Number(decoded) };
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.created_at === 'string' && typeof parsed.id === 'string' && parsed.created_at && parsed.id) {
      return { created_at: parsed.created_at, id: parsed.id };
    }
  } catch { /* throw below */ }
  throw new AppError(422, 'INVALID_CURSOR', '分页标识无效。', 'cursor');
}

// Newest first, cursor on composite (created_at, id) so SQLite and PostgreSQL behave identically.
export function auditApi(db, path, method, query, ctx = null) {
  const { orgId } = requestContext(ctx);
  if (path !== '/audit-logs' || method !== 'GET') throw new AppError(404, 'NOT_FOUND', '接口不存在。');
  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT, '每页数量为 1–100 的整数。', 'limit');
  const cursor = query.get('cursor');
  const before = cursor ? decodeCursor(cursor) : null;
  let rows;
  if (!before) {
    rows = db.prepare(`SELECT id,action,object_id,details,created_at FROM audit_logs
      WHERE organization_id=? ORDER BY created_at DESC, id DESC LIMIT ?`).all(orgId, limit + 1);
  } else if ('rowid' in before) {
    rows = db.prepare(`SELECT id,action,object_id,details,created_at FROM audit_logs
      WHERE organization_id=? AND rowid<? ORDER BY created_at DESC, id DESC LIMIT ?`).all(orgId, before.rowid, limit + 1);
  } else {
    rows = db.prepare(`SELECT id,action,object_id,details,created_at FROM audit_logs
      WHERE organization_id=? AND (created_at<? OR (created_at=? AND id<?))
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(orgId, before.created_at, before.created_at, before.id, limit + 1);
  }
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    status: 200, body: {
      items: page.map(row => ({
        id: row.id, action: row.action, object_id: row.object_id,
        details: JSON.parse(row.details), created_at: row.created_at,
      })),
      next_cursor: hasMore && last
        ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString('base64url')
        : null,
      limit,
    },
  };
}
