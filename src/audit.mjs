import { requestContext } from './store.mjs';
import { AppError, requireValue } from './validation.mjs';

const MAX_LIMIT = 100;

function decodeCursor(value) {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  requireValue(/^\d{1,15}$/.test(decoded), '分页标识无效。', 'cursor', 422, 'INVALID_CURSOR');
  return Number(decoded);
}

// Newest first, cursor on the monotonic audit rowid. No credentials or page text
// are stored in details; the caller only reads the current organization.
export function auditApi(db, path, method, query, ctx = null) {
  const { orgId } = requestContext(ctx);
  if (path !== '/audit-logs' || method !== 'GET') throw new AppError(404, 'NOT_FOUND', '接口不存在。');
  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT, '每页数量为 1–100 的整数。', 'limit');
  const cursor = query.get('cursor');
  const before = cursor ? decodeCursor(cursor) : null;
  const rows = before === null
    ? db.prepare(`SELECT rowid,id,action,object_id,details,created_at FROM audit_logs
        WHERE organization_id=? ORDER BY rowid DESC LIMIT ?`).all(orgId, limit + 1)
    : db.prepare(`SELECT rowid,id,action,object_id,details,created_at FROM audit_logs
        WHERE organization_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?`).all(orgId, before, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    status: 200, body: {
      items: page.map(row => ({
        id: row.id, action: row.action, object_id: row.object_id,
        details: JSON.parse(row.details), created_at: row.created_at,
      })),
      next_cursor: hasMore ? Buffer.from(String(page.at(-1).rowid)).toString('base64url') : null,
      limit,
    },
  };
}
