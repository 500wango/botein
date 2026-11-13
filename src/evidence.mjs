import { createHash, randomUUID } from 'node:crypto';
import { ORG, audit } from './store.mjs';
import { requireValue, text, publicUrl } from './validation.mjs';

// Caller owns the transaction; UI and CSV use the same validation and deduplication.
export function addEvidence(db, body) {
  const accountId = text(body.account_id, 'account_id', 100);
  const productId = body.product_id ? text(body.product_id, 'product_id', 100) : null;
  const source = publicUrl(body.source_url, 'source_url', true);
  const raw = text(body.raw_text, 'raw_text', 20000);
  let published = null;
  if (body.published_at) {
    requireValue(typeof body.published_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.published_at), '请选择有效日期。', 'published_at');
    const date = new Date(body.published_at);
    requireValue(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === body.published_at && date <= new Date(), '发布时间无效或在未来。', 'published_at');
    published = date.toISOString();
  }
  let observed = new Date().toISOString();
  if (body.observed_at) {
    requireValue(typeof body.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(body.observed_at), '观察时间须为 UTC ISO 时间，例如 2026-11-12T08:00:00Z。', 'observed_at');
    const value = new Date(body.observed_at);
    requireValue(Number.isFinite(value.getTime()) && value.toISOString().slice(0,19) === body.observed_at.slice(0,19) && value <= new Date(), '观察时间无效或在未来。', 'observed_at');
    observed = value.toISOString();
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([accountId, source, raw, published])).digest('hex');

  requireValue(db.prepare('SELECT id FROM accounts WHERE id = ? AND organization_id = ?').get(accountId, ORG), '品牌不存在。', 'account_id', 404, 'NOT_FOUND');
  const selectedProduct = productId ? db.prepare('SELECT * FROM account_products WHERE id=? AND account_id=? AND organization_id=?').get(productId, accountId, ORG) : null;
  requireValue(!productId || selectedProduct, '产品不属于当前品牌或不存在。', 'product_id', 404, 'NOT_FOUND');
  requireValue(!selectedProduct || selectedProduct.status === 'ACTIVE', '已归档产品不接受新证据。', 'product_id');
  const existing = db.prepare('SELECT id, verification_status, product_id, purged_at FROM evidence WHERE organization_id = ? AND fingerprint = ?').get(ORG, fingerprint);
  if (existing) {
    requireValue(existing.product_id === productId, '相同原文已存在但产品归属不同，请在现有证据上修订关联，避免重复计数。', 'product_id', 409, 'EVIDENCE_PRODUCT_CONFLICT');
    return { id: existing.id, duplicate: true, purged: Boolean(existing.purged_at), verification_status: existing.verification_status };
  }
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO evidence (id,organization_id,account_id,source_url,raw_text,published_at,observed_at,created_at,fingerprint) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, ORG, accountId, source, raw, published, observed, now, fingerprint);
  if (selectedProduct) db.prepare('UPDATE evidence SET product_id=?,product_version=? WHERE id=? AND organization_id=?').run(productId, selectedProduct.version, id, ORG);
  audit(db, 'EVIDENCE_RECORDED', id, { product_id: productId, product_version: selectedProduct?.version ?? null });
  return { id, verification_status: 'UNVERIFIED' };
}
