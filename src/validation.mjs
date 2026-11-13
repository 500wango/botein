import { isIP } from 'node:net';

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
export function factoryInput(body) {
  requireValue(Array.isArray(body.supported_products) && body.supported_products.every(x => x === 'LAUNDRY_PODS'), '首版支持洗衣凝珠。', 'supported_products');
  requireValue(Array.isArray(body.service_type) && body.service_type.every(x => ['OEM', 'ODM'].includes(x)), '请选择 OEM 或 ODM。', 'service_type');
  requireValue(Array.isArray(body.target_markets) && body.target_markets.every(x => x === 'US'), '首版目标市场为美国。', 'target_markets');
  const moq = body.moq_quantity === '' || body.moq_quantity == null ? null : body.moq_quantity;
  const days = body.lead_time_days === '' || body.lead_time_days == null ? null : body.lead_time_days;
  for (const [field, value] of [['moq_quantity', moq], ['lead_time_days', days]]) {
    requireValue(value === null || (Number.isSafeInteger(value) && value > 0), '请填正整数，未知留空。', field);
  }
  const unit = text(body.unit ?? '', 'unit', 20, false);
  requireValue(!unit || ['POD', 'BAG', 'BOX', 'CARTON'].includes(unit), '请选择计量单位。', 'unit');
  const packaging = text(body.packaging_spec ?? '', 'packaging_spec', 500, false);
  requireValue(moq === null || (unit && packaging), '填写 MOQ 时需要单位与适用配方、包装条件。', 'packaging_spec');
  return {
    factory_name: text(body.factory_name, 'factory_name', 100), website: publicUrl(body.website),
    supported_products: [...new Set(body.supported_products)], service_type: [...new Set(body.service_type)],
    target_markets: [...new Set(body.target_markets)], moq_quantity: moq, unit,
    packaging_spec: packaging, lead_time_days: days,
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
