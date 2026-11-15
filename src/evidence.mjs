import { createHash, randomUUID } from 'node:crypto';
import { AVAILABILITY_STATUSES, SOURCE_KINDS } from './catalog.mjs';
import { audit, requestContext } from './store.mjs';
import { requireValue, text, publicUrl } from './validation.mjs';

/**
 * Deterministic evidence quality classification based on verification status,
 * source provenance, and recency/verification timestamps.
 */
export function computeEvidenceQuality(evidence) {
  if (!evidence || evidence.verification_status !== 'VERIFIED') {
    return {
      quality: 'UNVERIFIED',
      reason: evidence?.verification_status === 'INVALIDATED'
        ? '证据已标记失效，不能作为有效信号依据。'
        : '尚未人工核验来源与原文，质量按 UNVERIFIED 处理。',
    };
  }
  const availability = evidence.availability_status || 'UNKNOWN';
  if (availability === 'EXPIRED') {
    return {
      quality: 'LOW',
      reason: '来源页面或产品链接已标注失效（EXPIRED），仅作历史背景参考。',
    };
  }
  const sourceKind = evidence.source_kind || 'UNKNOWN';
  const hasTimestamp = Boolean(evidence.published_at || evidence.checked_at);
  if ((sourceKind === 'FIRST_PARTY_BRAND' || sourceKind === 'FIRST_PARTY_PUBLIC') && hasTimestamp) {
    return {
      quality: 'HIGH',
      reason: '已人工核验且来自第一方官方公开出处，包含明确发布或核验时间。',
    };
  }
  return {
    quality: 'MEDIUM',
    reason: sourceKind === 'THIRD_PARTY_REVIEW' || sourceKind === 'MARKETPLACE'
      ? '已人工核验出处与原文（第三方平台或公开评论来源），判为 MEDIUM。'
      : '已人工核验出处、原文与品牌归属（来源性质未标明第一方官方），判为 MEDIUM。',
  };
}

// Caller owns the transaction; UI and CSV use the same validation and deduplication.
export function addEvidence(db, body, ctx = null) {
  const { orgId } = requestContext(ctx);
  const accountId = text(body.account_id, 'account_id', 100);
  const productId = body.product_id ? text(body.product_id, 'product_id', 100) : null;
  const sourceId = body.source_id ? text(body.source_id, 'source_id', 100) : null;
  const source = publicUrl(body.source_url, 'source_url', true);
  const raw = text(body.raw_text, 'raw_text', 20000);
  const sourceKind = text(body.source_kind ?? 'UNKNOWN', 'source_kind', 40);
  requireValue(SOURCE_KINDS.includes(sourceKind), '请选择有效的证据来源性质。', 'source_kind');
  const availabilityStatus = text(
    body.availability_status ?? (source ? 'AVAILABLE' : 'UNKNOWN'),
    'availability_status',
    40,
  );
  requireValue(AVAILABILITY_STATUSES.includes(availabilityStatus), '请选择有效的证据链接可达状态。', 'availability_status');

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
    requireValue(Number.isFinite(value.getTime()) && value.toISOString().slice(0, 19) === body.observed_at.slice(0, 19) && value <= new Date(), '观察时间无效或在未来。', 'observed_at');
    observed = value.toISOString();
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([accountId, source, raw, published])).digest('hex');

  requireValue(db.prepare('SELECT id FROM accounts WHERE id = ? AND organization_id = ?').get(accountId, orgId), '品牌不存在。', 'account_id', 404, 'NOT_FOUND');
  if (sourceId) {
    requireValue(db.prepare('SELECT id FROM sources WHERE id = ? AND organization_id = ?').get(sourceId, orgId), '关联来源不存在。', 'source_id', 404, 'NOT_FOUND');
  }
  const selectedProduct = productId ? db.prepare('SELECT * FROM account_products WHERE id=? AND account_id=? AND organization_id=?').get(productId, accountId, orgId) : null;
  requireValue(!productId || selectedProduct, '产品不属于当前品牌或不存在。', 'product_id', 404, 'NOT_FOUND');
  requireValue(!selectedProduct || selectedProduct.status === 'ACTIVE', '已归档产品不接受新证据。', 'product_id');
  const existing = db.prepare('SELECT id, verification_status, product_id, purged_at, version FROM evidence WHERE organization_id = ? AND fingerprint = ?').get(orgId, fingerprint);
  if (existing) {
    requireValue(existing.product_id === productId, '相同原文已存在但产品归属不同，请在现有证据上修订关联，避免重复计数。', 'product_id', 409, 'EVIDENCE_PRODUCT_CONFLICT');
    return { id: existing.id, duplicate: true, purged: Boolean(existing.purged_at), verification_status: existing.verification_status, version: existing.version };
  }
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare(`INSERT INTO evidence
    (id,organization_id,account_id,source_url,raw_text,published_at,observed_at,created_at,fingerprint,source_id,source_kind,availability_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, orgId, accountId, source, raw, published, observed, now, fingerprint, sourceId, sourceKind, availabilityStatus);
  if (selectedProduct) db.prepare('UPDATE evidence SET product_id=?,product_version=? WHERE id=? AND organization_id=?').run(productId, selectedProduct.version, id, orgId);
  audit(db, 'EVIDENCE_RECORDED', id, { product_id: productId, product_version: selectedProduct?.version ?? null, source_kind: sourceKind, source_id: sourceId }, ctx);
  return { id, version: 1, verification_status: 'UNVERIFIED', source_kind: sourceKind, availability_status: availabilityStatus };
}
