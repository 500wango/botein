import { createAuth, isHttpsRequest } from './auth.mjs';
import {
  AVAILABILITY_STATUSES,
  MARKET_CATALOG,
  PRODUCT_CATEGORIES,
  SOURCE_KINDS,
  UNIT_CATALOG,
  getEnabledScope,
} from './catalog.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, profile, requestContext, transaction, audit, addAccount, sourceNotes } from './store.mjs';
import { salesApi, reassessQualified, refreshAccountOpportunitiesFit } from './sales.mjs';
import { contactsApi } from './contacts.mjs';
import { accountsApi } from './accounts.mjs';
import { addEvidence } from './evidence.mjs';
import { importEvidence, exportCsv } from './data-transfer.mjs';
import { productsApi } from './products.mjs';
import { draftsApi, reconcileApprovals, generateDraft } from './drafts.mjs';
import { trackingApi } from './tracking.mjs';
import { researchApi } from './research.mjs';
import { sourcesApi, previewSource } from './sources.mjs';
import { auditApi } from './audit.mjs';
import { analyzeEvidence, listAssessments } from './analysis.mjs';
import { discoverContacts } from './contact-discovery.mjs';
import { monitorsApi } from './worker.mjs';
import { listConnectorsView, saveConnectorConfig } from './connectors.mjs';
import { getStorageConfig } from './storage.mjs';
import { kmsStatus } from './kms.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';
import { defaultDatabasePath } from './paths.mjs';
import { searchWeb, searchStatus, searchConfig } from './search.mjs';
import { completeJson, modelConfig } from './model.mjs';
import { fetchPublicPage } from './source-fetch.mjs';
import { AppError, requireValue, publicUrl, accountInput, factoryInput, parseCsv } from './validation.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/auth.js', ['auth.js', 'text/javascript; charset=utf-8']],
  ['/contacts.js', ['contacts.js', 'text/javascript; charset=utf-8']],
  ['/accounts.js', ['accounts.js', 'text/javascript; charset=utf-8']],
  ['/data-transfer.js', ['data-transfer.js', 'text/javascript; charset=utf-8']],
  ['/products.js', ['products.js', 'text/javascript; charset=utf-8']],
  ['/drafts.js', ['drafts.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/assets/vercel-brand.css', ['assets/vercel-brand.css', 'text/css; charset=utf-8']],
]);
const defaultServices = {
  searchWeb, searchStatus, searchBase: searchConfig().base,
  fetchPage: fetchPublicPage, completeJson, modelConfig,
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function bodyOf(req, maxBytes = 1_000_000) {
  const ctype = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  requireValue(ctype === 'application/json', '请求需为 JSON。', undefined, 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireValue(size <= maxBytes, '请求内容过大。', undefined, 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new AppError(400, 'INVALID_JSON', 'JSON 格式无效。'); }
  requireValue(body !== null && !Array.isArray(body) && typeof body === 'object', '请提交 JSON 对象。', undefined, 400);
  return body;
}

function checkVersion(current, body) {
  requireValue(body.expected_version === current.version, '档案已被更新，请刷新后重新编辑。', undefined, 409, 'VERSION_CONFLICT');
}

function parseListEnv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function validateHostAndOrigin(req, res, port) {
  const hostHeader = String(req.headers.host || '');
  const publicBaseRaw = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') : '';
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const extraHosts = parseListEnv(process.env.ALLOWED_HOSTS);
  let allowedHosts = [...localHosts, ...extraHosts];
  let expectedOrigin = `http://${hostHeader}`;

  if (publicBaseRaw) {
    try {
      const pub = new URL(publicBaseRaw);
      allowedHosts.push(pub.host);
      if (hostHeader === pub.host) {
        expectedOrigin = pub.origin;
      }
    } catch { /* fallback local only */ }
  } else if (process.env.TRUST_PROXY === '1' && isHttpsRequest(req)) {
    expectedOrigin = `https://${hostHeader}`;
  }

  requireValue(allowedHosts.includes(hostHeader), '仅允许从本机或受信任部署域名访问。', undefined, 403, 'LOCAL_ONLY');

  const corsAllowList = parseListEnv(process.env.CORS_ALLOWED_ORIGINS);
  const reqOrigin = req.headers.origin;
  const corsMatched = Boolean(reqOrigin && corsAllowList.includes(reqOrigin));
  if (corsMatched) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
    res.setHeader('Vary', 'Origin');
  }
  requireValue(!reqOrigin || reqOrigin === expectedOrigin || corsMatched, '跨来源请求已拒绝。', undefined, 403, 'ORIGIN_REJECTED');
  if (!corsMatched) {
    requireValue(req.headers['sec-fetch-site'] !== 'cross-site', '跨站请求已拒绝。', undefined, 403, 'ORIGIN_REJECTED');
  }
  return corsMatched;
}

export function createApplication({ databasePath = defaultDatabasePath(), services = defaultServices } = {}) {
  const db = openStore(databasePath);
  const auth = createAuth(db);
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Request-ID', requestId);
    try {
      const port = server.address()?.port;
      validateHostAndOrigin(req, res, port);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = url.pathname;
      const method = req.method;

      if (route.startsWith('/api/v1/auth/')) {
        const body = ['POST', 'PATCH'].includes(method) ? await bodyOf(req, 16384) : {};
        const result = await auth.handle(req, res, route.slice('/api/v1/auth'.length), method, body);
        return json(res, result.status, result.body);
      }

      let requestBody = {};
      let currentUser = null;
      let ctx = null;
      let orgId = null;
      if (route.startsWith('/api/')) {
        currentUser = auth.requireSession(req);
        if (['POST', 'PUT', 'PATCH'].includes(method)) requestBody = await bodyOf(req);
        // Recheck after waiting for a request body: logout/password rotation may have revoked it.
        currentUser = auth.requireSession(req);
        ctx = auth.ctxOf(currentUser);
        orgId = requestContext(ctx).orgId;
      }

      if (route === '/api/v1/workspace' && method === 'GET') {
        const modelReady = services.modelConfig().configured;
        let searchReady = false;
        try { searchReady = (await services.searchStatus()).reachable; } catch { searchReady = false; }
        const orgRow = db.prepare('SELECT id, name, slug FROM organizations WHERE id=?').get(orgId);
        return json(res, 200, {
          organization: orgRow || { id: orgId, name: 'LANCCO 工作空间', slug: '' }, mode: 'WORKSPACE_RBAC',
          current_user: {
            id: currentUser.id, username: currentUser.username,
            display_name: currentUser.display_name, email: currentUser.email || '',
            role: currentUser.role, mfa_enabled: Boolean(currentUser.mfa_enabled),
          },
          factory: profile(db, orgId), sources: sourceNotes,
          catalog: {
            product_categories: PRODUCT_CATEGORIES,
            markets: MARKET_CATALOG,
            units: UNIT_CATALOG,
            source_kinds: SOURCE_KINDS,
            availability_statuses: AVAILABILITY_STATUSES,
            enabled_scope: getEnabledScope(),
          },
          integrations: {
            model: { status: modelReady ? 'CONNECTED' : 'NOT_CONNECTED', label: '模型网关', detail: modelReady ? `已配置模型 ${services.modelConfig().name}，用于自动发现候选筛选、信号分析与联系人抽取。` : '未配置模型网关；自动发现与 AI 功能不可用。' },
            search: { status: searchReady ? 'CONNECTED' : 'NOT_CONNECTED', label: '搜索服务', detail: searchReady ? '本地 SearXNG 已连接，用于公开网页发现。' : '本地 SearXNG 未连接；自动发现不可用。' },
          },
          system: {
            storage: getStorageConfig(),
            kms: kmsStatus(),
            worker_mode: process.env.RESEARCH_WORKER_MODE || 'embedded',
            headless_render: process.env.HEADLESS_RENDER === '1',
          },
          counts: {
            accounts: db.prepare('SELECT count(*) AS n FROM accounts WHERE organization_id = ?').get(orgId).n,
            evidence: db.prepare('SELECT count(*) AS n FROM evidence WHERE organization_id = ?').get(orgId).n,
          },
        });
      }

      if (route === '/api/v1/system/storage' && method === 'GET') {
        return json(res, 200, { storage: getStorageConfig(), kms: kmsStatus() });
      }

      if (route === '/api/v1/ai-runs' && method === 'GET') {
        const { limit, cursor } = pageParams(url.searchParams);
        const total = db.prepare('SELECT count(*) AS n FROM ai_runs WHERE organization_id=?').get(orgId).n;
        const rawSummary = db.prepare(`SELECT
          count(*) AS total_runs,
          SUM(CASE WHEN status='SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
          SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status='FAILED' AND error_code IN ('MODEL_INVALID_OUTPUT','MODEL_CLAIM_VALIDATION_FAILED','QUOTE_NOT_FOUND','MODEL_ANALYSIS_VALIDATION_FAILED','MODEL_ANALYSIS_INVALID') THEN 1 ELSE 0 END) AS validation_rejected,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cost_usd), 0) AS total_cost_usd
          FROM ai_runs WHERE organization_id=?`).get(orgId);
        const durations = db.prepare('SELECT duration_ms FROM ai_runs WHERE organization_id=? AND duration_ms >= 0 ORDER BY duration_ms ASC')
          .all(orgId).map(r => r.duration_ms);
        const percentile = p => durations.length ? durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))] : 0;
        const byModelPrompt = db.prepare(`SELECT model, prompt_version, count(*) AS runs,
          SUM(CASE WHEN status='SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
          SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed,
          ROUND(AVG(duration_ms), 1) AS avg_duration_ms,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
          FROM ai_runs WHERE organization_id=?
          GROUP BY model, prompt_version ORDER BY runs DESC LIMIT 20`).all(orgId);
        const totalRuns = Number(rawSummary?.total_runs ?? 0) || 0;
        const validationRejected = Number(rawSummary?.validation_rejected ?? 0) || 0;
        const summary = {
          ...rawSummary,
          total_runs: totalRuns,
          succeeded: Number(rawSummary?.succeeded ?? 0) || 0,
          failed: Number(rawSummary?.failed ?? 0) || 0,
          validation_rejected: validationRejected,
          rejection_rate: totalRuns ? Number((validationRejected / totalRuns).toFixed(4)) : 0,
          p50_duration_ms: percentile(0.5),
          p95_duration_ms: percentile(0.95),
          by_model_prompt: byModelPrompt,
        };
        const base = 'SELECT * FROM ai_runs WHERE organization_id=?';
        const rows = cursor === null
          ? db.prepare(`${base} ORDER BY created_at DESC, id DESC LIMIT ?`).all(orgId, limit + 1)
          : db.prepare(`${base} AND ${olderThan('created_at', 'id')} ORDER BY created_at DESC, id DESC LIMIT ?`)
            .all(orgId, cursor[0], cursor[0], cursor[1], limit + 1);
        return json(res, 200, { ...pageRows(rows, limit, r => [r.created_at, r.id]), total, summary });
      }

      if (route === '/api/v1/factory-profile' && method === 'PUT') {
        auth.requireOwner(req);
        const body = requestBody; const data = factoryInput(body);
        const saved = transaction(db, () => {
          const current = profile(db, orgId); checkVersion(current, body);
          db.prepare('UPDATE factory_profiles SET data = ?, status = ?, version = version + 1, updated_at = ? WHERE organization_id = ?')
            .run(JSON.stringify(data), 'DRAFT', new Date().toISOString(), orgId);
          reassessQualified(db, '工厂档案已更新，需重新确认匹配条件。', undefined, ctx);
          reconcileApprovals(db, null, ctx);
          audit(db, 'FACTORY_DRAFT_SAVED', orgId, {}, ctx);
          return profile(db, orgId);
        });
        return json(res, 200, saved);
      }

      if (route === '/api/v1/factory-profile/activate' && method === 'POST') {
        auth.requireOwner(req);
        const body = requestBody;
        const saved = transaction(db, () => {
          const current = profile(db, orgId); checkVersion(current, body);
          requireValue(current.status === 'DRAFT', '当前版本已启用。', undefined, 409, 'INVALID_TRANSITION');
          requireValue(current.supported_products.length > 0 && current.target_markets.length > 0 && current.service_type.length > 0,
            '请先填写服务类型，并确认至少一个支持品类和目标市场。', 'target_markets');
          requireValue(body.confirmed === true, '需要负责人确认基础承接能力。', 'confirmed');
          const now = new Date().toISOString();
          db.prepare('UPDATE factory_profiles SET status = ?, version = version + 1, updated_at = ? WHERE organization_id = ?').run('ACTIVE', now, orgId);
          const result = profile(db, orgId);
          db.prepare('INSERT INTO factory_profile_versions VALUES (?, ?, ?, ?)').run(orgId, result.version, JSON.stringify(result), now);
          const accounts = db.prepare('SELECT id FROM accounts WHERE organization_id=?').all(orgId);
          for (const acc of accounts) refreshAccountOpportunitiesFit(db, acc.id, orgId);
          audit(db, 'FACTORY_ACTIVATED', orgId, {}, ctx);
          return result;
        });
        return json(res, 200, saved);
      }

      if (route === '/api/v1/factory-profile/history' && method === 'GET') {
        return json(res, 200, { items: db.prepare('SELECT version, published_at FROM factory_profile_versions WHERE organization_id = ? ORDER BY version DESC').all(orgId) });
      }

      if (route === '/api/v1/accounts' && method === 'GET') {
        const { limit, cursor } = pageParams(url.searchParams);
        const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 100);
        const filter = q ? `AND (a.brand_name LIKE ? ESCAPE '\\' OR a.normalized_domain LIKE ? ESCAPE '\\')` : '';
        const filterParams = q ? [`%${q.replace(/[\\%_]/g, '\\$&')}%`, `%${q.replace(/[\\%_]/g, '\\$&')}%`] : [];
        const base = `SELECT a.id, a.brand_name, a.website, a.normalized_domain, a.headquarters_country, a.notes, a.created_at, a.version,
          (SELECT count(*) FROM evidence e WHERE e.account_id=a.id AND e.organization_id=a.organization_id) AS evidence_count,
          (SELECT count(*) FROM account_products p WHERE p.account_id=a.id AND p.organization_id=a.organization_id) AS product_count
          FROM accounts a WHERE a.organization_id = ? ${filter}`;
        const total = db.prepare(`SELECT count(*) AS n FROM accounts a WHERE a.organization_id = ? ${filter}`)
          .get(orgId, ...filterParams).n;
        const rows = cursor === null
          ? db.prepare(`${base} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(orgId, ...filterParams, limit + 1)
          : db.prepare(`${base} AND ${olderThan('a.created_at', 'a.id')} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
            .all(orgId, ...filterParams, cursor[0], cursor[0], cursor[1], limit + 1);
        return json(res, 200, { ...pageRows(rows, limit, row => [row.created_at, row.id]), total });
      }

      if (route === '/api/v1/accounts/options' && method === 'GET') {
        return json(res, 200, { items: db.prepare('SELECT id, brand_name FROM accounts WHERE organization_id=? ORDER BY brand_name, id').all(orgId) });
      }

      if ((route.match(/^\/api\/v1\/accounts\/([^/]+)\/contacts\/discover$/)) && method === 'POST') {
        const result = await discoverContacts(db, route.match(/^\/api\/v1\/accounts\/([^/]+)\/contacts\/discover$/)[1], services, { ctx });
        return json(res, result.status, result.body);
      }

      if (route === '/api/v1/accounts' && method === 'POST') {
        const data = accountInput(requestBody);
        const result = transaction(db, () => addAccount(db, data, ctx));
        return json(res, result.status === 'CREATED' ? 201 : result.status === 'NEEDS_REVIEW' ? 202 : 200, result);
      }

      if (route === '/api/v1/accounts/imports' && method === 'POST') {
        const rows = parseCsv((requestBody).csv);
        const results = transaction(db, () => rows.map(row => {
          try {
            requireValue(row.valid, '列数与表头不一致。', 'csv');
            return { row: row.row, brand_name: row.data.brand_name, ...addAccount(db, accountInput(row.data), ctx) };
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            return { row: row.row, brand_name: row.data.brand_name, status: 'FAILED', reason: error.message };
          }
        }));
        return json(res, 200, { results, counts: Object.fromEntries(['CREATED', 'SKIPPED', 'NEEDS_REVIEW', 'FAILED'].map(s => [s, results.filter(r => r.status === s).length])) });
      }

      if (/^\/api\/v1\/accounts\/[^/]+$/.test(route) || /^\/api\/v1\/account-identity-reviews(?:\/[^/]+\/resolve)?$/.test(route)) {
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        const result = accountsApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, ctx);
        return json(res, result.status, result.body);
      }

      if (route === '/api/v1/sources/preview' && method === 'POST') {
        const result = await previewSource(db, requestBody, requestId, ctx);
        return json(res, result.status, result.body);
      }

      if (/^\/api\/v1\/sources(?:\/|$)/.test(route)) {
        if (method !== 'GET') auth.requireOwner(req);
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        const result = sourcesApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, ctx);
        return json(res, result.status, result.body);
      }

      if (route === '/api/v1/evidence/imports' && method === 'POST') {
        return json(res, 200, importEvidence(db, requestBody, ctx));
      }

      if (route.startsWith('/api/v1/exports/') && method === 'GET') {
        const result = exportCsv(db, route.slice('/api/v1/exports/'.length), ctx);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${result.filename}"`,
        });
        return res.end(result.content);
      }

      if (route === '/api/v1/evidence' && method === 'GET') {
        const { limit, cursor } = pageParams(url.searchParams);
        const base = `SELECT e.*, a.brand_name, p.product_name, p.product_category, p.status AS product_status FROM evidence e JOIN accounts a ON a.id=e.account_id AND a.organization_id=e.organization_id LEFT JOIN account_products p ON p.id=e.product_id AND p.organization_id=e.organization_id
          WHERE e.organization_id=?`;
        const rows = cursor === null
          ? db.prepare(`${base} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(orgId, limit + 1)
          : db.prepare(`${base} AND ${olderThan('e.created_at', 'e.id')} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`)
            .all(orgId, cursor[0], cursor[0], cursor[1], limit + 1);
        return json(res, 200, pageRows(rows, limit, row => [row.created_at, row.id]));
      }

      if (route === '/api/v1/evidence' && method === 'POST') {
        const body = requestBody;
        const result = transaction(db, () => addEvidence(db, body, ctx));
        return json(res, result.duplicate ? 200 : 201, result);
      }

      if (/^\/api\/v1\/accounts\/[^/]+\/products(?:\/[^/]+)?$/.test(route) || /^\/api\/v1\/evidence\/[^/]+\/product$/.test(route)) {
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        const result = productsApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, ctx);
        return json(res, result.status, result.body);
      }

      if ((route.match(/^\/api\/v1\/opportunities\/([^/]+)\/drafts\/generate$/)) && method === 'POST') {
        const result = await generateDraft(db, route.match(/^\/api\/v1\/opportunities\/([^/]+)\/drafts\/generate$/)[1], requestBody, services, ctx);
        return json(res, result.status, result.body);
      }

      if (/^\/api\/v1\/drafts\//.test(route) || /^\/api\/v1\/opportunities\/[^/]+\/drafts$/.test(route) || route === '/api/v1/factory-profile/checks' || route === '/api/v1/factory-profile/checks/options') {
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        const result = draftsApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, ctx);
        return json(res, result.status, result.body);
      }

      if ((route === '/api/v1/contacts' && method === 'GET') || /^\/api\/v1\/contacts\/[^/]+$/.test(route) || route === '/api/v1/contact-suppressions' || route === '/api/v1/contact-suppressions/lift') {
        if (route === '/api/v1/contact-suppressions/lift' && method === 'POST') auth.requireOwner(req);
        const body = ['PATCH', 'POST'].includes(method) ? requestBody : {};
        const result = contactsApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, ctx);
        return json(res, result.status, result.body);
      }

      if ((route.match(/^\/api\/v1\/evidence\/([^/]+)\/analyze$/)) && method === 'POST') {
        const result = await analyzeEvidence(db, route.match(/^\/api\/v1\/evidence\/([^/]+)\/analyze$/)[1], services, { ctx });
        return json(res, result.status, result.body);
      }

      if ((route.match(/^\/api\/v1\/evidence\/([^/]+)\/assessments$/)) && method === 'GET') {
        const result = listAssessments(db, route.match(/^\/api\/v1\/evidence\/([^/]+)\/assessments$/)[1], ctx);
        return json(res, result.status, result.body);
      }

      if (/^\/api\/v1\/(opportunities|contacts)(\/|$)/.test(route) || /^\/api\/v1\/evidence\/[^/]+\/(verify|invalidate|purge)$/.test(route)) {
        if (route.endsWith('/purge') && method === 'POST') auth.requireOwner(req);
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        if (req.headers['idempotency-key']) body.idempotency_key = req.headers['idempotency-key'];
        const result = salesApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, ctx);
        if (route.endsWith('/purge')) {
          try { db.exec('VACUUM'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
          catch (error) { console.error(`[${requestId}] purge compaction failed: ${error.message}`); }
        }
        return json(res, result.status, result.body);
      }

      if (route === '/api/v1/audit-logs' && method === 'GET') {
        const result = auditApi(db, route.slice('/api/v1'.length), method, url.searchParams, ctx);
        return json(res, result.status, result.body);
      }

      if (route.startsWith('/api/v1/monitors')) {
        if (method !== 'GET') auth.requireOwner(req);
        const body = ['POST', 'PATCH', 'PUT'].includes(method) ? requestBody : {};
        const result = await monitorsApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, services, ctx);
        return json(res, result.status, result.body);
      }

      if (route === '/api/v1/connectors' && method === 'GET') {
        auth.requireOwner(req);
        return json(res, 200, { items: listConnectorsView(db, ctx) });
      }

      const connectorMatch = route.match(/^\/api\/v1\/connectors\/([^/]+)$/);
      if (connectorMatch && ['PUT', 'PATCH', 'POST'].includes(method)) {
        auth.requireOwner(req);
        const saved = saveConnectorConfig(db, decodeURIComponent(connectorMatch[1]), requestBody, ctx);
        return json(res, 200, saved);
      }

      if (/^\/api\/v1\/follow-up-tasks(\/|$)/.test(route) || route === '/api/v1/analytics/funnel') {
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        if (req.headers['idempotency-key']) body.idempotency_key = req.headers['idempotency-key'];
        const result = trackingApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, ctx);
        return json(res, result.status, result.body);
      }

      if (route.startsWith('/api/v1/research-jobs')) {
        const body = method === 'POST' ? requestBody : {};
        if (req.headers['idempotency-key']) body.idempotency_key = req.headers['idempotency-key'];
        const result = await researchApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, services, ctx);
        return json(res, result.status, result.body);
      }

      if (route.startsWith('/api/')) throw new AppError(404, 'NOT_FOUND', '接口不存在。');
      if (route === '/favicon.ico' && method === 'GET') {
        res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
        return res.end();
      }
      const asset = assets.get(route);
      if (!asset || method !== 'GET') throw new AppError(404, 'NOT_FOUND', '页面不存在。');
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
      res.end(await readFile(resolve(publicDir, asset[0])));
    } catch (error) {
      if (!(error instanceof AppError)) console.error(`[${requestId}]`, error.message);
      if (!res.headersSent) {
        json(res, error.status || 500, {
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: error instanceof AppError ? error.message : '保存失败，请重试。',
            field: error.field,
            request_id: requestId,
          },
        });
      } else res.end();
    }
  });
  return { server, db };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3187);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  const { server, db } = createApplication({ databasePath: defaultDatabasePath() });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another local port.` : error.message);
    db.close(); process.exitCode = 1;
  });
  const host = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
  server.listen(port, host, () => console.log(`Botein workspace: http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
