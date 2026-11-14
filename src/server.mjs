import { createAuth } from './auth.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, ORG, profile, transaction, audit, addAccount, sourceNotes } from './store.mjs';
import { salesApi, reassessQualified } from './sales.mjs';
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
import { olderThan, pageParams, pageRows } from './pagination.mjs';
import { defaultDatabasePath } from './paths.mjs';
import { searchWeb, searchStatus, searchConfig } from './search.mjs';
import { completeJson, modelConfig } from './model.mjs';
import { fetchPublicPage } from './source-fetch.mjs';
import { AppError, requireValue, text, publicUrl, accountInput, factoryInput, parseCsv } from './validation.mjs';

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
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', '请求需为 JSON。', undefined, 415);
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
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      requireValue(hosts.includes(req.headers.host), '仅允许从本机地址访问。', undefined, 403, 'LOCAL_ONLY');
      requireValue(!req.headers.origin || req.headers.origin === `http://${req.headers.host}`, '跨来源请求已拒绝。', undefined, 403, 'ORIGIN_REJECTED');
      requireValue(req.headers['sec-fetch-site'] !== 'cross-site', '跨站请求已拒绝。', undefined, 403, 'ORIGIN_REJECTED');
      const url = new URL(req.url, `http://${req.headers.host}`);
      const route = url.pathname;
      const method = req.method;
      if (route.startsWith('/api/v1/auth/')) {
        const body = method === 'POST' ? await bodyOf(req, 16384) : {};
        const result = await auth.handle(req, res, route.slice('/api/v1/auth'.length), method, body);
        return json(res, result.status, result.body);
      }
      let requestBody = {};
      if (route.startsWith('/api/')) {
        auth.requireSession(req);
        if (['POST', 'PUT', 'PATCH'].includes(method)) requestBody = await bodyOf(req);
        // Recheck after waiting for a request body: logout/password rotation may have revoked it.
        auth.requireSession(req);
      }
      if (route === '/api/v1/workspace' && method === 'GET') {
        const modelReady = services.modelConfig().configured;
        let searchReady = false;
        try { searchReady = (await services.searchStatus()).reachable; } catch { searchReady = false; }
        return json(res, 200, {
          organization: { id: ORG, name: 'LANCCO 本地工作空间' }, mode: 'LOCAL_SINGLE_USER',
          factory: profile(db), sources: sourceNotes,
          integrations: {
            model: { status: modelReady ? 'CONNECTED' : 'NOT_CONNECTED', label: '模型网关', detail: modelReady ? `已配置模型 ${services.modelConfig().name}，用于自动发现候选筛选。` : '未配置模型网关；自动发现不可用。' },
            search: { status: searchReady ? 'CONNECTED' : 'NOT_CONNECTED', label: '搜索服务', detail: searchReady ? '本地 SearXNG 已连接，用于公开网页发现。' : '本地 SearXNG 未连接；自动发现不可用。' },
          },
          counts: {
            accounts: db.prepare('SELECT count(*) AS n FROM accounts WHERE organization_id = ?').get(ORG).n,
            evidence: db.prepare('SELECT count(*) AS n FROM evidence WHERE organization_id = ?').get(ORG).n,
          },
        });
      }
      if (route === '/api/v1/factory-profile' && method === 'PUT') {
        const body = requestBody; const data = factoryInput(body);
        const saved = transaction(db, () => {
          const current = profile(db); checkVersion(current, body);
          db.prepare('UPDATE factory_profiles SET data = ?, status = ?, version = version + 1, updated_at = ? WHERE organization_id = ?')
            .run(JSON.stringify(data), 'DRAFT', new Date().toISOString(), ORG);
          reassessQualified(db, '工厂档案已更新，需重新确认匹配条件。');
          reconcileApprovals(db);
          audit(db, 'FACTORY_DRAFT_SAVED', ORG); return profile(db);
        });
        return json(res, 200, saved);
      }
      if (route === '/api/v1/factory-profile/activate' && method === 'POST') {
        const body = requestBody;
        const saved = transaction(db, () => {
          const current = profile(db); checkVersion(current, body);
          requireValue(current.status === 'DRAFT', '当前版本已启用。', undefined, 409, 'INVALID_TRANSITION');
          requireValue(current.supported_products.includes('LAUNDRY_PODS') && current.target_markets.includes('US') && current.service_type.length,
            '请先填写服务类型，并确认支持洗衣凝珠和美国市场。', 'target_markets');
          requireValue(body.confirmed === true, '需要负责人确认基础承接能力。', 'confirmed');
          const now = new Date().toISOString();
          db.prepare('UPDATE factory_profiles SET status = ?, version = version + 1, updated_at = ? WHERE organization_id = ?').run('ACTIVE', now, ORG);
          const result = profile(db);
          db.prepare('INSERT INTO factory_profile_versions VALUES (?, ?, ?, ?)').run(ORG, result.version, JSON.stringify(result), now);
          audit(db, 'FACTORY_ACTIVATED', ORG); return result;
        });
        return json(res, 200, saved);
      }
      if (route === '/api/v1/factory-profile/history' && method === 'GET') {
        return json(res, 200, { items: db.prepare('SELECT version, published_at FROM factory_profile_versions WHERE organization_id = ? ORDER BY version DESC').all(ORG) });
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
          .get(ORG, ...filterParams).n;
        const rows = cursor === null
          ? db.prepare(`${base} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(ORG, ...filterParams, limit + 1)
          : db.prepare(`${base} AND ${olderThan('a.created_at', 'a.id')} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
            .all(ORG, ...filterParams, cursor[0], cursor[0], cursor[1], limit + 1);
        return json(res, 200, { ...pageRows(rows, limit, row => [row.created_at, row.id]), total });
      }
      if (route === '/api/v1/accounts/options' && method === 'GET') {
        return json(res, 200, { items: db.prepare('SELECT id, brand_name FROM accounts WHERE organization_id=? ORDER BY brand_name, id').all(ORG) });
      }
      if (route === '/api/v1/accounts' && method === 'POST') {
        const data = accountInput(requestBody);
        const result = transaction(db, () => addAccount(db, data));
        return json(res, result.status === 'CREATED' ? 201 : result.status === 'NEEDS_REVIEW' ? 202 : 200, result);
      }
      if (route === '/api/v1/accounts/imports' && method === 'POST') {
        const rows = parseCsv((requestBody).csv);
        const results = transaction(db, () => rows.map(row => {
          try {
            requireValue(row.valid, '列数与表头不一致。', 'csv');
            return { row: row.row, brand_name: row.data.brand_name, ...addAccount(db, accountInput(row.data)) };
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            return { row: row.row, brand_name: row.data.brand_name, status: 'FAILED', reason: error.message };
          }
        }));
        return json(res, 200, { results, counts: Object.fromEntries(['CREATED', 'SKIPPED', 'NEEDS_REVIEW', 'FAILED'].map(s => [s, results.filter(r => r.status === s).length])) });
      }
      if (/^\/api\/v1\/accounts\/[^/]+$/.test(route) || /^\/api\/v1\/account-identity-reviews(?:\/[^/]+\/resolve)?$/.test(route)) {
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        const result = accountsApi(db, route.slice('/api/v1'.length), method, body, url.searchParams);
        return json(res, result.status, result.body);
      }
      if (route === '/api/v1/sources/preview' && method === 'POST') {
        const result = await previewSource(db, requestBody, requestId);
        return json(res, result.status, result.body);
      }
      if (/^\/api\/v1\/sources(?:\/|$)/.test(route)) {
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        const result = sourcesApi(db, route.slice('/api/v1'.length), method, body, url.searchParams);
        return json(res, result.status, result.body);
      }
      if (route === '/api/v1/evidence/imports' && method === 'POST') {
        return json(res, 200, importEvidence(db, requestBody));
      }
      if (route.startsWith('/api/v1/exports/') && method === 'GET') {
        const result = exportCsv(db, route.slice('/api/v1/exports/'.length));
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${result.filename}"` });
        return res.end(result.content);
      }
      if (route === '/api/v1/evidence' && method === 'GET') {
        const { limit, cursor } = pageParams(url.searchParams);
        const base = `SELECT e.*, a.brand_name, p.product_name, p.product_category, p.status AS product_status FROM evidence e JOIN accounts a ON a.id=e.account_id AND a.organization_id=e.organization_id LEFT JOIN account_products p ON p.id=e.product_id AND p.organization_id=e.organization_id
          WHERE e.organization_id=?`;
        const rows = cursor === null
          ? db.prepare(`${base} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(ORG, limit + 1)
          : db.prepare(`${base} AND ${olderThan('e.created_at', 'e.id')} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`)
            .all(ORG, cursor[0], cursor[0], cursor[1], limit + 1);
        return json(res, 200, pageRows(rows, limit, row => [row.created_at, row.id]));
      }
      if (route === '/api/v1/evidence' && method === 'POST') {
        const body = requestBody;
        const result = transaction(db, () => addEvidence(db, body));
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (/^\/api\/v1\/accounts\/[^/]+\/products(?:\/[^/]+)?$/.test(route) || /^\/api\/v1\/evidence\/[^/]+\/product$/.test(route)) {
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        const result = productsApi(db, route.slice('/api/v1'.length), method, body, url.searchParams);
        return json(res, result.status, result.body);
      }
      if ((route.match(/^\/api\/v1\/opportunities\/([^/]+)\/drafts\/generate$/)) && method === 'POST') {
        const result = await generateDraft(db, route.match(/^\/api\/v1\/opportunities\/([^/]+)\/drafts\/generate$/)[1], requestBody, services);
        return json(res, result.status, result.body);
      }
      if (/^\/api\/v1\/drafts\//.test(route) || /^\/api\/v1\/opportunities\/[^/]+\/drafts$/.test(route) || route === '/api/v1/factory-profile/checks' || route === '/api/v1/factory-profile/checks/options') {
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        const result = draftsApi(db, route.slice('/api/v1'.length), method, body, url.searchParams);
        return json(res, result.status, result.body);
      }
      if ((route === '/api/v1/contacts' && method === 'GET') || /^\/api\/v1\/contacts\/[^/]+$/.test(route) || route === '/api/v1/contact-suppressions') {
        const body = method === 'PATCH' ? requestBody : {};
        const result = contactsApi(db, route.slice('/api/v1'.length), method, body, url.searchParams);
        return json(res, result.status, result.body);
      }
      if (/^\/api\/v1\/(opportunities|contacts)(\/|$)/.test(route) || /^\/api\/v1\/evidence\/[^/]+\/(verify|invalidate|purge)$/.test(route)) {
        const body = method === 'POST' ? requestBody : {};
        if (req.headers['idempotency-key']) body.idempotency_key = req.headers['idempotency-key'];
        const result = salesApi(db, route.slice('/api/v1'.length), method, body, url.searchParams);
        if (route.endsWith('/purge')) {
          try { db.exec('VACUUM'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
          catch (error) { console.error(`[${requestId}] purge compaction failed: ${error.message}`); }
        }
        return json(res, result.status, result.body);
      }
      if (route === '/api/v1/audit-logs' && method === 'GET') {
        const result = auditApi(db, route.slice('/api/v1'.length), method, url.searchParams);
        return json(res, result.status, result.body);
      }
      if (/^\/api\/v1\/follow-up-tasks(\/|$)/.test(route) || route === '/api/v1/analytics/funnel') {
        const body = ['POST', 'PATCH'].includes(method) ? requestBody : {};
        if (req.headers['idempotency-key']) body.idempotency_key = req.headers['idempotency-key'];
        const result = trackingApi(db, route.slice('/api/v1'.length), method, body, url.searchParams);
        return json(res, result.status, result.body);
      }
      if (route.startsWith('/api/v1/research-jobs')) {
        const body = method === 'POST' ? requestBody : {};
        if (req.headers['idempotency-key']) body.idempotency_key = req.headers['idempotency-key'];
        const result = await researchApi(db, route.slice('/api/v1'.length), method, body, url.searchParams, services);
        return json(res, result.status, result.body);
      }
      if (route.startsWith('/api/')) throw new AppError(404, 'NOT_FOUND', '接口不存在。');
      const asset = assets.get(route);
      if (!asset || method !== 'GET') throw new AppError(404, 'NOT_FOUND', '页面不存在。');
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
      res.end(await readFile(resolve(publicDir, asset[0])));
    } catch (error) {
      if (!(error instanceof AppError)) console.error(`[${requestId}]`, error.message);
      if (!res.headersSent) json(res, error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : '保存失败，请重试。', field: error.field, request_id: requestId } });
      else res.end();
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
  server.listen(port, '127.0.0.1', () => console.log(`Botein local workspace: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
