import { randomUUID } from 'node:crypto';
import { sealSecret, unsealSecret } from './kms.mjs';
import { connectorUrl, safeExternalFetch } from './source-fetch.mjs';
import { audit, requestContext, transaction } from './store.mjs';
import { AppError, publicUrl, requireValue, text } from './validation.mjs';

const SENSITIVE_PAYLOAD_KEYS = new Set(['reset_token', 'invite_token', 'token', 'secret', 'password', 'api_key']);

export function redactSensitivePayload(value) {
  if (Array.isArray(value)) return value.map(redactSensitivePayload);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_PAYLOAD_KEYS.has(k) && v ? '[REDACTED]' : redactSensitivePayload(v);
    }
    return out;
  }
  return value;
}

export const CONNECTOR_KINDS = ['B2B_CONTACTS', 'ECOMMERCE_DATA', 'OUTBOUND_NOTIFY'];
const CANONICAL_ROLES = new Set(['DECISION_MAKER', 'PROCUREMENT', 'OPERATIONS', 'SALES', 'GENERAL', 'UNKNOWN']);
const ROLE_ALIASES = { FOUNDER: 'DECISION_MAKER', CEO: 'DECISION_MAKER', PRODUCT: 'OPERATIONS', QUALITY: 'OPERATIONS', QA: 'OPERATIONS' };

function normalizeConnectorRole(rawRole) {
  const upper = String(rawRole || '').trim().toUpperCase();
  if (CANONICAL_ROLES.has(upper)) return upper;
  return ROLE_ALIASES[upper] || 'UNKNOWN';
}

function safeConnectorUrl(value, fallback = '') {
  const raw = String(value || '').trim().slice(0, 500);
  if (!raw) return fallback;
  try {
    return publicUrl(raw, 'url', false);
  } catch {
    return fallback;
  }
}

function timeoutSignal(upstreamSignal, ms = 10_000) {
  const timer = AbortSignal.timeout(ms);
  return upstreamSignal ? AbortSignal.any([upstreamSignal, timer]) : timer;
}

export function getConnectorConfig(db, kind, ctx = null) {
  const { orgId } = requestContext(ctx);
  const row = db.prepare('SELECT * FROM connector_configs WHERE organization_id=? AND kind=?').get(orgId, kind);
  if (!row) {
    const envUrl = kind === 'B2B_CONTACTS'
      ? (process.env.CONTACT_ENRICHMENT_API_URL || '').trim()
      : kind === 'ECOMMERCE_DATA'
        ? (process.env.ECOMMERCE_DATA_API_URL || '').trim()
        : (process.env.NOTIFY_WEBHOOK_URL || '').trim();
    const envKey = kind === 'B2B_CONTACTS'
      ? (process.env.CONTACT_ENRICHMENT_API_KEY || '').trim()
      : kind === 'ECOMMERCE_DATA'
        ? (process.env.ECOMMERCE_DATA_API_KEY || '').trim()
        : '';
    return {
      kind,
      enabled: Boolean(envUrl),
      endpoint_url: envUrl,
      api_key: envKey,
      has_api_key: Boolean(envKey),
      options: {},
      source: envUrl ? 'ENV' : 'UNCONFIGURED',
    };
  }
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled === 1 && Boolean(row.endpoint_url),
    endpoint_url: row.endpoint_url,
    api_key: row.api_key_enc ? unsealSecret(row.api_key_enc) : '',
    has_api_key: Boolean(row.api_key_enc),
    options: JSON.parse(row.options || '{}'),
    updated_at: row.updated_at,
    source: 'WORKSPACE',
  };
}

export function listConnectorsView(db, ctx = null) {
  return CONNECTOR_KINDS.map(kind => {
    const cfg = getConnectorConfig(db, kind, ctx);
    return {
      kind: cfg.kind,
      enabled: cfg.enabled,
      endpoint_url: cfg.endpoint_url,
      has_api_key: cfg.has_api_key,
      options: cfg.options,
      source: cfg.source,
      updated_at: cfg.updated_at ?? null,
    };
  });
}

