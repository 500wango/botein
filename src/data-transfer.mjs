import { addEvidence } from './evidence.mjs';
import { ORG, audit, requestContext, transaction } from './store.mjs';
import { AppError, parseCsv, requireValue } from './validation.mjs';

export function importEvidence(db, body, ctx = null) {
  const { orgId } = requestContext(ctx);
  const rows = parseCsv(body.csv, ['account_id', 'source_url', 'raw_text', 'observed_at']);
  return transaction(db, () => {
    const results = rows.map(row => {
      try {
        requireValue(row.valid, '列数与表头不一致。', 'csv');
        requireValue(row.data.observed_at.trim(), '请填写原始观察时间，不能用导入时间冒充。', 'observed_at');
        const result = addEvidence(db, row.data, ctx);
        return {
          row: row.row, account_id: row.data.account_id, id: result.id,
          status: result.duplicate ? 'SKIPPED' : 'CREATED', verification_status: result.verification_status,
          reason: result.duplicate ? (result.purged ? '相同原文已按保留政策清除，不能通过重新导入恢复。' : '相同证据已存在，原观察时间及核验状态未覆盖。') : '已保存为待核验。',
        };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return { row: row.row, account_id: row.data.account_id, status: 'FAILED', reason: error.message, field: error.field };
      }
    });
    const counts = Object.fromEntries(['CREATED', 'SKIPPED', 'FAILED'].map(status => [status, results.filter(row => row.status === status).length]));
    audit(db, 'EVIDENCE_CSV_IMPORTED', orgId, { counts, rows: rows.length }, ctx);
    return { results, counts };
  });
}

// Spreadsheet downloads are for review, not byte-identical backups. Preserve DB originals.
function cell(value) {
  let content = String(value ?? '');
  if (/^[\s\u0000-\u001f\u007f]*[=+\-@＝＋－＠]/u.test(content) || /^[\t\r\n]/.test(content)) content = `'${content}`;
  return `"${content.replaceAll('"', '""')}"`;
}

const exports = {
  accounts: {
    columns: ['account_id', 'brand_name', 'website', 'headquarters_country', 'notes', 'created_at'],
    sql: 'SELECT id AS account_id,brand_name,website,headquarters_country,notes,created_at FROM accounts WHERE organization_id=? ORDER BY created_at,id',
  },
  products: {
    columns: ['product_id', 'account_id', 'brand_name', 'product_name', 'product_category', 'product_url', 'external_sku', 'marketplace', 'packaging_type', 'notes', 'status', 'version'],
    sql: `SELECT p.id AS product_id,p.account_id,a.brand_name,p.product_name,p.product_category,p.product_url,p.external_sku,p.marketplace,p.packaging_type,p.notes,p.status,p.version
      FROM account_products p JOIN accounts a ON a.id=p.account_id AND a.organization_id=p.organization_id WHERE p.organization_id=? ORDER BY p.created_at,p.id`,
  },
  evidence: {
    columns: ['evidence_id', 'account_id', 'brand_name', 'product_id', 'source_kind', 'availability_status', 'source_url', 'raw_text', 'published_at', 'observed_at', 'verification_status', 'version', 'verification_note', 'purged_at', 'purge_reason'],
    sql: `SELECT e.id AS evidence_id,e.account_id,a.brand_name,e.product_id,e.source_kind,e.availability_status,e.source_url,e.raw_text,
      substr(e.published_at,1,10) AS published_at,e.observed_at,e.verification_status,e.version,e.verification_note,
      e.purged_at,e.purge_reason
      FROM evidence e JOIN accounts a ON a.id=e.account_id AND a.organization_id=e.organization_id WHERE e.organization_id=? ORDER BY e.created_at,e.id`,
  },
  opportunities: {
    columns: ['opportunity_id', 'account_id', 'brand_name', 'product_category', 'qualification_status', 'sales_stage', 'fit_status', 'assigned_to', 'reason', 'pending_info', 'factory_version', 'version', 'created_at', 'updated_at'],
    sql: `SELECT o.id AS opportunity_id,o.account_id,a.brand_name,o.product_category,o.qualification_status,o.sales_stage,o.fit_status,o.assigned_to,o.reason,o.pending_info,o.factory_version,o.version,o.created_at,o.updated_at
      FROM opportunities o JOIN accounts a ON a.id=o.account_id AND a.organization_id=o.organization_id WHERE o.organization_id=? ORDER BY o.created_at,o.id`,
  },
};

export function exportCsv(db, kind, ctx = null) {
  const { orgId } = requestContext(ctx);
  requireValue(Object.hasOwn(exports, kind), '不支持此导出类型。', undefined, 404, 'NOT_FOUND');
  const spec = exports[kind];
  const rows = db.prepare(spec.sql).all(orgId);
  const content = '\uFEFF' + [spec.columns.map(cell).join(','), ...rows.map(row => spec.columns.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
  transaction(db, () => {
    audit(db, 'CSV_EXPORT_REQUESTED', orgId, { kind, count: rows.length, scope: 'ALL_LOCAL_ORGANIZATION_ROWS', formula_escape: true }, ctx);
  });
  return { filename: `botein-${kind}-${new Date().toISOString().slice(0, 10)}.csv`, content };
}
