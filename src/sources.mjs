import { randomUUID } from 'node:crypto';
import { getEnabledScope } from './catalog.mjs';
import { audit, checkAndRecordRateLimit, requestContext, transaction } from './store.mjs';
import { AppError, requireValue, text } from './validation.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';
import { fetchPublicPage, sourceUrl } from './source-fetch.mjs';

const WINDOW_MS = 15 * 60_000;
const AUTO_DISABLE_AFTER = 5;

export function sourceMatchesHost(source, hostname) {
  const host = String(hostname).toLowerCase();
  return JSON.parse(source.base_domains).some(base => host === base || host.endsWith(`.${base}`));
}

function reserveSourceAttempt(db, source) {
  const check = checkAndRecordRateLimit(db, 'source_fetch', source.id, source.rate_limit_per_15m, WINDOW_MS);
  if (!check.allowed) {
    throw new AppError(429, 'SOURCE_RATE_LIMITED',
      `来源“${source.name}”已达到每 15 分钟 ${source.rate_limit_per_15m} 次读取上限。`, 'source_id');
  }
}

const KINDS = ['AUTO_DISCOVERY', 'USER_PROVIDED_URL'];
const CORE_FIELDS = ['name', 'kind', 'base_domains', 'markets', 'product_categories', 'rate_limit_per_15m'];

function domain(value) {
  const clean = text(value, 'base_domains', 253).toLowerCase();
  requireValue(/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(clean),
    '请填写有效域名，不含协议、端口或路径。', 'base_domains');
  requireValue(!/\.(localhost|local|internal|test|invalid|example)$/.test(clean), '不接受本机或保留域名。', 'base_domains');
  return clean;
}

function domainList(value) {
  requireValue(Array.isArray(value) && value.length > 0, '请至少填写一个允许域名。', 'base_domains');
  const list = [...new Set(value.map(domain))];
  requireValue(list.length <= 20, '最多登记 20 个域名。', 'base_domains');
  return list;
}

function normalize(body, current = null) {
  const kind = body.kind ?? current?.kind ?? 'AUTO_DISCOVERY';
  requireValue(KINDS.includes(kind), '请选择有效来源类型。', 'kind');
  const name = body.name !== undefined ? text(body.name, 'name', 100) : current?.name;
  requireValue(name, '请填写来源名称。', 'name');

  const domains = body.base_domains !== undefined ? domainList(body.base_domains)
    : current ? JSON.parse(current.base_domains) : [];
  requireValue(domains.length > 0, '请至少填写一个允许域名。', 'base_domains');
  requireValue(domains.length <= 20, '最多登记 20 个域名。', 'base_domains');

  const scope = getEnabledScope();
  const isDefaultScope = scope.markets.length === 1 && scope.markets[0] === 'US'
    && scope.product_categories.length === 1 && scope.product_categories[0] === 'LAUNDRY_PODS';

  const markets = body.markets !== undefined ? body.markets : current ? JSON.parse(current.markets) : [scope.markets[0]];
  requireValue(Array.isArray(markets) && markets.length > 0 && markets.every(market => scope.markets.includes(market)),
    isDefaultScope ? '首版来源市场为美国。' : '请选择有效的来源目标市场。', 'markets');
  const categories = body.product_categories !== undefined ? body.product_categories
    : current ? JSON.parse(current.product_categories) : [scope.product_categories[0]];
  requireValue(Array.isArray(categories) && categories.length > 0 && categories.every(category => scope.product_categories.includes(category)),
    isDefaultScope ? '首版来源品类为洗衣凝珠。' : '请选择有效的来源支持品类。', 'product_categories');
  const limit = body.rate_limit_per_15m ?? current?.rate_limit_per_15m ?? 20;
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 120, '请求上限为 1–120 的整数。', 'rate_limit_per_15m');
  return {
    name, kind, base_domains: [...new Set(domains)], markets: [...new Set(markets)],
    product_categories: [...new Set(categories)], rate_limit_per_15m: limit,
    usage_note: body.usage_note !== undefined ? text(body.usage_note, 'usage_note', 2000, false) : current?.usage_note ?? '',
    retention_note: body.retention_note !== undefined ? text(body.retention_note, 'retention_note', 2000, false) : current?.retention_note ?? '',
  };
}

