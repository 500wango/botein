import { isIP } from 'node:net';
import { getEnabledScope, MARKET_CATALOG, UNIT_CATALOG } from './catalog.mjs';

export class AppError extends Error {
  constructor(status, code, message, field) {
    super(message);
    Object.assign(this, { status, code, field });
  }
}
export function requireValue(condition, message, field, status = 422, code = 'VALIDATION_ERROR') {
  if (!condition) throw new AppError(status, code, message, field);
}
export function text(value, name, max = 200, required = true) {
  requireValue(typeof value === 'string', '请填写有效文本。', name);
  const clean = value.trim();
  requireValue((!required || clean.length > 0) && clean.length <= max, `请填写${required ? '非空且' : ''}不超过 ${max} 字的内容。`, name);
  return clean;
}
export function publicUrl(value, field = 'website', optional = false) {
  if (optional && (value === '' || value === undefined)) return '';
  let url;
  try { url = new URL(value); } catch { throw new AppError(422, 'INVALID_URL', '请填写包含 https:// 的公开网址。', field); }
  const host = url.hostname.toLowerCase();
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    !url.port && !host.startsWith('[') && !isIP(host) && host.includes('.') &&
    !/\.(localhost|local|internal|test|invalid)$/.test(host) && !host.endsWith('.'),
  '请使用不含账号密码的公开网站域名，暂不接受 IP、内网地址或自定义端口。', field);
  url.hash = '';
  return url.href;
}
export function accountInput(body) {
  const website = publicUrl(body.website);
  const country = text(body.headquarters_country ?? '', 'headquarters_country', 2, false).toUpperCase();
  requireValue(!country || /^[A-Z]{2}$/.test(country), '国家代码为两个英文字母，未知可留空。', 'headquarters_country');
  return {
    brand_name: text(body.brand_name, 'brand_name', 100), website,
    normalized_domain: new URL(website).hostname.replace(/^www\./, ''),
    headquarters_country: country,
    notes: text(body.notes ?? '', 'notes', 2000, false),
  };
}
export function optionalPublicUrl(value, field = 'url') {
  return publicUrl(value, field, true);
}
export function emailAddress(value, field = 'email') {
  const clean = text(value, field, 200).toLowerCase();
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean), '请填写有效的邮箱地址。', field);
  return clean;
}
export function factoryInput(body) {
  const scope = getEnabledScope();
  const isDefaultScope = scope.product_categories.length === 1 && scope.product_categories[0] === 'LAUNDRY_PODS'
    && scope.markets.length === 1 && scope.markets[0] === 'US';
  requireValue(
    Array.isArray(body.supported_products)
      && body.supported_products.every(x => scope.product_categories.includes(x)),
    isDefaultScope ? '首版支持洗衣凝珠。' : '请选择当前已开通的支持品类。',
    'supported_products',
  );
  requireValue(
    Array.isArray(body.service_type) && body.service_type.every(x => ['OEM', 'ODM'].includes(x)),
    '请选择 OEM 或 ODM。',
    'service_type',
  );
  requireValue(
    Array.isArray(body.target_markets)
      && body.target_markets.every(x => scope.markets.includes(x)),
    isDefaultScope ? '首版目标市场为美国。' : '请选择有效的目标市场。',
    'target_markets',
  );
  const moq = body.moq_quantity === '' || body.moq_quantity == null ? null : body.moq_quantity;
  const days = body.lead_time_days === '' || body.lead_time_days == null ? null : body.lead_time_days;
  for (const [field, value] of [['moq_quantity', moq], ['lead_time_days', days]]) {
    requireValue(value === null || (Number.isSafeInteger(value) && value > 0), '请填正整数，未知留空。', field);
  }
  const unit = text(body.unit ?? '', 'unit', 20, false);
  requireValue(!unit || UNIT_CATALOG.includes(unit), '请选择计量单位。', 'unit');
  const packaging = text(body.packaging_spec ?? '', 'packaging_spec', 500, false);
  requireValue(moq === null || (unit && packaging), '填写 MOQ 时需要单位与适用配方、包装条件。', 'packaging_spec');

  const rawProhibited = body.prohibited_markets ?? [];
  requireValue(
    Array.isArray(rawProhibited) && rawProhibited.every(x => Object.hasOwn(MARKET_CATALOG, x)),
    '请选择有效的禁入市场代码。',
    'prohibited_markets',
  );
  const prohibited_markets = [...new Set(rawProhibited)];
  const targetSet = new Set(body.target_markets);
  requireValue(!prohibited_markets.some(x => targetSet.has(x)), '目标市场与禁入市场不可冲突。', 'prohibited_markets');

  const rawCerts = body.certifications ?? [];
  requireValue(Array.isArray(rawCerts) && rawCerts.length <= 20, '认证列表最多填写 20 项。', 'certifications');
  const seenCertKeys = new Set();
  const certifications = [];
  for (const item of rawCerts) {
    if (typeof item === 'string') {
      const name = text(item, 'certifications', 80, false);
      if (!name) continue;
      const key = `str:${name.toLowerCase()}`;
      if (!seenCertKeys.has(key)) {
        seenCertKeys.add(key);
        certifications.push(name);
      }
      continue;
    }
    requireValue(item && typeof item === 'object', '认证项格式无效。', 'certifications');
    const name = text(item.name ?? '', 'certifications', 80);
    const cert_no = text(item.cert_no ?? '', 'certifications', 80, false);
    const issuer = text(item.issuer ?? '', 'certifications', 120, false);
    const expires_at = text(item.expires_at ?? '', 'certifications', 20, false);
    if (expires_at) {
      requireValue(/^\d{4}-\d{2}-\d{2}$/.test(expires_at), '认证有效期格式应为 YYYY-MM-DD。', 'certifications');
    }
    const attachment_url = item.attachment_url ? publicUrl(item.attachment_url, 'certifications', true) : '';
    const key = `obj:${name.toLowerCase()}:${cert_no.toLowerCase()}`;
    if (!seenCertKeys.has(key)) {
      seenCertKeys.add(key);
      certifications.push({ name, cert_no, issuer, expires_at, attachment_url });
    }
  }

  const rawTerms = body.production_terms ?? [];
  requireValue(Array.isArray(rawTerms) && rawTerms.length <= 20, '生产条件条款最多填写 20 条。', 'production_terms');
  const supportedSet = new Set(body.supported_products);
  const production_terms = rawTerms.map((term, idx) => {
    requireValue(term && typeof term === 'object', `第 ${idx + 1} 条生产条件格式无效。`, 'production_terms');
    const product_category = text(term.product_category ?? body.supported_products[0] ?? '', 'production_terms', 40);
    requireValue(supportedSet.has(product_category), '生产条件中的品类必须属于已选支持品类。', 'production_terms');
    const minMoq = term.min_moq === '' || term.min_moq == null ? null : term.min_moq;
    const maxMoq = term.max_moq === '' || term.max_moq == null ? null : term.max_moq;
    const termDays = term.lead_time_days === '' || term.lead_time_days == null ? null : term.lead_time_days;
    for (const val of [minMoq, maxMoq, termDays]) {
      requireValue(val === null || (Number.isSafeInteger(val) && val > 0), '生产条件中的数量与交期请填正整数。', 'production_terms');
    }
    requireValue(minMoq === null || maxMoq === null || minMoq <= maxMoq, '最小 MOQ 不可大于最大接单量。', 'production_terms');
    const termUnit = text(term.unit ?? '', 'production_terms', 20, false);
    requireValue(!termUnit || UNIT_CATALOG.includes(termUnit), '生产条件中的计量单位无效。', 'production_terms');
    const termPackaging = text(term.packaging_spec ?? '', 'production_terms', 500, false);
    requireValue(minMoq === null || (termUnit && termPackaging), '填写生产条件 MOQ 时需同时填写单位和包装规格。', 'production_terms');
    return {
      product_category,
      min_moq: minMoq,
      max_moq: maxMoq,
      unit: termUnit,
      packaging_spec: termPackaging,
      lead_time_days: termDays,
    };
  });

  return {
    factory_name: text(body.factory_name, 'factory_name', 100), website: publicUrl(body.website),
    supported_products: [...new Set(body.supported_products)], service_type: [...new Set(body.service_type)],
    target_markets: [...new Set(body.target_markets)], moq_quantity: moq, unit,
    packaging_spec: packaging, lead_time_days: days,
    production_terms, certifications, prohibited_markets,
    notes: text(body.notes ?? '', 'notes', 4000, false),
  };
}