export function saveConnectorConfig(db, kind, body, ctx = null) {
  requireValue(CONNECTOR_KINDS.includes(kind), '不支持的连接器类型。', 'kind');
  const { orgId } = requestContext(ctx);
  const enabled = body.enabled === true;
  const allowPrivate = process.env.ALLOW_PRIVATE_CONNECTORS === '1';
  const endpointUrl = body.endpoint_url
    ? (allowPrivate ? connectorUrl(body.endpoint_url, { allowPrivate: true, field: 'endpoint_url' }).href : publicUrl(body.endpoint_url, 'endpoint_url', true))
    : '';
  if (endpointUrl) connectorUrl(endpointUrl, { allowPrivate, field: 'endpoint_url' });
  if (enabled) requireValue(endpointUrl, '启用外部连接器时必须提供有效的 HTTPS 接口地址。', 'endpoint_url');
  const options = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : {};
  return transaction(db, () => {
    const existing = db.prepare('SELECT * FROM connector_configs WHERE organization_id=? AND kind=?').get(orgId, kind);
    const hasNewKey = typeof body.api_key === 'string' && body.api_key.trim().length > 0;
    const encryptedKey = hasNewKey
      ? sealSecret(text(body.api_key, 'api_key', 512))
      : body.clear_api_key === true
        ? ''
        : (existing?.api_key_enc ?? '');
    const now = new Date().toISOString();
    if (existing) {
      db.prepare(`UPDATE connector_configs
        SET endpoint_url=?, api_key_enc=?, enabled=?, options=?, updated_at=?
        WHERE organization_id=? AND kind=?`)
        .run(endpointUrl, encryptedKey, enabled ? 1 : 0, JSON.stringify(options), now, orgId, kind);
    } else {
      db.prepare(`INSERT INTO connector_configs
        (id,organization_id,kind,endpoint_url,api_key_enc,enabled,options,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), orgId, kind, endpointUrl, encryptedKey, enabled ? 1 : 0, JSON.stringify(options), now);
    }
    audit(db, 'CONNECTOR_UPDATED', kind, { enabled, has_endpoint: Boolean(endpointUrl), key_updated: hasNewKey }, ctx);
    const view = listConnectorsView(db, ctx).find(item => item.kind === kind);
    return view;
  });
}

/**
 * Queries an optional configured B2B contact enrichment connector API.
 * Strictly returns candidate unverified contacts with source_url attribution.
 */
export async function queryExternalContactsConnector(db, account, { signal, fetchImpl = safeExternalFetch } = {}, ctx = null) {
  const cfg = getConnectorConfig(db, 'B2B_CONTACTS', ctx);
  if (!cfg.enabled || !cfg.endpoint_url) return [];
  connectorUrl(cfg.endpoint_url, { field: 'endpoint_url' });
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  const response = await fetchImpl(cfg.endpoint_url, {
    method: 'POST',
    headers,
    signal: timeoutSignal(signal, 15_000),
    body: JSON.stringify({
      domain: account.normalized_domain,
      brand_name: account.brand_name,
      website: account.website,
    }),
  });
  if (!response.ok) {
    throw new AppError(502, 'CONNECTOR_ERROR', `外部联系人接口返回 ${response.status}。`);
  }
  const data = await response.json();
  const rows = Array.isArray(data?.contacts) ? data.contacts : [];
  return rows
    .filter(item => item && typeof item.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(item.email.trim()))
    .map(item => ({
      full_name: String(item.full_name || '').trim().slice(0, 100),
      job_title: String(item.job_title || '').trim().slice(0, 120),
      department: String(item.department || '').trim().slice(0, 80),
      linkedin_url: safeConnectorUrl(item.linkedin_url, ''),
      role_relevance: normalizeConnectorRole(item.role_relevance),
      email: item.email.trim().toLowerCase(),
      source_url: safeConnectorUrl(item.source_url, account.website),
    }));
}

export async function dispatchNotification(db, { channel, recipient, subject, payload }, ctx = null, { fetchImpl = safeExternalFetch } = {}) {
  const { orgId } = requestContext(ctx);
  const cfg = getConnectorConfig(db, 'OUTBOUND_NOTIFY', ctx);
  const id = randomUUID(), now = new Date().toISOString();
  let status = 'RECORDED_LOCAL';
  let errorMessage = '';
  if (cfg.enabled && cfg.endpoint_url) {
    try {
      connectorUrl(cfg.endpoint_url, { field: 'endpoint_url' });
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
      const res = await fetchImpl(cfg.endpoint_url, {
        method: 'POST',
        headers,
        signal: timeoutSignal(null, 10_000),
        body: JSON.stringify({ channel, recipient, subject, payload, organization_id: orgId, timestamp: now }),
      });
      status = res.ok ? 'DELIVERED' : 'FAILED';
      if (!res.ok) errorMessage = `Webhook status ${res.status}`;
    } catch (error) {
      status = 'FAILED';
      errorMessage = error.message;
    }
  }
  const redactedPayload = redactSensitivePayload(payload);
  db.prepare(`INSERT INTO outbound_notifications
    (id,organization_id,channel,recipient,subject,payload,status,error_message,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, orgId, channel, recipient, subject, JSON.stringify(redactedPayload), status, errorMessage, now);
  return { id, status, error_message: errorMessage, created_at: now };
}

/**
 * Queries an optional configured e-commerce marketplace/listing data connector.
 * Returns normalized candidate records with unverified raw_text and source_url.
 */
export async function queryEcommerceDataConnector(db, { market = 'US', product_category = 'LAUNDRY_PODS', quantity = 10 } = {}, { signal, fetchImpl = safeExternalFetch } = {}, ctx = null) {
  const cfg = getConnectorConfig(db, 'ECOMMERCE_DATA', ctx);
  if (!cfg.enabled || !cfg.endpoint_url) return [];
  connectorUrl(cfg.endpoint_url, { field: 'endpoint_url' });
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  const response = await fetchImpl(cfg.endpoint_url, {
    method: 'POST',
    headers,
    signal: timeoutSignal(signal, 15_000),
    body: JSON.stringify({ market, product_category, limit: Math.min(50, Math.max(1, Number(quantity) || 10)) }),
  });
  if (!response.ok) {
    throw new AppError(502, 'CONNECTOR_ERROR', `电商数据源接口返回 ${response.status}。`);
  }
  const data = await response.json();
  const rows = Array.isArray(data?.items) ? data.items : (Array.isArray(data?.brands) ? data.brands : []);
  return rows
    .filter(item => item && typeof item.brand_name === 'string' && typeof item.website === 'string' && typeof item.raw_text === 'string' && typeof item.source_url === 'string')
    .map(item => ({
      brand_name: item.brand_name.trim().slice(0, 120),
      website: item.website.trim().slice(0, 300),
      source_url: item.source_url.trim().slice(0, 500),
      raw_text: item.raw_text.trim().slice(0, 20000),
      headquarters_country: String(item.headquarters_country || market).trim().toUpperCase().slice(0, 2),
      published_at: item.published_at || '',
    }));
}