function sourceRow(db, id, orgId) {
  const row = db.prepare('SELECT * FROM sources WHERE organization_id=? AND id=?').get(orgId, id);
  requireValue(row, '来源不存在。', undefined, 404, 'NOT_FOUND');
  return row;
}

function sourceView(row) {
  return {
    ...row, base_domains: JSON.parse(row.base_domains), markets: JSON.parse(row.markets),
    product_categories: JSON.parse(row.product_categories),
  };
}

function readiness(items) {
  const auto = items.filter(item => item.kind === 'AUTO_DISCOVERY');
  const user = items.filter(item => item.kind === 'USER_PROVIDED_URL');
  const activeAuto = auto.filter(item => item.status === 'ACTIVE').length;
  return {
    auto_discovery: { registered: auto.length, active: activeAuto, ready: activeAuto > 0 },
    user_provided_url: { registered: user.length, active: user.filter(item => item.status === 'ACTIVE').length },
    adapter: 'SEARXNG_MODEL',
    missing: [],
  };
}

export function sourcesApi(db, path, method, body, query, ctx = null) {
  const { orgId } = requestContext(ctx);
  let match;
  if (path === '/sources/options' && method === 'GET') {
    return { status: 200, body: { items: db.prepare(`SELECT id,name,rate_limit_per_15m FROM sources
      WHERE organization_id=? AND status='ACTIVE' ORDER BY name,id`).all(orgId) } };
  }
  if (path === '/sources' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const all = db.prepare('SELECT kind,status FROM sources WHERE organization_id=?').all(orgId);
    const base = 'SELECT * FROM sources WHERE organization_id=?';
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY created_at DESC, id DESC LIMIT ?`).all(orgId, limit + 1)
      : db.prepare(`${base} AND ${olderThan('created_at', 'id')} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(orgId, cursor[0], cursor[0], cursor[1], limit + 1);
    const page = pageRows(rows, limit, row => [row.created_at, row.id]);
    return { status: 200, body: { items: page.items.map(sourceView), next_cursor: page.next_cursor, total: all.length, readiness: readiness(all) } };
  }

  if (path === '/sources' && method === 'POST') {
    const data = normalize(body);
    return transaction(db, () => {
      const duplicate = db.prepare('SELECT id FROM sources WHERE organization_id=? AND name=?').get(orgId, data.name);
      requireValue(!duplicate, '来源名称已存在，请打开现有记录。', 'name', 409, 'SOURCE_IDENTITY_CONFLICT');
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare(`INSERT INTO sources
        (id,organization_id,name,kind,status,base_domains,markets,product_categories,rate_limit_per_15m,usage_note,retention_note,created_at,updated_at)
        VALUES (?,?,?,?,'PENDING',?,?,?,?,?,?,?,?)`)
        .run(id, orgId, data.name, data.kind, JSON.stringify(data.base_domains), JSON.stringify(data.markets),
          JSON.stringify(data.product_categories), data.rate_limit_per_15m, data.usage_note, data.retention_note, now, now);
      audit(db, 'SOURCE_REGISTERED', id, { ...data, status: 'PENDING' }, ctx);
      return { status: 201, body: sourceView(sourceRow(db, id, orgId)) };
    });
  }

  if ((match = path.match(/^\/sources\/([^/]+)$/)) && method === 'PATCH') {
    return transaction(db, () => {
      const current = sourceRow(db, match[1], orgId);
      requireValue(body.expected_version === current.version, '来源已更新，请重新打开。', undefined, 409, 'VERSION_CONFLICT');
      const data = normalize(body, current);
      const duplicate = db.prepare('SELECT id FROM sources WHERE organization_id=? AND name=? AND id<>?').get(orgId, data.name, current.id);
      requireValue(!duplicate, '来源名称已存在，请打开现有记录。', 'name', 409, 'SOURCE_IDENTITY_CONFLICT');
      const before = sourceView(current);
      const coreChanged = CORE_FIELDS.some(field => JSON.stringify(data[field]) !== JSON.stringify(before[field]));
      const reason = text(body.reason ?? '', 'reason', 1000, coreChanged);
      const status = coreChanged && current.status === 'ACTIVE' ? 'PENDING' : current.status;
      db.prepare(`UPDATE sources SET name=?,kind=?,status=?,base_domains=?,markets=?,product_categories=?,rate_limit_per_15m=?,
        usage_note=?,retention_note=?,version=version+1,updated_at=? WHERE organization_id=? AND id=?`)
        .run(data.name, data.kind, status, JSON.stringify(data.base_domains), JSON.stringify(data.markets),
          JSON.stringify(data.product_categories), data.rate_limit_per_15m, data.usage_note, data.retention_note,
          new Date().toISOString(), orgId, current.id);
      audit(db, 'SOURCE_UPDATED', current.id, { reason, core_changed: coreChanged, before, after: { ...data, status } }, ctx);
      return { status: 200, body: sourceView(sourceRow(db, current.id, orgId)) };
    });
  }

  if ((match = path.match(/^\/sources\/([^/]+)\/activate$/)) && method === 'POST') {
    return transaction(db, () => {
      const current = sourceRow(db, match[1], orgId);
      requireValue(body.expected_version === current.version, '来源已更新，请重新打开。', undefined, 409, 'VERSION_CONFLICT');
      requireValue(body.terms_confirmed === true, '请确认已核对来源的使用方式、授权或允许使用记录，以及保留方式。', 'terms_confirmed');
      const data = sourceView(current);
      requireValue(data.base_domains.length > 0, '请先填写允许域名。', 'base_domains');
      requireValue(data.usage_note, '启用前请填写使用方式与授权记录。', 'usage_note');
      requireValue(data.retention_note, '启用前请填写原始内容保留方式。', 'retention_note');
      if (current.status === 'ACTIVE') return { status: 200, body: data };
      db.prepare(`UPDATE sources SET status='ACTIVE',consecutive_failures=0,last_error_at=NULL,last_error='',
        version=version+1,updated_at=? WHERE organization_id=? AND id=?`)
        .run(new Date().toISOString(), orgId, current.id);
      audit(db, 'SOURCE_ACTIVATED', current.id, {
        kind: data.kind, base_domains: data.base_domains, markets: data.markets,
        product_categories: data.product_categories, rate_limit_per_15m: data.rate_limit_per_15m,
        usage_note: data.usage_note, retention_note: data.retention_note,
      }, ctx);
      return { status: 200, body: sourceView(sourceRow(db, current.id, orgId)) };
    });
  }

  if ((match = path.match(/^\/sources\/([^/]+)\/disable$/)) && method === 'POST') {
    return transaction(db, () => {
      const current = sourceRow(db, match[1], orgId);
      requireValue(body.expected_version === current.version, '来源已更新，请重新打开。', undefined, 409, 'VERSION_CONFLICT');
      const reason = text(body.reason, 'reason', 1000);
      if (current.status === 'DISABLED') return { status: 200, body: sourceView(current) };
      db.prepare("UPDATE sources SET status='DISABLED',version=version+1,updated_at=? WHERE organization_id=? AND id=?")
        .run(new Date().toISOString(), orgId, current.id);
      audit(db, 'SOURCE_DISABLED', current.id, { reason, previous_status: current.status }, ctx);
      return { status: 200, body: sourceView(sourceRow(db, current.id, orgId)) };
    });
  }

  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}