// RFC 4180 quoting, BOM and CRLF; no formulas are evaluated.
export function parseCsv(input, requiredHeaders = ['brand_name', 'website']) {
  requireValue(typeof input === 'string' && Buffer.byteLength(input, 'utf8') <= 500_000, 'CSV 文件过大或内容无效。', 'csv');
  const rows = []; let row = [], value = '', quoted = false, closed = false;
  input = input.replace(/^\uFEFF/, '');
  for (let i = 0; i <= input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === undefined) throw new AppError(422, 'INVALID_CSV', 'CSV 引号未闭合。', 'csv');
      if (c === '"') {
        if (input[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else value += c;
    } else if (c === ',' || c === '\n' || c === '\r' || c === undefined) {
      row.push(value); value = ''; closed = false;
      if (c !== ',') {
        if (row.some(x => x !== '')) rows.push(row);
        row = [];
        if (c === '\r' && input[i + 1] === '\n') i++;
      }
    } else if (c === '"' && !value && !closed) quoted = true;
    else {
      requireValue(!closed && c !== '"', 'CSV 引号格式有误。', 'csv');
      value += c;
    }
  }
  requireValue(rows.length > 1 && rows.length <= 501, 'CSV 需要表头及 1–500 行数据。', 'csv');
  const headers = rows.shift().map(x => x.trim());
  requireValue(requiredHeaders.every(key => headers.includes(key)) && headers.every(Boolean) && new Set(headers).size === headers.length,
    `CSV 表头需包含 ${requiredHeaders.join('、')}，且列名不可为空或重复。`, 'csv');
  return rows.map((cells, index) => ({
    row: index + 2, valid: cells.length === headers.length,
    data: Object.fromEntries(headers.map((key, i) => [key, cells[i] ?? ''])),
  }));
}
