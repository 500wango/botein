import { randomUUID } from 'node:crypto';
import { PRODUCT_CATEGORIES } from './catalog.mjs';
import { reconcileApprovals } from './drafts.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';
import { reassessQualified, refreshAccountOpportunitiesFit } from './sales.mjs';
import { audit, requestContext, transaction } from './store.mjs';
import { AppError, publicUrl, requireValue, text } from './validation.mjs';

function account(db, id, orgId) {
  requireValue(db.prepare('SELECT id FROM accounts WHERE organization_id=? AND id=?').get(orgId, id), '品牌不存在。', undefined, 404, 'NOT_FOUND');
}
function product(db, id, accountId, orgId) {
  const row = db.prepare('SELECT * FROM account_products WHERE organization_id=? AND id=? AND account_id=?').get(orgId, id, accountId);
  requireValue(row, '该产品不属于当前品牌或不存在。', 'product_id', 404, 'NOT_FOUND'); return row;
}
function input(body) {
  const originalUrl = text(body.product_url, 'product_url', 2000), normalized = publicUrl(originalUrl, 'product_url');
  const allowedCats = [...Object.keys(PRODUCT_CATEGORIES), 'DISHWASHER_TABLETS', 'OTHER', 'UNKNOWN'];
  requireValue(allowedCats.includes(body.product_category), '请选择品类。', 'product_category');
  requireValue(['ACTIVE', 'ARCHIVED'].includes(body.status ?? 'ACTIVE'), '产品状态无效。', 'status');
  const sku = text(body.external_sku ?? '', 'external_sku', 120, false);
  const marketplace = text(body.marketplace ?? '', 'marketplace', 100, false).normalize('NFKC').toLowerCase();
  requireValue(!sku || marketplace, '填写 SKU 时请注明标识所属平台或官网。', 'marketplace');
  return { product_name: text(body.product_name, 'product_name', 200), product_category: body.product_category,
    product_url: originalUrl, normalized_url: normalized, external_sku: sku, marketplace,
    packaging_type: text(body.packaging_type ?? '', 'packaging_type', 300, false),
    notes: text(body.notes ?? '', 'notes', 2000, false), status: body.status ?? 'ACTIVE' };
}
function matches(db, accountId, data, orgId, exclude = '') {
  return db.prepare(`SELECT * FROM account_products WHERE organization_id=? AND account_id=? AND id<>?
    AND (normalized_url=? OR (?<>'' AND external_sku=? AND marketplace=?))`)
    .all(orgId, accountId, exclude, data.normalized_url, data.external_sku, data.external_sku, data.marketplace);
}
function resetEvidence(db, row, reason, ctx, productId = row.product_id, productVersion = row.product_version) {
  const { orgId } = requestContext(ctx);
  // Raw text and prior verification audit are preserved; changed attribution needs fresh confirmation.
  db.prepare(`UPDATE evidence SET product_id=?,product_version=?,version=version+1,
    verification_status=CASE WHEN verification_status='INVALIDATED' THEN 'INVALIDATED' ELSE 'UNVERIFIED' END,
    checked_at=NULL,verification_note=? WHERE organization_id=? AND id=?`)
    .run(productId, productVersion, reason, orgId, row.id);
  audit(db, 'EVIDENCE_PRODUCT_CHANGED', row.id, { before: { product_id: row.product_id, product_version: row.product_version, verification_status: row.verification_status, version: row.version }, after: { product_id: productId, product_version: productVersion }, reason }, ctx);
  reassessQualified(db, reason, row.id, ctx);
}
export function productsApi(db, path, method, body, query, ctx = null) {
  const { orgId } = requestContext(ctx);
  let match;
  if ((match = path.match(/^\/accounts\/([^/]+)\/products(?:\/([^/]+))?$/))) {
    const [, accountId, id] = match; account(db, accountId, orgId);
    if (method === 'GET' && id === 'options') {
      return { status: 200, body: { items: db.prepare(`SELECT id,product_name,product_category,external_sku,marketplace,status,version
        FROM account_products WHERE organization_id=? AND account_id=? ORDER BY created_at DESC,id DESC`).all(orgId, accountId) } };
    }
    if (method === 'GET' && !id) {
      const { limit, cursor } = pageParams(query);
      const total = db.prepare('SELECT count(*) AS n FROM account_products WHERE organization_id=? AND account_id=?')
        .get(orgId, accountId).n;
      const base = `SELECT p.*,
        (SELECT count(*) FROM evidence e WHERE e.product_id=p.id AND e.organization_id=p.organization_id) AS evidence_count
        FROM account_products p WHERE p.organization_id=? AND p.account_id=?`;
      const rows = cursor === null
        ? db.prepare(`${base} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).all(orgId, accountId, limit + 1)
        : db.prepare(`${base} AND ${olderThan('p.created_at', 'p.id')} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
          .all(orgId, accountId, cursor[0], cursor[0], cursor[1], limit + 1);
      return { status: 200, body: { ...pageRows(rows, limit, row => [row.created_at, row.id]), total } };
    }
    if (method === 'GET' && id) {
      const row = product(db, id, accountId, orgId);
      return { status: 200, body: { ...row, history: db.prepare("SELECT action,details,created_at FROM audit_logs WHERE organization_id=? AND object_id=? AND action IN ('PRODUCT_CREATED','PRODUCT_UPDATED') ORDER BY created_at DESC,rowid DESC").all(orgId, id).map(r => ({ ...r, details: JSON.parse(r.details) })) } };
    }
    if ((method === 'POST' && !id) || (method === 'PATCH' && id)) return transaction(db, () => {
      const data = input(body), existing = id ? product(db, id, accountId, orgId) : null;
      if (existing) {
        requireValue(existing.version === body.expected_version, '产品已更新，请重新打开。', undefined, 409, 'VERSION_CONFLICT');
        requireValue(body.account_id === undefined || body.account_id === accountId, '已保存产品不能转移到其他品牌。', 'account_id');
      }
      const duplicates = matches(db, accountId, data, orgId, id);
      if (!existing && duplicates.length === 1) {
        const same = duplicates[0];
        // Replays must not silently merge conflicting SKU identities or overwrite product attributes.
        const equal = Object.keys(data).every(k => same[k] === data[k]);
        requireValue(equal, '产品链接或 SKU 已存在但资料不同，请打开现有产品编辑。', 'product_url', 409, 'PRODUCT_IDENTITY_CONFLICT');
        return { status: 200, body: { ...same, reused: true } };
      }
      requireValue(duplicates.length === 0, '产品链接或同平台 SKU 与其他记录冲突，请核对。', 'product_url', 409, 'PRODUCT_IDENTITY_CONFLICT');
      const now = new Date().toISOString(), productId = id || randomUUID();
      if (!existing) {
        db.prepare(`INSERT INTO account_products (id,organization_id,account_id,product_name,product_category,product_url,normalized_url,external_sku,marketplace,packaging_type,notes,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(productId, orgId, accountId, ...Object.values(data), now, now);
        refreshAccountOpportunitiesFit(db, accountId, orgId);
        audit(db, 'PRODUCT_CREATED', productId, { data, account_id: accountId }, ctx);
      } else {
        const changed = Object.keys(data).filter(k => data[k] !== existing[k]);
        if (!changed.length) return { status: 200, body: { ...existing, unchanged: true } };
        const reason = text(body.reason, 'reason', 1000);
        db.prepare(`UPDATE account_products SET product_name=?,product_category=?,product_url=?,normalized_url=?,external_sku=?,marketplace=?,packaging_type=?,notes=?,status=?,version=version+1,updated_at=? WHERE id=? AND organization_id=?`)
          .run(...Object.values(data), now, productId, orgId);
        if (changed.some(k => k !== 'notes')) {
          const affected = db.prepare('SELECT * FROM evidence WHERE organization_id=? AND product_id=?').all(orgId, productId);
          for (const row of affected) resetEvidence(db, row, `产品资料已修改，需核对关联：${reason}`, ctx);
          reconcileApprovals(db, { accountId }, ctx);
        }
        refreshAccountOpportunitiesFit(db, accountId, orgId);
        audit(db, 'PRODUCT_UPDATED', productId, { reason, before: existing, after: { ...data, version: existing.version + 1 }, changed }, ctx);
      }
      return { status: existing ? 200 : 201, body: product(db, productId, accountId, orgId) };
    });
  }
  if ((match = path.match(/^\/evidence\/([^/]+)\/product$/)) && method === 'PATCH') return transaction(db, () => {
    const row = db.prepare('SELECT * FROM evidence WHERE organization_id=? AND id=?').get(orgId, match[1]);
    requireValue(row, '证据不存在。', undefined, 404, 'NOT_FOUND');
    requireValue(row.version === body.expected_version, '证据已更新，请重新打开。', undefined, 409, 'VERSION_CONFLICT');
    const productId = body.product_id ? text(body.product_id, 'product_id', 100) : null;
    const selected = productId ? product(db, productId, row.account_id, orgId) : null;
    requireValue(!selected || selected.status === 'ACTIVE', '已归档产品不接受新的证据关联。', 'product_id');
    if (row.product_id === productId) return { status: 200, body: { ...row, unchanged: true } };
    const reason = text(body.reason, 'reason', 1000);
    resetEvidence(db, row, `人工修订产品归属：${reason}`, ctx, productId, selected?.version ?? null);
    refreshAccountOpportunitiesFit(db, row.account_id, orgId);
    reconcileApprovals(db, { accountId: row.account_id }, ctx);
    return { status: 200, body: db.prepare('SELECT * FROM evidence WHERE organization_id=? AND id=?').get(orgId, row.id) };
  });
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
