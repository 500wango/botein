import { AppError, requireValue } from './validation.mjs';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function pageParams(query, defaultLimit = DEFAULT_LIMIT) {
  const rawLimit = query.get('limit');
  const limit = rawLimit === null ? defaultLimit : Number(rawLimit);
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT, '每页数量为 1–100 的整数。', 'limit');
  const rawCursor = query.get('cursor');
  return { limit, cursor: rawCursor === null ? null : decodeCursor(rawCursor) };
}

export function decodeCursor(value) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new AppError(422, 'INVALID_CURSOR', '分页标识无效。', 'cursor'); }
  requireValue(Array.isArray(parsed) && parsed.length === 2 &&
    parsed.every(part => typeof part === 'string' && part.length > 0 && part.length <= 160),
  '分页标识无效。', 'cursor', 422, 'INVALID_CURSOR');
  return parsed;
}

// Rows are fetched with LIMIT + 1 so the caller can decide whether another page exists.
export function pageRows(rows, limit, keyOf) {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page,
    next_cursor: hasMore ? Buffer.from(JSON.stringify(keyOf(page[page.length - 1]))).toString('base64url') : null,
  };
}

// Descending two-column keyset: (timeCol, idCol) < (cursorTime, cursorId).
export function olderThan(timeCol, idCol) {
  return `(${timeCol} < ? OR (${timeCol} = ? AND ${idCol} < ?))`;
}

// Ascending two-column keyset: (timeCol, idCol) > (cursorTime, cursorId).
export function newerThan(timeCol, idCol) {
  return `(${timeCol} > ? OR (${timeCol} = ? AND ${idCol} > ?))`;
}