// Source-governed page preview: domain scope, per-source rate limit, health
// tracking and automatic disable after repeated upstream failures.
export async function previewSource(db, body, requestId, ctx = null) {
  const { orgId } = requestContext(ctx);
  const raw = typeof body.url === 'string' ? body.url.trim() : '';
  requireValue(raw, '请填写来源网址。', 'url', 422, 'INVALID_URL');
  const target = sourceUrl(raw);
  const sourceId = body.source_id ? text(body.source_id, 'source_id', 100) : null;
  let source = null;
  if (sourceId) {
    source = db.prepare('SELECT * FROM sources WHERE organization_id=? AND id=?').get(orgId, sourceId);
    requireValue(source, '来源不存在。', 'source_id', 404, 'NOT_FOUND');
    requireValue(source.status === 'ACTIVE', '来源未启用，不能执行读取。', 'source_id', 409, 'SOURCE_NOT_ACTIVE');
    requireValue(sourceMatchesHost(source, target.hostname), '目标域名不在来源允许范围内。', 'source_id', 422, 'SOURCE_SCOPE_MISMATCH');
    reserveSourceAttempt(db, source);
  }
  try {
    const result = await fetchPublicPage(target.href, {
      bypassGlobalRateLimit: Boolean(source),
      rateBucket: 'preview',
      rateLimitDb: db,
    });
    if (source) {
      db.prepare(`UPDATE sources SET consecutive_failures=0,last_error_at=NULL,last_error='',updated_at=?
        WHERE organization_id=? AND id=?`).run(new Date().toISOString(), orgId, source.id);
    }
    audit(db, 'SOURCE_PAGE_FETCHED', result.final_url, {
      source_id: source?.id ?? null, requested_url: result.requested_url, status_code: result.status_code,
      content_type: result.content_type, byte_length: result.byte_length, redirect_count: result.redirect_count,
      extraction: result.extraction, request_id: requestId,
    }, ctx);
    return { status: 200, body: { ...result, source_id: source?.id ?? null } };
  } catch (error) {
    const counted = source && error.code !== 'SOURCE_RATE_LIMITED';
    if (counted) {
      const now = new Date().toISOString();
      const { failures, autoDisabled } = transaction(db, () => {
        const updated = db.prepare(`UPDATE sources SET
          consecutive_failures = consecutive_failures + 1,
          last_error_at = ?,
          last_error = ?,
          status = CASE WHEN consecutive_failures + 1 >= ? THEN 'DISABLED' ELSE status END,
          version = version + CASE WHEN consecutive_failures + 1 >= ? AND status <> 'DISABLED' THEN 1 ELSE 0 END,
          updated_at = ?
          WHERE organization_id = ? AND id = ?
          RETURNING consecutive_failures, status`).get(now, error.message, AUTO_DISABLE_AFTER, AUTO_DISABLE_AFTER, now, orgId, source.id);
        const failCount = updated?.consecutive_failures ?? (source.consecutive_failures + 1);
        const disabled = updated?.status === 'DISABLED' && failCount >= AUTO_DISABLE_AFTER;
        audit(db, 'SOURCE_PAGE_FETCH_FAILED', source.id, {
          source_id: source.id, requested_url: target.href, code: error.code ?? 'INTERNAL_ERROR',
          reason: error.message, consecutive_failures: failCount, auto_disabled: disabled, request_id: requestId,
        }, ctx);
        if (disabled) {
          audit(db, 'SOURCE_AUTO_DISABLED', source.id, { consecutive_failures: failCount, last_error: error.message, request_id: requestId }, ctx);
        }
        return { failures: failCount, autoDisabled: disabled };
      });
      if (autoDisabled) {
        error.message += ` 来源已连续失败 ${failures} 次，已自动停用。`;
      }
    } else {
      audit(db, 'SOURCE_PAGE_FETCH_FAILED', source?.id ?? String(target.href), {
        source_id: source?.id ?? null, requested_url: target.href, code: error.code ?? 'INTERNAL_ERROR',
        reason: error.message, counted: Boolean(counted), request_id: requestId,
      }, ctx);
    }
    throw error;
  }
}
