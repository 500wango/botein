import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from './server.mjs';
import { htmlToText, isBlockedAddress } from './source-fetch.mjs';
import { backupDatabase } from './maintenance.mjs';
import { pageParams } from './pagination.mjs';
import { sourceMatchesHost } from './sources.mjs';

const fixturePassword = randomUUID() + randomUUID();
const offlineServices = {
  searchWeb: async () => { throw new Error('search offline'); },
  searchStatus: async () => ({ configured: true, reachable: false, base: 'offline' }),
  fetchPage: async () => { throw new Error('fetch offline'); },
  completeJson: async () => { throw new Error('model offline'); },
  modelConfig: () => ({ configured: false, name: '' }),
  searchBase: 'offline',
};
async function runApp(databasePath, { authenticate = true, services = offlineServices } = {}) {
  const app = createApplication({ databasePath, services });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const fetchApi = async (path, options = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, { ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetchApi(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  if (authenticate) {
    const state = await request('/auth/status');
    const login = await request(state.body.setup_required ? '/auth/setup' : '/auth/login', 'POST', { username: 'test-owner', display_name: 'Test owner', password: fixturePassword });
    assert.ok([200, 201].includes(login.status), JSON.stringify(login.body));
  }
  return { ...app, base, request, fetch: fetchApi, get cookie() { return cookie; },
    close: async () => { await new Promise(resolve => app.server.close(resolve)); app.db.close(); },
  };
}
async function waitForJob(app, id, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const job = (await app.request(`/research-jobs/${id}`)).body;
    if (['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`research job ${id} did not finish`);
}

test('local main path: factory version → activation → CSV brands → raw evidence survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'botein-'));
  const path = join(dir, 'test.sqlite'); let app;
  try {
    app = await runApp(path);
    const initial = (await app.request('/workspace')).body;
    assert.equal(initial.factory.status, 'DRAFT'); assert.equal(initial.counts.accounts, 0);
    const saved = await app.request('/factory-profile', 'PUT', { ...initial.factory, target_markets: ['US'], expected_version: initial.factory.version });
    assert.equal(saved.status, 200);
    const active = await app.request('/factory-profile/activate', 'POST', { expected_version: saved.body.version, confirmed: true });
    assert.equal(active.body.status, 'ACTIVE'); assert.equal(active.body.moq_quantity, null);
    const csv = '\uFEFFbrand_name,website,notes\r\n"Example, Brand",https://example.com,"First line\nSecond line"\r\n"Example, Brand",https://www.example.com,Duplicate\r\nOther brand,https://example.com,Ambiguous\r\nInvalid,not-a-url,Invalid';
    const imported = await app.request('/accounts/imports', 'POST', { csv });
    assert.deepEqual(imported.body.counts, { CREATED: 1, SKIPPED: 1, NEEDS_REVIEW: 1, FAILED: 1 });
    const brands = (await app.request('/accounts')).body.items;
    assert.equal(brands.length, 1); assert.equal(brands[0].notes, 'First line\nSecond line');
    const evidence = { account_id: brands[0].id, source_url: 'https://example.com/product', raw_text: 'A product page, not a purchasing request.', published_at: '' };
    assert.equal((await app.request('/evidence', 'POST', evidence)).status, 201);
    assert.equal((await app.request('/evidence', 'POST', evidence)).status, 200);
    await app.close(); app = await runApp(path);
    assert.equal((await app.request('/workspace')).body.factory.status, 'ACTIVE');
    const stored = (await app.request('/evidence')).body.items;
    assert.equal(stored.length, 1); assert.equal(stored[0].verification_status, 'UNVERIFIED');
    assert.equal(stored[0].raw_text, evidence.raw_text);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('blocked research path: validation and deferred integrations never produce a fake job', async () => {
  const app = await runApp(':memory:');
  try {
    assert.equal((await app.request('/research-jobs', 'POST', { market: 'US' })).body.error.code, 'FACTORY_NOT_ACTIVE');
    const p = (await app.request('/workspace')).body.factory;
    assert.equal((await app.request('/factory-profile/activate', 'POST', { expected_version: p.version, confirmed: true })).status, 422);
    const saved = (await app.request('/factory-profile', 'PUT', { ...p, target_markets: ['US'], expected_version: p.version })).body;
    assert.equal((await app.request('/factory-profile', 'PUT', { ...p, expected_version: p.version })).status, 409);
    await app.request('/factory-profile/activate', 'POST', { expected_version: saved.version, confirmed: true });
    const result = await app.request('/research-jobs', 'POST', { market: 'US', quantity: 20 });
    assert.equal(result.status, 503); assert.equal(result.body.error.code, 'SEARCH_UNAVAILABLE');
    assert.deepEqual((await app.request('/research-jobs')).body.items, []);
    assert.equal((await app.request('/accounts', 'POST', { brand_name: 'bad', website: 'http://127.0.0.1' })).status, 422);
    assert.equal((await app.request('/accounts', 'POST', { brand_name: 'bad', website: 'https://example.com' }, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await app.request('/accounts')).body.items.length, 0);
  } finally { await app.close(); }
});

async function prepareOpportunity(app) {
  const p = (await app.request('/workspace')).body.factory;
  const saved = (await app.request('/factory-profile', 'PUT', { ...p, target_markets: ['US'], expected_version: p.version })).body;
  await app.request('/factory-profile/activate', 'POST', { expected_version: saved.version, confirmed: true });
  const brand = (await app.request('/accounts', 'POST', { brand_name: 'Sample', website: 'https://example.com' })).body;
  const proof = (await app.request('/evidence', 'POST', { account_id: brand.id, source_url: 'https://example.com/us/pods', raw_text: 'Sample branded laundry pods offered in US. Source for manual review.' })).body;
  let item = (await app.request('/opportunities', 'POST', { account_id: brand.id, reason: '产品品类与工厂相关，需核实美国在售。' })).body;
  item = (await app.request(`/opportunities/${item.id}/transitions`, 'POST', { action: 'START_REVIEW', expected_version: item.version, reason: '开始核对公开信息。' })).body;
  return { brand, proof, item, qualify: { action: 'QUALIFY', expected_version: item.version, reason: '原文显示本品牌洗衣凝珠在美国销售，值得联系。', product_evidence_id: proof.id, market_evidence_id: proof.id, reason_evidence_id: proof.id, no_known_conflict: true, facts_confirmed: true, pending_info: '采购量、MOQ和包装待确认。' } };
}

test('manual sales main path: verified evidence → qualified lead → contact → idempotent activity and historical backfill', async () => {
  const app = await runApp(':memory:');
  try {
    const { brand, proof, item, qualify } = await prepareOpportunity(app);
    assert.equal((await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: 1, reason: '已核对原始页面与品牌归属。', confirmed: true })).status, 200);
    const qualified = await app.request(`/opportunities/${item.id}/transitions`, 'POST', qualify);
    assert.equal(qualified.body.qualification_status, 'QUALIFIED'); assert.equal(qualified.body.fit_status, 'NEEDS_REVIEW');
    const person = (await app.request('/contacts', 'POST', { account_id: brand.id, full_name: 'Procurement team', job_title: 'Procurement', email: 'BUYER@example.com', source_url: 'https://example.com/contact' })).body;
    assert.equal(person.verification_status, 'UNVERIFIED');
    assert.equal((await app.request(`/contacts/${person.id}/verify`, 'POST', { expected_version: person.version, reason: '已核对职能及公开邮箱。', confirmed: true })).body.verification_status, 'VERIFIED');
    const send = { expected_version: qualified.body.version, contact_id: person.id, activity_type: 'EMAIL_SENT', occurred_at: new Date(Date.now() - 120000).toISOString(), sent_confirmed: true, notes: 'Sent externally.' };
    const headers = { 'Idempotency-Key': 'sent-once' };
    assert.equal((await app.request(`/opportunities/${item.id}/activities`, 'POST', send, headers)).body.sales_stage, 'CONTACTED');
    assert.equal((await app.request(`/opportunities/${item.id}/activities`, 'POST', send, headers)).body.replayed, true);
    let detail = (await app.request(`/opportunities/${item.id}`)).body;
    const sample = (await app.request(`/opportunities/${item.id}/activities`, 'POST', { expected_version: detail.version, activity_type: 'SAMPLE_REQUESTED', occurred_at: new Date(Date.now() - 60000).toISOString(), idempotency_key: 'sample-once' })).body;
    assert.equal(sample.sales_stage, 'SAMPLE');
    detail = (await app.request(`/opportunities/${item.id}`)).body;
    const olderSend = await app.request(`/opportunities/${item.id}/activities`, 'POST', { ...send, expected_version: detail.version, occurred_at: new Date(Date.now() - 240000).toISOString(), idempotency_key: 'older-email' });
    assert.equal(olderSend.body.sales_stage, 'SAMPLE');
    detail = (await app.request(`/opportunities/${item.id}`)).body;
    assert.equal(detail.activities.length, 3);
    assert.equal((await app.request(`/opportunities/${item.id}/activities/${sample.id}/void`, 'POST', { expected_version: detail.version, reason: '样品请求误录。' })).body.sales_stage, 'CONTACTED');
    const reused = (await app.request('/opportunities', 'POST', { account_id: brand.id, reason: '另一次发现。' })).body;
    assert.equal(reused.id, item.id); assert.equal(reused.qualification_status, 'QUALIFIED');
  } finally { await app.close(); }
});

test('invalid support fails qualification; invalidation forces reassessment and duplicate contacts retain suppression', async () => {
  const app = await runApp(':memory:');
  try {
    const { brand, proof, item, qualify } = await prepareOpportunity(app);
    assert.equal((await app.request(`/opportunities/${item.id}/transitions`, 'POST', qualify)).status, 422);
    await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: 1, reason: '已核对原始来源。', confirmed: true });
    const wrong = (await app.request('/accounts', 'POST', { brand_name: 'Other', website: 'https://example.org' })).body;
    const wrongProof = (await app.request('/evidence', 'POST', { account_id: wrong.id, source_url: 'https://example.org', raw_text: 'Other brand.' })).body;
    await app.request(`/evidence/${wrongProof.id}/verify`, 'POST', { expected_version: 1, reason: '已核对。', confirmed: true });
    assert.equal((await app.request(`/opportunities/${item.id}/transitions`, 'POST', { ...qualify, market_evidence_id: wrongProof.id })).status, 422);
    assert.equal((await app.request(`/opportunities/${item.id}/transitions`, 'POST', qualify)).body.qualification_status, 'QUALIFIED');
    assert.equal((await app.request(`/opportunities/${item.id}/transitions`, 'POST', qualify)).status, 409);
    await app.request(`/evidence/${proof.id}/invalidate`, 'POST', { expected_version: 2, reason: '发现页面归属有误。' });
    const detail = (await app.request(`/opportunities/${item.id}`)).body;
    assert.equal(detail.qualification_status, 'REASSESSMENT_REQUIRED'); assert.equal(detail.sales_stage, 'NOT_STARTED');
    assert.ok(detail.history.some(h => h.action === 'QUALIFY')); assert.ok(detail.history.some(h => h.action === 'REASSESSMENT_REQUIRED'));
    const contactData = { account_id: brand.id, full_name: 'Buyer', email: 'buyer@example.com', source_url: 'https://example.com/contact' };
    const person = (await app.request('/contacts', 'POST', contactData)).body;
    await app.request(`/contacts/${person.id}/suppress`, 'POST', { expected_version: person.version, reason: '对方要求停止联系。' });
    const duplicate = (await app.request('/contacts', 'POST', { ...contactData, email: 'BUYER@example.com' })).body;
    assert.equal(duplicate.id, person.id); assert.equal(duplicate.suppression_reason, '对方要求停止联系。');
    assert.equal((await app.request(`/contacts/${person.id}/verify`, 'POST', { expected_version: duplicate.version, reason: '尝试恢复。', confirmed: true })).status, 422);
    const otherContact = (await app.request('/contacts', 'POST', { ...contactData, account_id: wrong.id })).body;
    assert.equal(otherContact.suppression_reason, '对方要求停止联系。');
  } finally { await app.close(); }
});

test('follow-up and funnel main path: task completion leaves sales intact; quotes deduplicate and voids restate history', async () => {
  const app = await runApp(':memory:');
  try {
    const { proof, item, qualify } = await prepareOpportunity(app);
    await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: 1, reason: '已核对。', confirmed: true });
    await app.request(`/opportunities/${item.id}/transitions`, 'POST', qualify);
    // Simulate an older cohort without waiting or altering the production clock.
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const created = new Date(Date.parse(cutoff) - 3600000).toISOString();
    app.db.prepare('UPDATE opportunities SET created_at=? WHERE id=?').run(created, item.id);
    app.db.prepare('UPDATE opportunity_history SET created_at=? WHERE opportunity_id=?').run(created, item.id);
    const params = new URLSearchParams({ from: created.slice(0, 10), to: created.slice(0, 10), as_of: cutoff });
    const reportPath = `/analytics/funnel?${params}`;
    let current = (await app.request(`/opportunities/${item.id}`)).body;
    const first = await app.request(`/opportunities/${item.id}/activities`, 'POST', { expected_version: current.version, activity_type: 'QUOTATION_SENT', occurred_at: new Date(Date.parse(cutoff) - 600000).toISOString(), idempotency_key: 'quote-a' });
    current = (await app.request(`/opportunities/${item.id}`)).body;
    const second = await app.request(`/opportunities/${item.id}/activities`, 'POST', { expected_version: current.version, activity_type: 'QUOTATION_SENT', occurred_at: new Date(Date.parse(cutoff) - 300000).toISOString(), idempotency_key: 'quote-b' });
    assert.equal((await app.request(reportPath)).body.metrics.quotations, 1);
    const taskBody = { opportunity_id: item.id, title: '确认报价', notes: '不自动发送', due_at: new Date(Date.now() - 60000).toISOString() };
    const task = (await app.request('/follow-up-tasks', 'POST', taskBody, { 'Idempotency-Key': 'follow-once' })).body;
    assert.equal(task.status, 'OPEN');
    assert.equal((await app.request('/follow-up-tasks', 'POST', taskBody, { 'Idempotency-Key': 'follow-once' })).body.replayed, true);
    const done = await app.request(`/follow-up-tasks/${task.id}`, 'PATCH', { expected_version: task.version, status: 'DONE', reason: '已核对下一步。' });
    assert.equal(done.body.status, 'DONE'); assert.ok(done.body.closed_at);
    current = (await app.request(`/opportunities/${item.id}`)).body;
    assert.equal(current.sales_stage, 'QUOTATION'); assert.equal(current.activities.length, 2);
    assert.equal((await app.request('/follow-up-tasks')).body.items.length, 1);
    await app.request(`/opportunities/${item.id}/activities/${first.body.id}/void`, 'POST', { expected_version: current.version, reason: '误录。' });
    current = (await app.request(`/opportunities/${item.id}`)).body;
    await app.request(`/opportunities/${item.id}/activities/${second.body.id}/void`, 'POST', { expected_version: current.version, reason: '误录。' });
    current = (await app.request(`/opportunities/${item.id}`)).body;
    await app.request(`/opportunities/${item.id}/transitions`, 'POST', { expected_version: current.version, action: 'ARCHIVE', reason: '暂缓开发。' });
    const report = (await app.request(reportPath)).body;
    assert.equal(report.metrics.candidates, 1); assert.equal(report.metrics.qualified, 1);
    assert.equal(report.metrics.qualification_rate, 1); assert.equal(report.metrics.quotations, 0);
    assert.equal(report.current.qualified, 0);
  } finally { await app.close(); }
});

test('report and task guards: empty denominator, first rejection, cutoff and stale task changes stay truthful', async () => {
  const app = await runApp(':memory:');
  try {
    assert.equal((await app.request('/analytics/funnel')).body.metrics.qualification_rate, null);
    const { proof, item, qualify } = await prepareOpportunity(app);
    let result = await app.request(`/opportunities/${item.id}/transitions`, 'POST', { expected_version: item.version, action: 'REJECT', reason: '初次证据不足。' });
    const reopened = await app.request(`/opportunities/${item.id}/transitions`, 'POST', { expected_version: result.body.version, action: 'REOPEN', reason: '重新核对。' });
    await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: 1, reason: '核对新依据。', confirmed: true });
    await app.request(`/opportunities/${item.id}/transitions`, 'POST', { ...qualify, expected_version: reopened.body.version });
    const report = (await app.request('/analytics/funnel')).body;
    assert.equal(report.metrics.reviewed, 1); assert.equal(report.metrics.qualified, 0);
    assert.equal(report.metrics.qualification_rate, 0); assert.equal(report.current.qualified, 1);
    assert.equal((await app.request('/analytics/funnel?from=2000-01-01&to=2000-01-02')).body.metrics.candidates, 0);
    assert.equal((await app.request('/analytics/funnel?from=2026-02-30')).status, 422);
    assert.equal((await app.request('/analytics/funnel?as_of=2999-01-01T00:00:00.000Z')).status, 422);
    const data = { opportunity_id: item.id, title: '跟进资料', due_at: new Date().toISOString(), idempotency_key: 'task-conflict' };
    const task = (await app.request('/follow-up-tasks', 'POST', data)).body;
    assert.equal((await app.request('/follow-up-tasks', 'POST', { ...data, title: '不同内容' })).status, 409);
    assert.equal((await app.request('/follow-up-tasks', 'POST', { ...data, due_at: '2026-02-30T10:00:00Z', idempotency_key: 'bad-date' })).status, 422);
    result = await app.request(`/follow-up-tasks/${task.id}`, 'PATCH', { expected_version: 1, status: 'CANCELLED', reason: '不再需要。' });
    assert.equal(result.status, 200);
    assert.equal((await app.request(`/follow-up-tasks/${task.id}`, 'PATCH', { expected_version: 1, status: 'DONE', reason: '旧窗口。' })).status, 409);
    assert.equal((await app.request('/follow-up-tasks')).body.items[0].status, 'CANCELLED');
  } finally { await app.close(); }
});

async function prepareDraft(app) {
  const { brand, proof, item, qualify } = await prepareOpportunity(app);
  await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: 1, reason: '核对原文。', confirmed: true });
  await app.request(`/opportunities/${item.id}/transitions`, 'POST', qualify);
  const person = (await app.request('/contacts', 'POST', { account_id: brand.id, full_name: 'Buyer team', email: 'buyer@example.com', source_url: 'https://example.com/contact' })).body;
  await app.request(`/contacts/${person.id}/verify`, 'POST', { expected_version: 1, reason: '公开职能及渠道已核对。', confirmed: true });
  const factory = (await app.request('/workspace')).body.factory;
  const check = (await app.request('/factory-profile/checks', 'POST', { expected_version: factory.version, field: 'service_type', reason: '负责人确认 OEM/ODM 服务范围。', confirmed: true })).body;
  const input = { contact_id: person.id, subject: 'Laundry pod production', body: 'Your brand offers laundry pods in the US. We offer OEM and ODM services. May we discuss your product plans?', claims: [
    { text: 'Your brand offers laundry pods in the US.', kind: 'EVIDENCE', evidence_id: proof.id, quote: 'Sample branded laundry pods offered in US.', time_sensitive: true },
    { text: 'We offer OEM and ODM services.', kind: 'FACTORY', check_id: check.id },
  ] };
  const result = await app.request(`/opportunities/${item.id}/drafts`, 'POST', input);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { item, proof, person, input, draft: result.body };
}
async function approveDraft(app, draft) {
  return app.request(`/drafts/${draft.id}/review`, 'POST', { expected_version: draft.version, draft_version_id: draft.current_version_id, action: 'APPROVE', reason: '全文与每条引用已人工核对。', full_text_confirmed: true, claims_confirmed: true });
}

test('draft lifecycle: manual approval, checked copy, immutable edits and historical send linkage survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'botein-drafts-')); let app;
  try {
    const path = join(dir, 'drafts.sqlite'); app = await runApp(path);
    const { item, person, input, draft } = await prepareDraft(app);
    const checks = (await app.request('/factory-profile/checks')).body;
    assert.equal(checks.total, 1);
    assert.equal((await app.request('/factory-profile/checks/options')).body.items.length, 1);
    const approved = (await approveDraft(app, draft)).body;
    assert.equal(approved.status, 'APPROVED'); assert.equal(approved.claims[0].validation_status, 'SUPPORTED');
    const copy = await app.request(`/drafts/${draft.id}/copy-events`, 'POST', { expected_version: approved.version, draft_version_id: approved.current_version_id, part: 'body' });
    assert.equal(copy.status, 200); assert.equal(copy.body.content, input.body);
    let detail = (await app.request(`/opportunities/${item.id}`)).body;
    assert.equal(detail.sales_stage, 'NOT_STARTED'); assert.equal(detail.activities.length, 0);
    const changed = await app.request(`/drafts/${draft.id}`, 'PATCH', { ...input, subject: 'Updated laundry proposal', expected_version: approved.version });
    assert.equal(changed.status, 200); assert.equal(changed.body.status, 'IN_REVIEW');
    assert.equal(changed.body.versions[1].status, 'SUPERSEDED'); assert.equal(changed.body.versions[1].subject, input.subject);
    assert.equal((await app.request(`/drafts/${draft.id}/copy-events`, 'POST', { expected_version: approved.version, draft_version_id: approved.current_version_id, part: 'body' })).status, 409);
    assert.equal((await approveDraft(app, changed.body)).body.status, 'APPROVED');
    const sent = await app.request(`/opportunities/${item.id}/activities`, 'POST', { activity_type: 'EMAIL_SENT', expected_version: detail.version, contact_id: person.id, draft_version_id: approved.current_version_id, occurred_at: new Date().toISOString(), notes: 'Sent old version before edit.', sent_confirmed: true, idempotency_key: 'send-linked-version' });
    assert.equal(sent.status, 201);
    // A sales activity increments opportunity.version but does not invalidate qualification approval.
    assert.equal((await app.request(`/drafts/${draft.id}`)).body.status, 'APPROVED');
    await app.close(); app = await runApp(path);
    detail = (await app.request(`/opportunities/${item.id}`)).body;
    assert.equal(detail.activities[0].draft_version_id, approved.current_version_id);
    assert.equal((await app.request(`/drafts/${draft.id}`)).body.versions.length, 2);
    const factory = (await app.request('/workspace')).body.factory;
    await app.request('/factory-profile', 'PUT', { ...factory, notes: '能力待重新核对。', expected_version: factory.version });
    assert.equal((await app.request(`/drafts/${draft.id}`)).body.status, 'IN_REVIEW');
    assert.equal((await app.request(`/opportunities/${item.id}`)).body.activities[0].draft_version_id, approved.current_version_id);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('draft dependency guard: unverified claims, expired facts, evidence invalidation and suppression revoke old approval', async () => {
  const app = await runApp(':memory:');
  try {
    const { item, proof, person, input, draft } = await prepareDraft(app);
    const unverified = (await app.request('/evidence', 'POST', { account_id: item.account_id, source_url: 'https://example.com/new', raw_text: 'Unsupported claim source.' })).body;
    const badDraft = (await app.request(`/opportunities/${item.id}/drafts`, 'POST', { ...input, body: 'Unverified claim.', claims: [{ text: 'Unverified claim.', kind: 'EVIDENCE', evidence_id: unverified.id, quote: 'Unsupported claim source.' }] })).body;
    assert.equal((await approveDraft(app, badDraft)).status, 422);
    let approved = (await approveDraft(app, draft)).body;
    app.db.prepare('UPDATE evidence SET checked_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', proof.id);
    assert.equal((await app.request(`/drafts/${draft.id}/copy-events`, 'POST', { expected_version: approved.version, draft_version_id: approved.current_version_id, part: 'body' })).status, 409);
    assert.equal((await app.request(`/drafts/${draft.id}`)).body.status, 'IN_REVIEW');
    await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: 2, reason: '重新核对时效。', confirmed: true });
    let current = (await app.request(`/drafts/${draft.id}`)).body;
    current = (await app.request(`/drafts/${draft.id}`, 'PATCH', { ...input, expected_version: current.version })).body;
    approved = (await approveDraft(app, current)).body;
    assert.equal(approved.status, 'APPROVED');
    const otherPerson = (await app.request('/contacts', 'POST', { account_id: item.account_id, full_name: 'Other buyer', email: 'other@example.com', source_url: 'https://example.com/team' })).body;
    await app.request(`/contacts/${otherPerson.id}/verify`, 'POST', { expected_version: 1, reason: '核对身份。', confirmed: true });
    const otherDraft = (await app.request(`/opportunities/${item.id}/drafts`, 'POST', { ...input, contact_id: otherPerson.id })).body;
    assert.equal((await approveDraft(app, otherDraft)).body.status, 'APPROVED');
    await app.request(`/contacts/${otherPerson.id}/suppress`, 'POST', { expected_version: 2, reason: '停止联系。' });
    assert.equal((await app.request(`/drafts/${otherDraft.id}`)).body.status, 'BLOCKED');
    await app.request(`/evidence/${proof.id}/invalidate`, 'POST', { expected_version: 3, reason: '发现来源归属错误。' });
    assert.equal((await app.request(`/drafts/${draft.id}`)).body.status, 'BLOCKED');
    assert.equal((await app.request(`/opportunities/${item.id}`)).body.qualification_status, 'REASSESSMENT_REQUIRED');
    await app.request(`/contacts/${person.id}/suppress`, 'POST', { expected_version: 2, reason: '对方要求停止联系。' });
    assert.equal((await app.request(`/drafts/${draft.id}/copy-events`, 'POST', { expected_version: approved.version, draft_version_id: approved.current_version_id, part: 'body' })).status, 409);
    assert.equal((await app.request(`/opportunities/${item.id}/drafts`, 'POST', input)).status, 422);
    const reviews = (await app.request(`/drafts/${draft.id}`)).body.reviews;
    assert.ok(reviews.some(r => r.action === 'APPROVE')); assert.ok(reviews.some(r => r.action === 'APPROVAL_INVALIDATED'));
    assert.equal((await app.request(`/opportunities/${item.id}`)).body.activities.length, 0);
  } finally { await app.close(); }
});

test('product main path: scoped SKU identity, original URL, optional evidence attribution and restart persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'botein-products-')); let app;
  try {
    const path = join(dir, 'products.sqlite'); app = await runApp(path);
    const brand = (await app.request('/accounts', 'POST', { brand_name: 'Product brand', website: 'https://example.com' })).body;
    const data = { product_name: 'Laundry pods 30 pack', product_category: 'LAUNDRY_PODS', product_url: 'https://example.com/pods?pack=30#details', external_sku: 'POD-30', marketplace: 'Official store', packaging_type: '30 pods / bag', notes: '', status: 'ACTIVE' };
    const result = await app.request(`/accounts/${brand.id}/products`, 'POST', data);
    assert.equal(result.status, 201, JSON.stringify(result.body)); const product = result.body;
    assert.equal(product.product_url, data.product_url); assert.equal(product.normalized_url, 'https://example.com/pods?pack=30');
    assert.equal((await app.request(`/accounts/${brand.id}/products`, 'POST', data)).body.id, product.id);
    const raw = { account_id: brand.id, product_id: product.id, source_url: 'https://example.com/pods', raw_text: 'This product contains 30 laundry pods.' };
    const proof = (await app.request('/evidence', 'POST', raw)).body;
    assert.equal((await app.request('/evidence', 'POST', raw)).body.duplicate, true);
    await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: 1, reason: '核对产品原文与品牌归属。', confirmed: true });
    const noteEdit = await app.request(`/accounts/${brand.id}/products/${product.id}`, 'PATCH', { ...data, notes: 'Internal follow-up note.', expected_version: 1, reason: '仅补充内部备注。' });
    assert.equal(noteEdit.status, 200);
    assert.equal((await app.request('/evidence')).body.items[0].verification_status, 'VERIFIED');
    const unlinked = await app.request(`/evidence/${proof.id}/product`, 'PATCH', { expected_version: 2, product_id: null, reason: '具体 SKU 未确认，先保留品牌层级。' });
    assert.equal(unlinked.body.product_id, null); assert.equal(unlinked.body.raw_text, raw.raw_text);
    assert.equal(unlinked.body.verification_status, 'UNVERIFIED');
    const linked = await app.request(`/evidence/${proof.id}/product`, 'PATCH', { expected_version: unlinked.body.version, product_id: product.id, reason: '核对后重新关联对应产品。' });
    assert.equal(linked.body.product_version, 2);
    await app.close(); app = await runApp(path);
    const stored = (await app.request('/evidence')).body.items[0];
    assert.equal(stored.product_id, product.id); assert.equal(stored.product_name, data.product_name);
    assert.equal(stored.raw_text, raw.raw_text);
    const history = (await app.request(`/accounts/${brand.id}/products/${product.id}`)).body.history;
    assert.equal(history.length, 2); assert.equal(history[0].details.before.product_url, data.product_url);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('product attribution guard: cross-brand links and conflicts fail; core changes revoke qualification and draft approval', async () => {
  const app = await runApp(':memory:');
  try {
    const { item, proof, input: draftInput, draft } = await prepareDraft(app);
    let approved = (await approveDraft(app, draft)).body;
    const data = { product_name: 'Pods', product_category: 'LAUNDRY_PODS', product_url: 'https://example.com/pods', external_sku: 'SKU1', marketplace: 'store', notes: '', packaging_type: '', status: 'ACTIVE' };
    const product = (await app.request(`/accounts/${item.account_id}/products`, 'POST', data)).body;
    const otherBrand = (await app.request('/accounts', 'POST', { brand_name: 'Other products', website: 'https://example.org' })).body;
    const otherProduct = (await app.request(`/accounts/${otherBrand.id}/products`, 'POST', { ...data, product_url: 'https://example.org/pods' })).body;
    assert.notEqual(product.id, otherProduct.id);
    assert.equal((await app.request(`/evidence/${proof.id}/product`, 'PATCH', { expected_version: 2, product_id: otherProduct.id, reason: '错误跨品牌关联。' })).status, 404);
    assert.equal((await app.request('/evidence', 'POST', { account_id: item.account_id, product_id: otherProduct.id, raw_text: 'Mismatch.' })).status, 404);
    assert.equal((await app.request(`/accounts/${item.account_id}/products`, 'POST', { ...data, product_url: 'https://example.com/other' })).status, 409);
    const linked = await app.request(`/evidence/${proof.id}/product`, 'PATCH', { expected_version: 2, product_id: product.id, reason: '补充产品归属。' });
    assert.equal(linked.status, 200);
    assert.equal((await app.request(`/drafts/${draft.id}`)).body.status, 'BLOCKED');
    await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: linked.body.version, reason: '核对新的产品归属。', confirmed: true });
    let current = (await app.request(`/opportunities/${item.id}`)).body;
    current = (await app.request(`/opportunities/${item.id}/transitions`, 'POST', { expected_version: current.version, action: 'START_REVIEW', reason: '重新匹配。' })).body;
    const qualify = { expected_version: current.version, action: 'QUALIFY', reason: '同品类且有美国销售依据。', pending_info: '采购量未知。', no_known_conflict: true, facts_confirmed: true, product_evidence_id: proof.id, market_evidence_id: proof.id, reason_evidence_id: proof.id };
    assert.equal((await app.request(`/opportunities/${item.id}/transitions`, 'POST', qualify)).status, 200);
    const beforeEdit = (await app.request(`/drafts/${draft.id}`)).body;
    const newDraft = (await app.request(`/drafts/${draft.id}`, 'PATCH', { ...draftInput, expected_version: beforeEdit.version })).body;
    approved = (await approveDraft(app, newDraft)).body; assert.equal(approved.status, 'APPROVED');
    const changed = await app.request(`/accounts/${item.account_id}/products/${product.id}`, 'PATCH', { ...data, product_category: 'DISHWASHER_TABLETS', expected_version: 1, reason: '发现原产品品类录错。' });
    assert.equal(changed.status, 200);
    const e = (await app.request('/evidence')).body.items[0];
    assert.equal(e.verification_status, 'UNVERIFIED');
    assert.equal((await app.request(`/opportunities/${item.id}`)).body.qualification_status, 'REASSESSMENT_REQUIRED');
    assert.equal((await app.request(`/drafts/${draft.id}`)).body.status, 'BLOCKED');
    assert.equal((await app.request(`/drafts/${draft.id}/copy-events`, 'POST', { expected_version: approved.version, draft_version_id: approved.current_version_id, part: 'body' })).status, 409);
    assert.equal((await app.request(`/accounts/${item.account_id}/products/${product.id}`, 'PATCH', { ...data, expected_version: 1, reason: '旧窗口覆盖。' })).status, 409);
    await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: e.version, reason: '来源真实但属于洗碗块。', confirmed: true });
    current = (await app.request(`/opportunities/${item.id}`)).body;
    current = (await app.request(`/opportunities/${item.id}/transitions`, 'POST', { expected_version: current.version, action: 'START_REVIEW', reason: '核查品类。' })).body;
    assert.equal((await app.request(`/opportunities/${item.id}/transitions`, 'POST', { ...qualify, expected_version: current.version })).status, 422);
  } finally { await app.close(); }
});

test('evidence CSV and export: multiline data, duplicate state preservation, source times and formula-safe snapshots', async () => {
  const app = await runApp(':memory:');
  try {
    const brand = (await app.request('/accounts', 'POST', { brand_name: '=HYPERLINK("x")', website: 'https://example.com', notes: '@review' })).body;
    const observed = new Date(Date.now() - 3600000).toISOString();
    const raw = '=SUM(1,2)\nQuoted "original"';
    const csv = `\uFEFFaccount_id,source_url,raw_text,observed_at,verification_status\r\n${brand.id},https://example.com/review,"${raw.replaceAll('"','""')}",${observed},VERIFIED\r\n`;
    const imported = await app.request('/evidence/imports', 'POST', { csv });
    assert.deepEqual(imported.body.counts, { CREATED: 1, SKIPPED: 0, FAILED: 0 });
    const id = imported.body.results[0].id;
    let e = (await app.request('/evidence')).body.items[0];
    assert.equal(e.raw_text, raw); assert.equal(e.observed_at, observed); assert.equal(e.verification_status, 'UNVERIFIED');
    await app.request(`/evidence/${id}/verify`, 'POST', { expected_version: e.version, reason: 'Manual source check.', confirmed: true });
    const replay = await app.request('/evidence/imports', 'POST', { csv });
    assert.equal(replay.body.counts.SKIPPED, 1); assert.equal(replay.body.results[0].verification_status, 'VERIFIED');
    const exported = await app.fetch('/exports/evidence');
    assert.equal(exported.status, 200); assert.match(exported.headers.get('content-disposition'), /attachment; filename="botein-evidence-/);
    const bytes = new Uint8Array(await exported.arrayBuffer());
    assert.deepEqual([...bytes.slice(0,3)], [239,187,191]);
    const content = new TextDecoder().decode(bytes);
    assert.ok(content.includes('"\'=SUM(1,2)\nQuoted ""original"""'));
    assert.ok(content.includes('"VERIFIED"')); assert.ok(content.includes(observed));
    const accounts = await (await app.fetch('/exports/accounts')).text();
    assert.ok(accounts.includes('"\'=HYPERLINK(""x"")"')); assert.ok(accounts.includes('"\'@review"'));
    e = (await app.request('/evidence')).body.items[0]; assert.equal(e.raw_text, raw); assert.equal(e.version, 2);
    assert.equal(app.db.prepare("SELECT count(*) AS n FROM audit_logs WHERE action='CSV_EXPORT_REQUESTED'").get().n, 2);
  } finally { await app.close(); }
});

test('evidence CSV guard: invalid attribution and timestamps fail by row; exports exclude other organizations', async () => {
  const app = await runApp(':memory:');
  try {
    const a = (await app.request('/accounts', 'POST', { brand_name: 'A', website: 'https://example.com' })).body;
    const b = (await app.request('/accounts', 'POST', { brand_name: 'B', website: 'https://example.org' })).body;
    const p = (await app.request(`/accounts/${b.id}/products`, 'POST', { product_name: 'B pods', product_category: 'LAUNDRY_PODS', product_url: 'https://example.org/pods' })).body;
    const now = new Date(Date.now()-60000).toISOString();
    const csv = ['account_id,product_id,source_url,raw_text,observed_at', `${a.id},,,Valid brand evidence,${now}`, `${a.id},${p.id},,Wrong brand,${now}`, `${a.id},,,Missing time,`, `${a.id},,,Future time,2999-01-01T00:00:00Z`, `missing-id,,,Unknown brand,${now}`].join('\n');
    const result = await app.request('/evidence/imports', 'POST', { csv });
    assert.deepEqual(result.body.counts, { CREATED: 1, SKIPPED: 0, FAILED: 4 });
    assert.equal((await app.request('/evidence')).body.items.length, 1);
    assert.equal((await app.request('/evidence/imports', 'POST', { csv: 'account_id,raw_text\nA,B' })).status, 422);
    assert.equal((await app.request('/evidence/imports', 'POST', { csv: 'account_id,source_url,raw_text,observed_at\n"unclosed' })).status, 422);
    app.db.prepare('INSERT INTO organizations VALUES (?,?)').run('other-org','Other');
    app.db.prepare('INSERT INTO accounts (id,organization_id,brand_name,normalized_name,website,normalized_domain,headquarters_country,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('other-account','other-org','PRIVATE OTHER BRAND','other','https://example.net','example.net','','hidden',now);
    const exported = await (await app.fetch('/exports/accounts')).text();
    assert.ok(!exported.includes('PRIVATE OTHER BRAND')); assert.ok(!exported.includes('other-account'));
    assert.equal((await app.request('/exports/secrets')).status, 404);
    const denied = await app.fetch('/exports/evidence', { headers: { Origin:'https://outside.example' } });
    assert.equal(denied.status, 403);
    const empty = await (await app.fetch('/exports/opportunities')).text();
    assert.equal(empty.trim().split('\r\n').length,1);
  } finally { await app.close(); }
});

test('brand identity main path: pending duplicates persist, explicit decisions create or reuse without merging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'botein-identities-')); let app;
  try {
    const path = join(dir, 'identities.sqlite'); app = await runApp(path);
    const original = (await app.request('/accounts', 'POST', { brand_name: 'Original', website: 'https://example.com', notes: 'Keep original notes.' })).body;
    const candidate = { brand_name: 'Separate', website: 'https://example.com/brand', notes: 'Separate buyer brand.' };
    const queued = await app.request('/accounts', 'POST', candidate);
    assert.equal(queued.status, 202); assert.equal(queued.body.status, 'NEEDS_REVIEW');
    assert.equal((await app.request('/accounts', 'POST', candidate)).body.review_id, queued.body.review_id);
    assert.equal((await app.request('/accounts')).body.items.length, 1);
    await app.close(); app = await runApp(path);
    const identityList = (await app.request('/account-identity-reviews')).body;
    assert.equal(identityList.total, 1); assert.equal(identityList.pending_total, 1);
    const review = identityList.items[0];
    assert.equal(review.status, 'PENDING'); assert.equal(review.candidate.notes, candidate.notes);
    const distinct = await app.request(`/account-identity-reviews/${review.id}/resolve`, 'POST', { expected_version: review.version, action: 'DISTINCT', confirmed: true, reason: '官网确认不同品牌共用域名。' });
    assert.equal(distinct.body.status, 'DISTINCT'); assert.notEqual(distinct.body.resolved_account_id, original.id);
    assert.equal((await app.request('/accounts', 'POST', candidate)).body.id, distinct.body.resolved_account_id);
    const alias = { brand_name: 'Original alias', website: 'https://example.com' };
    const aliasReview = (await app.request('/accounts', 'POST', alias)).body;
    const reused = await app.request(`/account-identity-reviews/${aliasReview.review_id}/resolve`, 'POST', { expected_version: 1, action: 'REUSE', target_account_id: original.id, target_expected_version: 1, confirmed: true, reason: '同一品牌不同写法。' });
    assert.equal(reused.body.status, 'REUSED');
    assert.equal((await app.request('/accounts', 'POST', alias)).body.id, original.id);
    assert.equal((await app.request(`/accounts/${original.id}`)).body.notes, 'Keep original notes.');
    const excluded = { brand_name: 'Unrelated', website: 'https://example.com' };
    const rejected = (await app.request('/accounts', 'POST', excluded)).body;
    await app.request(`/account-identity-reviews/${rejected.review_id}/resolve`, 'POST', { expected_version: 1, action: 'REJECT', reason: '不属于目标品牌。' });
    assert.equal((await app.request('/accounts', 'POST', excluded)).body.status, 'SKIPPED');
    assert.equal((await app.request('/accounts')).body.items.length, 2);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('brand edits reject stale identity decisions and invalidate dependent evidence, contacts and approval only on identity change', async () => {
  const app = await runApp(':memory:');
  try {
    const { item, person, draft } = await prepareDraft(app);
    assert.equal((await approveDraft(app, draft)).body.status, 'APPROVED');
    const original = (await app.request(`/accounts/${item.account_id}`)).body;
    let changed = await app.request(`/accounts/${original.id}`, 'PATCH', { ...original, expected_version: original.version, notes: 'Only internal notes.', reason: '补充备注。' });
    assert.equal(changed.status, 200); assert.equal((await app.request(`/drafts/${draft.id}`)).body.status, 'APPROVED');
    const candidate = { brand_name: 'Alias', website: 'https://example.com' };
    const pending = (await app.request('/accounts', 'POST', candidate)).body;
    assert.equal((await app.request(`/account-identity-reviews/${pending.review_id}/resolve`, 'POST', { expected_version: 1, action: 'REUSE', target_account_id: original.id, target_expected_version: 1, confirmed: true, reason: '旧资料。' })).status, 409);
    const other = (await app.request('/accounts', 'POST', { brand_name: 'Other', website: 'https://example.org' })).body;
    assert.equal((await app.request(`/account-identity-reviews/${pending.review_id}/resolve`, 'POST', { expected_version: 1, action: 'REUSE', target_account_id: other.id, target_expected_version: 1, confirmed: true, reason: '跨域误选。' })).status, 422);
    assert.equal((await app.request(`/account-identity-reviews/${pending.review_id}/resolve`, 'POST', { expected_version: 1, action: 'DISTINCT', reason: '未确认。' })).status, 422);
    changed = await app.request(`/accounts/${original.id}`, 'PATCH', { ...changed.body, expected_version: changed.body.version, brand_name: 'Corrected brand identity', reason: '纠正品牌归属名称。' });
    assert.equal(changed.status, 200);
    assert.equal((await app.request(`/accounts/${original.id}`, 'PATCH', { ...original, expected_version: 1, reason: '过期窗口。' })).status, 409);
    const detail = (await app.request(`/opportunities/${item.id}`)).body;
    assert.equal(detail.qualification_status, 'REASSESSMENT_REQUIRED');
    assert.equal(detail.evidence[0].verification_status, 'UNVERIFIED');
    assert.equal(detail.contacts.find(c => c.id === person.id).verification_status, 'STALE');
    assert.equal((await app.request(`/drafts/${draft.id}`)).body.status, 'BLOCKED');
    const history = (await app.request(`/accounts/${original.id}`)).body.history;
    assert.equal(history[0].details.before.brand_name, original.brand_name);
    assert.equal((await app.request(`/accounts/${original.id}`, 'PATCH', { ...changed.body, brand_name: 'Other', website: 'https://example.org', expected_version: changed.body.version, reason: '误合并。', shared_domain_confirmed: true })).status, 409);
  } finally { await app.close(); }
});

test('contact editing retains historical snapshots and requires new draft content review after identity change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'botein-contact-edit-')); let app;
  try {
    const path = join(dir,'contacts.sqlite'); app = await runApp(path);
    const { item, person, draft, input } = await prepareDraft(app);
    const approved = (await approveDraft(app,draft)).body;
    const detail = (await app.request(`/opportunities/${item.id}`)).body;
    assert.equal((await app.request(`/opportunities/${item.id}/activities`, 'POST', { expected_version:detail.version,activity_type:'EMAIL_SENT',contact_id:person.id,draft_version_id:approved.current_version_id,occurred_at:new Date().toISOString(),sent_confirmed:true,idempotency_key:'snapshot-send' })).status,201);
    const before = (await app.request(`/contacts/${person.id}`)).body;
    const changed = await app.request(`/contacts/${person.id}`,'PATCH',{ ...before,full_name:'Corrected buyer team',job_title:'Product',reason:'纠正公开来源里的职能。',expected_version:before.version });
    assert.equal(changed.status,200); assert.equal(changed.body.verification_status,'STALE');
    const revoked = (await app.request(`/drafts/${draft.id}`)).body;
    assert.equal(revoked.status,'IN_REVIEW'); assert.equal(revoked.contact_snapshot.full_name,person.full_name);
    const historical = (await app.request(`/opportunities/${item.id}`)).body.activities[0];
    assert.equal(historical.full_name,person.full_name); assert.equal(JSON.parse(historical.contact_snapshot).provenance,'AT_RECORDING');
    await app.request(`/contacts/${person.id}/verify`,'POST',{expected_version:changed.body.version,reason:'已核对新身份资料。',confirmed:true});
    assert.equal((await approveDraft(app,revoked)).status,422);
    const edited = (await app.request(`/drafts/${draft.id}`,'PATCH',{ ...input,expected_version:revoked.version })).body;
    assert.equal((await approveDraft(app,edited)).body.status,'APPROVED');
    await app.close(); app=await runApp(path);
    assert.equal((await app.request(`/contacts/${person.id}`)).body.full_name,'Corrected buyer team');
    assert.equal((await app.request(`/opportunities/${item.id}`)).body.activities[0].full_name,person.full_name);
    const versions = (await app.request(`/drafts/${draft.id}`)).body.versions;
    assert.equal(versions[0].contact_snapshot.full_name,'Corrected buyer team'); assert.equal(versions[1].contact_snapshot.full_name,person.full_name);
  } finally { if(app)await app.close();await rm(dir,{recursive:true,force:true}); }
});

test('contact edit guards preserve suppression and reject channel changes, stale versions and cross-organization access', async () => {
  const app=await runApp(':memory:');
  try {
    const { person,item }=await prepareDraft(app);
    const before=(await app.request(`/contacts/${person.id}`)).body;
    assert.equal((await app.request(`/contacts/${person.id}`,'PATCH',{...before,email:'new@example.com',expected_version:before.version,reason:'换邮箱。'})).status,422);
    assert.equal((await app.request(`/contacts/${person.id}`,'PATCH',{...before,account_id:'other',expected_version:before.version,reason:'转品牌。'})).status,422);
    await app.request(`/contacts/${person.id}/suppress`,'POST',{expected_version:before.version,reason:'对方要求停止联系。'});
    assert.equal((await app.request(`/contacts/${person.id}`,'PATCH',{...before,full_name:'New name',expected_version:before.version,reason:'旧窗口。'})).status,409);
    const current=(await app.request(`/contacts/${person.id}`)).body;
    const changed=(await app.request(`/contacts/${person.id}`,'PATCH',{...current,full_name:'New name',expected_version:current.version,reason:'修正称呼。'})).body;
    assert.equal(changed.suppression_reason,'对方要求停止联系。');
    const duplicate=(await app.request('/contacts','POST',{account_id:item.account_id,full_name:'Again',email:person.email,source_url:person.source_url})).body;
    assert.equal(duplicate.id,person.id); assert.equal(duplicate.suppression_reason,changed.suppression_reason);
    assert.equal((await app.request('/contact-suppressions')).body.items[0].email,person.email);
    app.db.prepare('INSERT INTO organizations VALUES (?,?)').run('private-org','Private');
    app.db.prepare('INSERT INTO accounts (id,organization_id,brand_name,normalized_name,website,normalized_domain,headquarters_country,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('private-brand','private-org','Private','private','https://example.net','example.net','','',new Date().toISOString());
    app.db.prepare('INSERT INTO contacts (id,organization_id,account_id,full_name,job_title,email,source_url,created_at) VALUES (?,?,?,?,?,?,?,?)').run('private-contact','private-org','private-brand','Hidden','','hidden@example.net','https://example.net',new Date().toISOString());
    assert.equal((await app.request('/contacts/private-contact')).status,404);
    assert.equal((await app.request('/contacts')).body.items.some(c=>c.id==='private-contact'),false);
  } finally { await app.close(); }
});

test('local owner auth lifecycle: setup preserves data, sessions survive restart, logout and password rotation revoke access', async () => {
  const eightCharacterPassword = randomUUID().slice(0, 8);
  const dir = await mkdtemp(join(tmpdir(), 'botein-auth-')); let app;
  try {
    const path = join(dir, 'auth.sqlite'); app = await runApp(path, { authenticate: false });
    const initial = app.db.prepare('SELECT * FROM factory_profiles').get();
    assert.equal((await app.request('/auth/status')).body.setup_required, true);
    assert.equal((await app.request('/workspace')).status, 401);
    assert.equal((await app.request('/exports/evidence')).status, 401);
    assert.equal((await app.request('/accounts', 'POST', { brand_name: 'Not permitted', website: 'https://example.com' })).status, 401);
    const setup = await app.request('/auth/setup', 'POST', { username: '  蓝科 Sales @负责人  ', display_name: 'Owner', password: eightCharacterPassword });
    assert.equal(setup.status, 201); assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.ok(!JSON.stringify(setup.body).includes(eightCharacterPassword));
    const stored = app.db.prepare('SELECT password_hash,password_salt FROM local_owners').get();
    assert.ok(stored.password_hash !== eightCharacterPassword && stored.password_hash.length === 128 && stored.password_salt.length === 32);
    const cookie = app.cookie;
    assert.ok(!cookie.includes(app.db.prepare('SELECT token_hash FROM auth_sessions').get().token_hash));
    assert.deepEqual(app.db.prepare('SELECT * FROM factory_profiles').get(), initial);
    assert.equal((await app.request('/auth/setup', 'POST', { username: 'other', display_name: 'Other', password: eightCharacterPassword })).status, 409);
    await app.close(); app = await runApp(path, { authenticate: false });
    const oldSession = await app.request('/workspace', 'GET', undefined, { Cookie: cookie });
    assert.equal(oldSession.status, 200);
    const login = await app.request('/auth/login', 'POST', { username: '蓝科 sales @负责人', password: eightCharacterPassword });
    assert.equal(login.status, 200);
    const secondCookie = app.cookie;
    const replacement = randomUUID().slice(0, 8);
    const changed = await app.request('/auth/password', 'POST', { current_password: eightCharacterPassword, new_password: replacement });
    assert.equal(changed.status, 200);
    assert.equal((await app.request('/workspace', 'GET', undefined, { Cookie: cookie })).status, 401);
    assert.equal((await app.request('/workspace', 'GET', undefined, { Cookie: secondCookie })).status, 401);
    assert.equal((await app.request('/workspace')).status, 200);
    const newestCookie = app.cookie;
    await app.request('/auth/logout', 'POST', {});
    assert.equal((await app.request('/workspace', 'GET', undefined, { Cookie: newestCookie })).status, 401);
    assert.equal((await app.request('/auth/login', 'POST', { username: '蓝科 sales @负责人', password: eightCharacterPassword })).status, 401);
    assert.equal((await app.request('/auth/login', 'POST', { username: '蓝科 sales @负责人', password: replacement })).status, 200);
    const auditText = JSON.stringify(app.db.prepare('SELECT * FROM audit_logs').all());
    assert.ok(!auditText.includes(eightCharacterPassword) && !auditText.includes(replacement));
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('auth failure guards: invalid setup, CSRF origin, expired and forged sessions, generic login errors and rate limit', async () => {
  const app = await runApp(':memory:', { authenticate: false });
  try {
    assert.equal((await app.request('/auth/setup', 'POST', { username: '   ', display_name: 'Owner', password: randomUUID() })).status, 422);
    assert.equal((await app.request('/auth/setup', 'POST', { username: '名'.repeat(65), display_name: 'Owner', password: randomUUID() })).status, 422);
    assert.equal((await app.request('/auth/setup', 'POST', { username: '李', display_name: 'Owner', password: randomUUID().slice(0, 7) })).status, 422);
    assert.equal((await app.request('/auth/setup', 'POST', { username: '李', display_name: 'Owner', password: fixturePassword }, { Origin: 'https://external.example' })).status, 403);
    assert.equal((await app.request('/auth/status')).body.setup_required, true);
    await app.request('/auth/setup', 'POST', { username: '李', display_name: 'Owner', password: fixturePassword });
    assert.equal((await app.request('/auth/status')).body.user.username, '李');
    const before = app.db.prepare('SELECT password_hash FROM local_owners').get().password_hash;
    const wrongChange = await app.request('/auth/password', 'POST', { current_password: 'wrong-password', new_password: randomUUID() });
    assert.equal(wrongChange.status, 401); assert.ok(app.db.prepare('SELECT password_hash FROM local_owners').get().password_hash === before);
    assert.equal((await app.request('/workspace', 'GET', undefined, { Cookie: `botein_session=${'A'.repeat(43)}` })).status, 401);
    app.db.prepare('UPDATE auth_sessions SET expires_at=?').run('2000-01-01T00:00:00.000Z');
    assert.equal((await app.request('/workspace')).status, 401);
    const wrongUser = await app.request('/auth/login', 'POST', { username: 'missing-user', password: fixturePassword });
    const wrongPassword = await app.request('/auth/login', 'POST', { username: '李', password: 'incorrect-value' });
    assert.equal(wrongUser.status, 401); assert.equal(wrongUser.body.error.code, wrongPassword.body.error.code);
    assert.equal(wrongUser.body.error.message, wrongPassword.body.error.message);
    let response;
    for (let i = 0; i < 7; i++) response = await app.request('/auth/login', 'POST', { username: '李', password: 'incorrect-value' });
    assert.equal(response.status, 429);
    assert.equal((await app.request('/auth/status')).body.authenticated, false);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
  } finally { await app.close(); }
});

test('session management: list without credentials, revoke specific and other logins while preserving current access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'botein-sessions-')); let app;
  try {
    const path = join(dir, 'sessions.sqlite'); app = await runApp(path);
    const firstCookie = app.cookie;
    const first = (await app.request('/auth/sessions')).body.items[0];
    await app.request('/auth/login', 'POST', { username: 'test-owner', password: fixturePassword }, { Cookie: '' });
    const secondCookie = app.cookie;
    const list = (await app.request('/auth/sessions')).body.items;
    assert.equal(list.length, 2); assert.equal(list.filter(s => s.current).length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['created_at','current','expires_at','id']);
    assert.ok(!JSON.stringify(list).includes(firstCookie.split('=')[1]));
    const second = list.find(s => s.current);
    await app.close(); app = await runApp(path, { authenticate: false });
    const afterRestart = await app.request('/auth/sessions', 'GET', undefined, { Cookie: secondCookie });
    assert.ok(afterRestart.body.items.some(s => s.id === second.id && s.current));
    const revoke = await app.request(`/auth/sessions/${first.id}/revoke`, 'POST', { confirmed: true }, { Cookie: secondCookie });
    assert.equal(revoke.body.authenticated, true);
    assert.equal((await app.request('/workspace', 'GET', undefined, { Cookie: firstCookie })).status, 401);
    assert.equal((await app.request('/workspace', 'GET', undefined, { Cookie: secondCookie })).status, 200);
    await app.request('/auth/login', 'POST', { username: 'test-owner', password: fixturePassword }, { Cookie: '' });
    const thirdCookie = app.cookie;
    const bulk = await app.request('/auth/sessions/revoke-others', 'POST', { confirmed: true });
    assert.equal(bulk.body.revoked_count, 1);
    assert.equal((await app.request('/workspace', 'GET', undefined, { Cookie: secondCookie })).status, 401);
    assert.equal((await app.request('/workspace')).status, 200);
    const current = (await app.request('/auth/sessions')).body.items[0];
    const self = await app.request(`/auth/sessions/${current.id}/revoke`, 'POST', { confirmed: true });
    assert.equal(self.body.authenticated, false); assert.match(self.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await app.request('/workspace', 'GET', undefined, { Cookie: thirdCookie })).status, 401);
    const logs = JSON.stringify(app.db.prepare('SELECT details FROM audit_logs').all());
    assert.ok(!logs.includes(thirdCookie.split('=')[1]));
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('session guards: anonymous, foreign and expired targets fail without revoking legitimate sessions', async () => {
  const app = await runApp(':memory:');
  try {
    const current = (await app.request('/auth/sessions')).body.items[0];
    assert.equal((await app.request('/auth/sessions', 'GET', undefined, { Cookie: '' })).status, 401);
    assert.equal((await app.request('/auth/sessions/revoke-others', 'POST', { confirmed: true }, { Cookie: '' })).status, 401);
    assert.equal((await app.request(`/auth/sessions/${current.id}/revoke`, 'POST', {})).status, 422);
    assert.equal((await app.request(`/auth/sessions/${current.id}/revoke`, 'POST', { confirmed: true }, { Origin: 'https://external.example' })).status, 403);
    app.db.prepare('INSERT INTO organizations VALUES (?,?)').run('session-other-org', 'Other');
    const own = app.db.prepare('SELECT * FROM local_owners').get();
    app.db.prepare('INSERT INTO local_owners VALUES (?,?,?,?,?,?,?,?)').run('session-other-owner','session-other-org','other','Other',own.password_hash,own.password_salt,1,new Date().toISOString());
    const otherId = randomUUID(), expiredId = randomUUID();
    app.db.prepare('INSERT INTO auth_sessions (token_hash,owner_id,created_at,expires_at,public_id) VALUES (?,?,?,?,?)').run('foreign-hash','session-other-owner',new Date().toISOString(),'2999-01-01T00:00:00Z',otherId);
    app.db.prepare('INSERT INTO auth_sessions (token_hash,owner_id,created_at,expires_at,public_id) VALUES (?,?,?,?,?)').run('expired-hash',own.id,'2000-01-01T00:00:00Z','2000-01-02T00:00:00Z',expiredId);
    const visible = (await app.request('/auth/sessions')).body.items;
    assert.equal(visible.length, 1); assert.equal(visible[0].id, current.id);
    for (const id of [otherId, expiredId, randomUUID()]) assert.equal((await app.request(`/auth/sessions/${id}/revoke`, 'POST', { confirmed: true })).status, 404);
    assert.equal((await app.request('/auth/sessions/revoke-others','POST',{confirmed:true})).body.revoked_count,0);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM auth_sessions WHERE owner_id=?').get('session-other-owner').n,1);
    assert.equal((await app.request('/workspace')).status,200);
  } finally { await app.close(); }
});

test('pool research: deterministic tiers reuse manual opportunities and never auto-qualify', async () => {
  const app = await runApp(':memory:');
  try {
    const p = (await app.request('/workspace')).body.factory;
    const saved = (await app.request('/factory-profile', 'PUT', { ...p, target_markets: ['US'], expected_version: p.version })).body;
    await app.request('/factory-profile/activate', 'POST', { expected_version: saved.version, confirmed: true });
    const brand = (await app.request('/accounts', 'POST', { brand_name: 'Pod Brand', website: 'https://pods.example.com' })).body;
    const product = (await app.request(`/accounts/${brand.id}/products`, 'POST', { product_name: 'Pods 30', product_category: 'LAUNDRY_PODS', product_url: 'https://pods.example.com/30' })).body;
    const proof = (await app.request('/evidence', 'POST', { account_id: brand.id, product_id: product.id, source_url: 'https://pods.example.com/30', raw_text: 'Laundry pods sold in the US.', published_at: '2026-11-01' })).body;
    await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: 1, reason: '核对原文与品牌归属。', confirmed: true });
    let item = (await app.request('/opportunities', 'POST', { account_id: brand.id, reason: '人工核对后加入。' })).body;
    item = (await app.request(`/opportunities/${item.id}/transitions`, 'POST', { action: 'START_REVIEW', expected_version: item.version, reason: '开始核对。' })).body;
    item = (await app.request(`/opportunities/${item.id}/transitions`, 'POST', {
      action: 'QUALIFY', expected_version: item.version, reason: '已核对。', product_evidence_id: proof.id,
      market_evidence_id: proof.id, reason_evidence_id: proof.id, no_known_conflict: true, facts_confirmed: true,
      pending_info: '采购量待确认。',
    })).body;
    assert.equal(item.qualification_status, 'QUALIFIED');
    const unknown = (await app.request('/accounts', 'POST', { brand_name: 'Unknown Catalog', website: 'https://unknown.example.com' })).body;
    const dish = (await app.request('/accounts', 'POST', { brand_name: 'Dish Brand', website: 'https://dish.example.com' })).body;
    await app.request(`/accounts/${dish.id}/products`, 'POST', { product_name: 'Dish tabs', product_category: 'DISHWASHER_TABLETS', product_url: 'https://dish.example.com/tabs' });

    const created = await app.request('/research-jobs', 'POST', { market: 'US', source_mode: 'POOL', quantity: 20 }, { 'Idempotency-Key': 'pool-once' });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.ok(['QUEUED', 'RUNNING', 'COMPLETED'].includes(created.body.status));
    const job = await waitForJob(app, created.body.id);
    assert.equal(job.status, 'COMPLETED'); assert.equal(job.input.source_mode, 'POOL');
    assert.equal(job.counts.discovered, 3); assert.equal(job.counts.new_opportunities, 0);
    assert.equal(job.counts.reused_opportunities, 1); assert.equal(job.counts.not_fit, 1);
    assert.equal(job.stop_reason, 'SOURCE_SCOPE_EXHAUSTED'); assert.equal(job.budget.usage.search_requests, 0);

    const results = (await app.request(`/research-jobs/${job.id}/results`)).body;
    const byBrand = Object.fromEntries(results.items.map(row => [row.brand_name, row]));
    assert.equal(byBrand['Pod Brand'].tier, 'PRIORITY_REVIEW');
    assert.equal(byBrand['Pod Brand'].opportunity_id, item.id);
    assert.equal(byBrand['Pod Brand'].current_qualification_status, 'QUALIFIED');
    assert.equal(byBrand['Pod Brand'].draft_status, 'NOT_GENERATED');
    assert.equal(byBrand['Unknown Catalog'].tier, 'NEEDS_INFORMATION');
    assert.equal(byBrand['Unknown Catalog'].opportunity_id, null);
    assert.ok(byBrand['Unknown Catalog'].missing_information.includes('洗衣凝珠品类产品资料'));
    assert.ok(byBrand['Pod Brand'].next_actions.includes('确认采购量、MOQ、包装与交期条件。'));
    assert.ok(byBrand['Pod Brand'].next_actions.includes('补充并核验联系人渠道。'));
    assert.ok(byBrand['Unknown Catalog'].next_actions.includes('将品牌加入商机并人工审核资格。'));
    assert.ok(byBrand['Unknown Catalog'].next_actions.includes('补充洗衣凝珠品类产品资料。'));
    assert.equal(byBrand['Dish Brand'].tier, 'NOT_FIT'); assert.equal(byBrand['Dish Brand'].opportunity_id, null);
    assert.deepEqual(byBrand['Dish Brand'].missing_information, []);
    assert.deepEqual(byBrand['Dish Brand'].next_actions, ['已列入排除记录，无需跟进。']);
    assert.equal(results.counts.returned, 2); assert.equal(results.counts.not_fit, 1);

    const highCreated = await app.request('/research-jobs', 'POST', { market: 'US', source_mode: 'POOL', min_evidence_quality: 'HIGH' });
    const high = await waitForJob(app, highCreated.body.id);
    const highResults = (await app.request(`/research-jobs/${high.id}/results`)).body;
    const highPod = highResults.items.find(row => row.brand_name === 'Pod Brand');
    assert.equal(highPod.tier, 'NEEDS_INFORMATION');
    assert.ok(highPod.next_actions.includes('记录第一方来源属性后再使用 HIGH 门槛。'));
    assert.equal(high.counts.reused_opportunities, 1);

    const replay = await app.request('/research-jobs', 'POST', { market: 'US', source_mode: 'POOL', quantity: 20 }, { 'Idempotency-Key': 'pool-once' });
    assert.equal(replay.body.id, job.id); assert.equal(replay.body.replayed, true);
    assert.equal((await app.request('/research-jobs', 'POST', { market: 'US', source_mode: 'POOL', quantity: 19 }, { 'Idempotency-Key': 'pool-once' })).status, 409);
    const jobList = (await app.request('/research-jobs')).body;
    assert.equal(jobList.items.length, 2); assert.equal(jobList.total, 2);
    assert.deepEqual((await app.request(`/research-jobs/${job.id}/failures`)).body.items, []);
    assert.equal((await app.request(`/research-jobs/${job.id}/retry`, 'POST', {})).status, 409);
    app.db.prepare("UPDATE research_jobs SET status='FAILED',stop_reason='DEPENDENCY_FAILURE' WHERE id=?").run(job.id);
    const retried = await app.request(`/research-jobs/${job.id}/retry`, 'POST', {});
    assert.equal(retried.status, 202); assert.equal(retried.body.attempt, 2);
    const retriedJob = await waitForJob(app, job.id);
    assert.equal(retriedJob.status, 'COMPLETED');
    assert.equal((await app.request(`/research-jobs/${job.id}/results`)).body.items.length, 3);
    assert.equal((await app.request(`/research-jobs/${job.id}/cancel`, 'POST', {})).body.status, 'COMPLETED');
  } finally { await app.close(); }
});

test('research guards: unsupported scope, factory readiness and quantity limits do not create jobs', async () => {
  const app = await runApp(':memory:');
  try {
    assert.equal((await app.request('/research-jobs', 'POST', { market: 'CA' })).body.error.code, 'UNSUPPORTED_MARKET');
    assert.equal((await app.request('/research-jobs', 'POST', { market: 'US', product_categories: ['DISHWASHER_TABLETS'] })).body.error.code, 'UNSUPPORTED_CATEGORY');
    assert.equal((await app.request('/research-jobs', 'POST', { market: 'US', quantity: 51 })).status, 422);
    assert.equal((await app.request('/research-jobs', 'POST', { market: 'US', source_mode: 'POOL' })).body.error.code, 'FACTORY_NOT_ACTIVE');
    const p = (await app.request('/workspace')).body.factory;
    const noMarket = (await app.request('/factory-profile', 'PUT', { ...p, expected_version: p.version })).body;
    assert.equal((await app.request('/factory-profile/activate', 'POST', { expected_version: noMarket.version, confirmed: true })).status, 422);
    assert.equal((await app.request('/research-jobs', 'POST', { market: 'US', source_mode: 'POOL' })).body.error.code, 'FACTORY_NOT_ACTIVE');
    assert.equal((await app.request('/research-jobs')).body.items.length, 0);
  } finally { await app.close(); }
});

test('source preview guards: private, credential, port and non-web URLs are refused before any fetch', async () => {
  const app = await runApp(':memory:');
  try {
    for (const url of [
      'http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'file:///etc/passwd',
      'https://user:pass@example.com/', 'https://example.com:8443/', 'https://[::1]/', 'https://example.com.',
    ]) {
      const result = await app.request('/sources/preview', 'POST', { url });
      assert.equal(result.status, 422, `${url} → ${result.status} ${JSON.stringify(result.body)}`);
      assert.ok(['INVALID_URL', 'SOURCE_URL_REJECTED'].includes(result.body.error.code), `${url} → ${JSON.stringify(result.body)}`);
    }
    assert.equal((await app.request('/sources/preview', 'POST', { url: '' })).status, 422);
  } finally { await app.close(); }
});

test('source registry: usage records, domain scope, activation and disable are audited', async () => {
  const app = await runApp(':memory:');
  try {
    const base = {
      name: 'Public search', kind: 'AUTO_DISCOVERY', base_domains: ['search.example.net', 'api.search.example.net'],
      usage_note: '已核对服务条款允许品牌发现，2026-11-13。', retention_note: '仅保留来源 URL 与引用片段。', rate_limit_per_15m: 10,
    };
    const created = await app.request('/sources', 'POST', base);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, 'PENDING'); assert.equal(created.body.version, 1);
    assert.equal((await app.request('/sources', 'POST', base)).status, 409);
    assert.equal((await app.request('/sources', 'POST', { ...base, name: 'Bad domain', base_domains: ['localhost'] })).status, 422);
    assert.equal((await app.request('/sources', 'POST', { ...base, name: 'Bad market', markets: ['CA'] })).status, 422);
    assert.equal((await app.request('/sources', 'POST', { ...base, name: 'Bad limit', rate_limit_per_15m: 200 })).status, 422);
    assert.equal((await app.request('/sources/options')).body.items.length, 0);
    assert.equal((await app.request(`/sources/${created.body.id}/activate`, 'POST', { expected_version: 1 })).status, 422);
    assert.equal((await app.request(`/sources/${created.body.id}/activate`, 'POST', { expected_version: 1, terms_confirmed: true })).body.status, 'ACTIVE');
    assert.equal((await app.request('/sources/options')).body.items.length, 1);
    const list = (await app.request('/sources')).body;
    assert.equal(list.total, 1);
    assert.equal(list.readiness.auto_discovery.active, 1);
    assert.equal(list.readiness.auto_discovery.ready, true);
    assert.deepEqual(list.readiness.missing, []);
    const disabled = await app.request(`/sources/${created.body.id}/disable`, 'POST', { expected_version: 2, reason: '暂停使用。' });
    assert.equal(disabled.body.status, 'DISABLED');
    assert.equal((await app.request('/sources')).body.readiness.auto_discovery.ready, false);
    assert.equal((await app.request('/sources/options')).body.items.length, 0);
    assert.equal((await app.request(`/sources/${created.body.id}/activate`, 'POST', { expected_version: 3, terms_confirmed: true })).body.status, 'ACTIVE');
    assert.equal((await app.request('/sources/options')).body.items.length, 1);
    const logs = app.db.prepare("SELECT action FROM audit_logs WHERE object_id=? ORDER BY rowid").all(created.body.id).map(row => row.action);
    assert.deepEqual(logs, ['SOURCE_REGISTERED', 'SOURCE_ACTIVATED', 'SOURCE_DISABLED', 'SOURCE_ACTIVATED']);
  } finally { await app.close(); }
});

test('source changes re-require activation; DISCOVERY still never fabricates a job', async () => {
  const app = await runApp(':memory:');
  try {
    const p = (await app.request('/workspace')).body.factory;
    const saved = (await app.request('/factory-profile', 'PUT', { ...p, target_markets: ['US'], expected_version: p.version })).body;
    await app.request('/factory-profile/activate', 'POST', { expected_version: saved.version, confirmed: true });
    const base = { name: 'Discovery source', kind: 'AUTO_DISCOVERY', base_domains: ['search.example.net'], usage_note: '已核对使用条款。', retention_note: '仅保留引用。' };
    let source = (await app.request('/sources', 'POST', base)).body;
    source = (await app.request(`/sources/${source.id}/activate`, 'POST', { expected_version: source.version, terms_confirmed: true })).body;
    const discovery = await app.request('/research-jobs', 'POST', { market: 'US' });
    assert.equal(discovery.status, 503); assert.equal(discovery.body.error.code, 'SEARCH_UNAVAILABLE');
    assert.match(discovery.body.error.message, /本地搜索服务不可用/);
    assert.equal((await app.request('/research-jobs')).body.items.length, 0);
    source = (await app.request(`/sources/${source.id}`, 'PATCH', { expected_version: source.version, retention_note: '仅保留引用片段，收到删除请求时清理正文。' })).body;
    assert.equal(source.status, 'ACTIVE');
    assert.equal((await app.request(`/sources/${source.id}`, 'PATCH', { expected_version: source.version, base_domains: ['other.example.net'] })).status, 422);
    source = (await app.request(`/sources/${source.id}`, 'PATCH', { expected_version: source.version, base_domains: ['other.example.net'], reason: '改用新的搜索域名。' })).body;
    assert.equal(source.status, 'PENDING');
    assert.equal((await app.request('/sources')).body.readiness.auto_discovery.active, 0);
  } finally { await app.close(); }
});

test('source address classifier and text extraction stay conservative', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', 'fe80::1', 'fc00::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1',
  ]) assert.equal(isBlockedAddress(address), true, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isBlockedAddress(address), false, address);
  const extracted = htmlToText('<title>Test</title><script>alert(1)</script><p>A &amp; B</p><!-- hidden --><style>x</style><div>Next</div>');
  assert.equal(extracted.text.includes('alert'), false);
  assert.equal(extracted.text.includes('A & B'), true);
  assert.equal(extracted.text.includes('hidden'), false);
  assert.equal(extracted.truncated, false);
});

test('business list cursor pagination is stable, bounded and rejects invalid cursors', async () => {
  const app = await runApp(':memory:');
  try {
    assert.equal(pageParams(new URLSearchParams()).limit, 20);
    assert.equal(pageParams(new URLSearchParams('limit=100')).limit, 100);
    const brands = [];
    for (let index = 0; index < 5; index++) {
      brands.push((await app.request('/accounts', 'POST', { brand_name: `Page ${index}`, website: `https://page${index}.example.com` })).body);
    }
    const first = await app.request('/accounts?limit=2');
    assert.equal(first.status, 200); assert.equal(first.body.items.length, 2); assert.ok(first.body.next_cursor);
    const second = await app.request(`/accounts?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
    assert.equal(second.body.items.length, 2);
    const third = await app.request(`/accounts?limit=2&cursor=${encodeURIComponent(second.body.next_cursor)}`);
    assert.equal(third.body.items.length, 1); assert.equal(third.body.next_cursor, null);
    assert.equal(new Set([...first.body.items, ...second.body.items, ...third.body.items].map(item => item.id)).size, 5);
    // A new row cannot duplicate a row already returned by the previous page.
    await app.request('/accounts', 'POST', { brand_name: 'Newest page brand', website: 'https://newest-page.example.com' });
    const afterInsert = await app.request(`/accounts?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
    assert.equal(afterInsert.body.items.some(item => item.id === first.body.items[0].id), false);
    assert.equal((await app.request('/accounts/options')).body.items.length, 6);
    const allAccounts = await app.request('/accounts?limit=20');
    assert.equal(allAccounts.body.total, 6);
    const filtered = await app.request('/accounts?q=Page%204');
    assert.equal(filtered.body.items.length, 1); assert.equal(filtered.body.total, 1);
    assert.equal((await app.request('/accounts?q=%25')).body.total, 0);
    for (const query of ['limit=0', 'limit=101', 'cursor=bad']) {
      assert.equal((await app.request(`/accounts?${query}`)).status, 422, query);
    }

    for (let index = 0; index < 3; index++) {
      await app.request('/evidence', 'POST', { account_id: brands[0].id, source_url: `https://page0.example.com/e${index}`, raw_text: `Evidence ${index}` });
      await app.request(`/accounts/${brands[0].id}/products`, 'POST', { product_name: `Product ${index}`, product_category: 'LAUNDRY_PODS', product_url: `https://page0.example.com/p${index}` });
      await app.request('/contacts', 'POST', { account_id: brands[0].id, full_name: `Buyer ${index}`, email: `buyer${index}@example.com`, source_url: 'https://page0.example.com/contact' });
    }
    const evidenceFirst = await app.request('/evidence?limit=2');
    assert.equal(evidenceFirst.body.items.length, 2); assert.ok(evidenceFirst.body.next_cursor);
    const evidenceSecond = await app.request(`/evidence?limit=2&cursor=${encodeURIComponent(evidenceFirst.body.next_cursor)}`);
    assert.equal(evidenceSecond.body.items.length, 1); assert.equal(new Set([...evidenceFirst.body.items, ...evidenceSecond.body.items].map(item => item.id)).size, 3);
    const productsFirst = await app.request(`/accounts/${brands[0].id}/products?limit=2`);
    assert.equal(productsFirst.body.items.length, 2); assert.ok(productsFirst.body.next_cursor);
    assert.equal(productsFirst.body.total, 3);
    const productsSecond = await app.request(`/accounts/${brands[0].id}/products?limit=2&cursor=${encodeURIComponent(productsFirst.body.next_cursor)}`);
    assert.equal(productsSecond.body.items.length, 1);
    assert.equal((await app.request(`/accounts/${brands[0].id}/products/options`)).body.items.length, 3);
    const contactsFirst = await app.request('/contacts?limit=2');
    assert.equal(contactsFirst.body.items.length, 2); assert.ok(contactsFirst.body.next_cursor);
    assert.equal(contactsFirst.body.total, 3);
    const contactsSecond = await app.request(`/contacts?limit=2&cursor=${encodeURIComponent(contactsFirst.body.next_cursor)}`);
    assert.equal(contactsSecond.body.items.length, 1);
    assert.equal((await app.request('/contacts?q=Buyer%201')).body.total, 1);
    assert.equal((await app.request('/contacts?q=%25')).body.total, 0);
    const suppressTarget = contactsFirst.body.items[0];
    assert.equal((await app.request(`/contacts/${suppressTarget.id}/suppress`, 'POST', { expected_version: suppressTarget.version, reason: '分页测试。' })).status, 200);
    const suppressions = await app.request('/contact-suppressions?limit=20');
    assert.equal(suppressions.body.total, 1); assert.equal(suppressions.body.items.length, 1);

    for (let index = 0; index < 3; index++) {
      await app.request('/opportunities', 'POST', { account_id: brands[index].id, reason: `分页测试 ${index}` });
    }
    const opportunitiesFirst = await app.request('/opportunities?limit=2');
    assert.equal(opportunitiesFirst.body.items.length, 2); assert.ok(opportunitiesFirst.body.next_cursor);
    assert.equal(opportunitiesFirst.body.total, 3);
    const opportunitiesSecond = await app.request(`/opportunities?limit=2&cursor=${encodeURIComponent(opportunitiesFirst.body.next_cursor)}`);
    assert.equal(opportunitiesSecond.body.items.length, 1);
    assert.equal((await app.request('/opportunities?status=PENDING')).body.total, 3);
    assert.equal((await app.request('/opportunities?status=REJECTED')).body.total, 0);
    assert.equal((await app.request('/opportunities?status=BAD')).status, 422);
    assert.equal((await app.request('/opportunities/options')).body.items.length, 3);
    const opportunity = opportunitiesFirst.body.items[0];
    for (let index = 0; index < 2; index++) {
      await app.request('/follow-up-tasks', 'POST', {
        opportunity_id: opportunity.id, title: `Paged task ${index}`,
        due_at: new Date(Date.now() + (index + 1) * 86400000).toISOString(), idempotency_key: `paged-task-${index}`,
      });
    }
    const tasksFirst = await app.request('/follow-up-tasks?limit=1');
    assert.equal(tasksFirst.body.items.length, 1); assert.ok(tasksFirst.body.next_cursor);
    const tasksSecond = await app.request(`/follow-up-tasks?limit=1&cursor=${encodeURIComponent(tasksFirst.body.next_cursor)}`);
    assert.equal(tasksSecond.body.items.length, 1); assert.equal(tasksSecond.body.next_cursor, null);
    assert.equal((await app.request('/follow-up-tasks?status=OPEN')).body.total, 2);
    assert.equal((await app.request('/follow-up-tasks?status=DONE')).body.total, 0);
    assert.equal((await app.request('/follow-up-tasks?status=CANCELLED')).body.total, 0);
    assert.equal((await app.request('/follow-up-tasks?status=OVERDUE')).body.total, 0);
    const todayFrom = new Date(Date.now() - 3600000).toISOString(), todayTo = new Date(Date.now() + 3600000).toISOString();
    assert.equal((await app.request(`/follow-up-tasks?status=TODAY&from=${encodeURIComponent(todayFrom)}&to=${encodeURIComponent(todayTo)}`)).body.total, 0);
    assert.equal((await app.request('/follow-up-tasks?status=TODAY')).status, 422);
    assert.equal((await app.request('/follow-up-tasks?status=BAD')).status, 422);
    const cancelled = await app.request(`/follow-up-tasks/${tasksFirst.body.items[0].id}`, 'PATCH', { expected_version: tasksFirst.body.items[0].version, status: 'CANCELLED', reason: '分页测试取消。' });
    assert.equal(cancelled.status, 200);
    assert.equal((await app.request('/follow-up-tasks?status=CANCELLED')).body.total, 1);
    assert.equal((await app.request('/follow-up-tasks?status=OPEN')).body.total, 1);
    assert.equal((await app.request('/follow-up-tasks')).body.total, 2);

    for (let index = 0; index < 3; index++) {
      await app.request('/sources', 'POST', { name: `Paged source ${index}`, kind: 'AUTO_DISCOVERY', base_domains: [`source${index}.example.net`], usage_note: '已核对。', retention_note: '仅保留引用。' });
    }
    const sourcesFirst = await app.request('/sources?limit=2');
    assert.equal(sourcesFirst.body.items.length, 2); assert.ok(sourcesFirst.body.next_cursor);
    assert.equal(sourcesFirst.body.readiness.auto_discovery.registered, 3);
    const sourcesSecond = await app.request(`/sources?limit=2&cursor=${encodeURIComponent(sourcesFirst.body.next_cursor)}`);
    assert.equal(sourcesSecond.body.items.length, 1);
    assert.equal(sourcesSecond.body.readiness.auto_discovery.registered, 3);
  } finally { await app.close(); }
});

test('source preview governance: domain scope, per-source limit and automatic disable', async () => {
  const app = await runApp(':memory:');
  try {
    assert.equal(sourceMatchesHost({ base_domains: JSON.stringify(['example.com']) }, 'example.com'), true);
    assert.equal(sourceMatchesHost({ base_domains: JSON.stringify(['example.com']) }, 'www.example.com'), true);
    assert.equal(sourceMatchesHost({ base_domains: JSON.stringify(['example.com']) }, 'notexample.com'), false);
    const base = { kind: 'AUTO_DISCOVERY', usage_note: '已核对使用条款。', retention_note: '仅保留引用。' };
    let scope = (await app.request('/sources', 'POST', { ...base, name: 'Scope source', base_domains: ['scopecheck.example.net'], rate_limit_per_15m: 10 })).body;
    scope = (await app.request(`/sources/${scope.id}/activate`, 'POST', { expected_version: scope.version, terms_confirmed: true })).body;
    assert.equal((await app.request('/sources/preview', 'POST', { url: 'https://other.example.net', source_id: scope.id })).body.error.code, 'SOURCE_SCOPE_MISMATCH');
    let state = (await app.request('/sources')).body.items.find(item => item.id === scope.id);
    assert.equal(state.consecutive_failures, 0);
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await app.request('/sources/preview', 'POST', { url: 'https://scopecheck.example.net', source_id: scope.id });
      assert.ok([422, 502, 504].includes(result.status), JSON.stringify(result.body));
    }
    state = (await app.request('/sources')).body.items.find(item => item.id === scope.id);
    assert.equal(state.status, 'DISABLED'); assert.equal(state.consecutive_failures, 5);
    assert.ok(state.last_error.length > 0);
    assert.equal((await app.request('/sources')).body.readiness.auto_discovery.active, 0);
    assert.equal((await app.request('/sources/preview', 'POST', { url: 'https://scopecheck.example.net', source_id: scope.id })).status, 409);
    const audits = app.db.prepare('SELECT action FROM audit_logs WHERE object_id=? ORDER BY rowid').all(scope.id).map(row => row.action);
    assert.ok(audits.includes('SOURCE_AUTO_DISABLED'));
    const reactivated = (await app.request(`/sources/${scope.id}/activate`, 'POST', { expected_version: state.version, terms_confirmed: true })).body;
    assert.equal(reactivated.status, 'ACTIVE'); assert.equal(reactivated.consecutive_failures, 0);

    let limited = (await app.request('/sources', 'POST', { ...base, name: 'Limited source', base_domains: ['limitcheck.example.net'], rate_limit_per_15m: 1 })).body;
    limited = (await app.request(`/sources/${limited.id}/activate`, 'POST', { expected_version: limited.version, terms_confirmed: true })).body;
    const firstAttempt = await app.request('/sources/preview', 'POST', { url: 'https://limitcheck.example.net', source_id: limited.id });
    assert.ok([422, 502, 504].includes(firstAttempt.status), JSON.stringify(firstAttempt.body));
    assert.equal((await app.request('/sources/preview', 'POST', { url: 'https://limitcheck.example.net', source_id: limited.id })).body.error.code, 'SOURCE_RATE_LIMITED');
    const limitedState = (await app.request('/sources')).body.items.find(item => item.id === limited.id);
    assert.equal(limitedState.consecutive_failures, 1);
  } finally { await app.close(); }
});

test('AI evidence analysis validates quotes, stores assessments and redacts on purge', async () => {
  let calls = 0;
  const services = {
    ...offlineServices,
    modelConfig: () => ({ configured: true, name: 'stub-model' }),
    completeJson: async () => {
      calls++;
      if (calls === 1) return {
        data: {
          event_type: 'CLUMPING',
          observed_facts: [{ text: 'A review reports pods sticking together.', references: [{ quote: 'Sample branded laundry pods offered in US.' }] }],
          business_hypotheses: [{ type: 'POTENTIAL_PRODUCT_IMPROVEMENT_NEED', confidence_label: 'LOW', reason: 'A single review does not establish frequency.' }],
          intent_signal: 'UNKNOWN', missing_information: ['Frequency baseline'], uncertainty: 'HIGH',
        }, usage: { input_tokens: 80, output_tokens: 40, cost: 0.001 }, model: 'stub-model',
      };
      return {
        data: {
          event_type: 'CLUMPING',
          observed_facts: [{ text: 'Fabricated fact.', references: [{ quote: 'not in the evidence text' }] }],
          business_hypotheses: [], intent_signal: 'UNKNOWN', missing_information: [], uncertainty: 'HIGH',
        }, usage: {}, model: 'stub-model',
      };
    },
  };
  const app = await runApp(':memory:', { services });
  try {
    const { proof } = await prepareDraft(app);
    const analyzed = await app.request(`/evidence/${proof.id}/analyze`, 'POST', {});
    assert.equal(analyzed.status, 201, JSON.stringify(analyzed.body));
    assert.equal(analyzed.body.event_type, 'CLUMPING');
    assert.equal(analyzed.body.evidence_quality, 'MEDIUM');
    assert.equal(analyzed.body.observed_facts[0].references[0].quote, 'Sample branded laundry pods offered in US.');
    assert.equal((await app.request(`/evidence/${proof.id}/assessments`)).body.items.length, 1);
    const invalid = await app.request(`/evidence/${proof.id}/analyze`, 'POST', {});
    assert.equal(invalid.status, 422); assert.equal(invalid.body.error.code, 'MODEL_ANALYSIS_VALIDATION_FAILED');
    assert.equal((await app.request(`/evidence/${proof.id}/assessments`)).body.items.length, 1);
    const purged = await app.request(`/evidence/${proof.id}/purge`, 'POST', { expected_version: 2, reason: '保留政策清除。', confirmed: true });
    assert.equal(purged.status, 200);
    const assessments = (await app.request(`/evidence/${proof.id}/assessments`)).body.items;
    assert.equal(assessments.length, 1);
    assert.deepEqual(assessments[0].observed_facts, []);
    assert.deepEqual(assessments[0].business_hypotheses, []);
    assert.equal(assessments[0].event_type, 'CLUMPING');
  } finally { await app.close(); }
});

test('research cancellation stops a running discovery job without saving results', async () => {
  const services = {
    ...offlineServices,
    searchStatus: async () => ({ configured: true, reachable: true, base: 'stub' }),
    modelConfig: () => ({ configured: true, name: 'stub-model' }),
    searchWeb: async () => { await new Promise(resolve => setTimeout(resolve, 300)); return []; },
    completeJson: async () => ({ data: { candidates: [] }, usage: {}, model: 'stub-model' }),
  };
  const app = await runApp(':memory:', { services });
  try {
    const p = (await app.request('/workspace')).body.factory;
    const saved = (await app.request('/factory-profile', 'PUT', { ...p, target_markets: ['US'], expected_version: p.version })).body;
    await app.request('/factory-profile/activate', 'POST', { expected_version: saved.version, confirmed: true });
    const created = await app.request('/research-jobs', 'POST', { market: 'US' });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const cancelled = await app.request(`/research-jobs/${created.body.id}/cancel`, 'POST', {});
    assert.equal(cancelled.body.status, 'CANCELLED');
    await new Promise(resolve => setTimeout(resolve, 600));
    const job = (await app.request(`/research-jobs/${created.body.id}`)).body;
    assert.equal(job.status, 'CANCELLED');
    assert.equal(job.stop_reason, 'USER_CANCELLED');
    assert.equal((await app.request(`/research-jobs/${created.body.id}/results`)).body.items.length, 0);
    assert.equal((await app.request('/accounts')).body.items.length, 0);
  } finally { await app.close(); }
});

test('AI draft generation validates claims and still requires human approval', async () => {
  let proofId = '', checkId = '', calls = 0;
  const services = {
    ...offlineServices,
    modelConfig: () => ({ configured: true, name: 'stub-model' }),
    completeJson: async () => {
      calls++;
      if (calls === 1) return {
        data: {
          subject: 'Laundry pod production',
          body: 'Your brand offers laundry pods in the US. We offer OEM and ODM services. May we discuss your product plans?',
          claims: [
            { text: 'Your brand offers laundry pods in the US.', kind: 'EVIDENCE', evidence_id: proofId, quote: 'Sample branded laundry pods offered in US.' },
            { text: 'We offer OEM and ODM services.', kind: 'FACTORY', check_id: checkId },
          ],
        },
        usage: { input_tokens: 100, output_tokens: 50, cost: 0.001 }, model: 'stub-model',
      };
      return {
        data: {
          subject: 'Bad draft',
          body: 'Your brand offers laundry pods in the US.',
          claims: [{ text: 'Your brand offers laundry pods in the US.', kind: 'EVIDENCE', evidence_id: proofId, quote: 'fabricated quote' }],
        }, usage: {}, model: 'stub-model',
      };
    },
  };
  const app = await runApp(':memory:', { services });
  try {
    const { item, proof } = await prepareDraft(app);
    proofId = proof.id;
    checkId = (await app.request('/factory-profile/checks/options')).body.items.find(check => check.field === 'service_type').id;
    const generated = await app.request(`/opportunities/${item.id}/drafts/generate`, 'POST', {});
    assert.equal(generated.status, 201, JSON.stringify(generated.body));
    assert.equal(generated.body.status, 'DRAFT'); assert.equal(generated.body.generated, true);
    assert.equal(generated.body.created_by, 'AI');
    assert.equal(generated.body.claims.length, 2);
    assert.equal((await approveDraft(app, generated.body)).body.status, 'APPROVED');
    const beforeInvalid = (await app.request(`/opportunities/${item.id}/drafts`)).body.items.length;
    const invalid = await app.request(`/opportunities/${item.id}/drafts/generate`, 'POST', {});
    assert.equal(invalid.status, 422); assert.equal(invalid.body.error.code, 'MODEL_CLAIM_VALIDATION_FAILED');
    assert.equal((await app.request(`/opportunities/${item.id}/drafts`)).body.items.length, beforeInvalid);
  } finally { await app.close(); }
});

test('discovery research uses search and model to create unverified candidates only', async () => {
  const services = {
    searchStatus: async () => ({ configured: true, reachable: true, base: 'stub' }),
    searchWeb: async () => [
      { title: 'Acme Pods', url: 'https://acme-pods.example.com/pods', content: 'Acme Pods laundry pods are sold in the US.' },
      { title: 'Marketplace listing', url: 'https://www.amazon.com/laundry-pods', content: 'Amazon marketplace listing.' },
    ],
    fetchPage: async () => ({
      final_url: 'https://acme-pods.example.com/', status_code: 200, content_type: 'text/html',
      text: 'Acme Pods makes laundry pods for US homes.', byte_length: 200, redirect_count: 0,
      redirect_chain: [], fetched_at: new Date().toISOString(), truncated: false,
      extraction: 'SIMPLE_TAG_STRIP', metadata: { title: 'Acme Pods', site_name: 'Acme Pods', description: 'Laundry pods sold in the US.' },
    }),
    completeJson: async () => ({
      data: { candidates: [{ domain: 'acme-pods.example.com', brand_name: 'Acme Pods', is_brand: true, product_signal: 'YES', us_signal: 'YES', reason: 'Brand site', evidence_excerpt: 'Laundry pods sold in the US.' }] },
      usage: { cost: 0.001 }, model: 'stub-model',
    }),
    modelConfig: () => ({ configured: true, name: 'stub-model' }),
    searchBase: 'stub',
  };
  const app = await runApp(':memory:', { services });
  try {
    const p = (await app.request('/workspace')).body.factory;
    const saved = (await app.request('/factory-profile', 'PUT', { ...p, target_markets: ['US'], expected_version: p.version })).body;
    await app.request('/factory-profile/activate', 'POST', { expected_version: saved.version, confirmed: true });
    const workspace = (await app.request('/workspace')).body;
    assert.equal(workspace.integrations.model.status, 'CONNECTED');
    assert.equal(workspace.integrations.search.status, 'CONNECTED');
    const created = await app.request('/research-jobs', 'POST', { market: 'US', quantity: 10 });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const job = await waitForJob(app, created.body.id);
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.counts.discovered, 1); assert.equal(job.counts.processed, 1);
    assert.equal(job.counts.new_opportunities, 0);
    assert.equal(job.details.model, 'stub-model');
    const accounts = (await app.request('/accounts')).body.items;
    assert.equal(accounts.length, 1); assert.equal(accounts[0].brand_name, 'Acme Pods');
    const evidence = (await app.request('/evidence')).body.items;
    assert.equal(evidence.length, 1); assert.equal(evidence[0].verification_status, 'UNVERIFIED');
    assert.match(evidence[0].raw_text, /Laundry pods sold in the US/);
    const results = (await app.request(`/research-jobs/${job.id}/results`)).body;
    assert.equal(results.items.length, 1); assert.equal(results.items[0].tier, 'NEEDS_INFORMATION');
    assert.equal(results.items[0].opportunity_id, null);
    assert.equal((await app.request('/opportunities')).body.items.length, 0);
    assert.ok(Array.isArray((await app.request(`/research-jobs/${job.id}/failures`)).body.items));
  } finally { await app.close(); }
});

test('backup snapshot verifies integrity and refuses to overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'botein-backup-')); let app;
  try {
    const path = join(dir, 'source.sqlite'); app = await runApp(path);
    const brand = (await app.request('/accounts', 'POST', { brand_name: 'Backup Brand', website: 'https://backup.example.com' })).body;
    await app.request('/evidence', 'POST', { account_id: brand.id, source_url: 'https://backup.example.com/page', raw_text: 'Snapshot evidence.' });
    await app.close(); app = null;
    const destination = join(dir, 'backups', 'snapshot.sqlite');
    const result = backupDatabase(path, destination);
    assert.equal(result.integrity, 'ok');
    assert.equal(result.counts.accounts, 1); assert.equal(result.counts.evidence, 1);
    assert.equal(existsSync(destination), true);
    assert.throws(() => backupDatabase(path, destination), /已存在/);
    app = await runApp(path);
    assert.equal((await app.request('/accounts')).body.items.length, 1);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('retention purge clears raw text, keeps metadata and revokes dependent approvals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'botein-purge-')); let app;
  try {
    const path = join(dir, 'purge.sqlite'); app = await runApp(path);
    const { item, proof, draft } = await prepareDraft(app);
    const approved = (await approveDraft(app, draft)).body;
    assert.equal(approved.status, 'APPROVED');
    assert.equal((await app.request(`/evidence/${proof.id}/purge`, 'POST', { expected_version: 2, reason: '来源要求清除原文。' })).status, 422);
    assert.equal((await app.request(`/evidence/${proof.id}/purge`, 'POST', { expected_version: 1, reason: '来源要求清除原文。', confirmed: true })).status, 409);
    const purged = (await app.request(`/evidence/${proof.id}/purge`, 'POST', { expected_version: 2, reason: '来源要求清除原文。', confirmed: true })).body;
    assert.equal(purged.raw_text, ''); assert.ok(purged.purged_at);
    assert.equal(purged.verification_status, 'INVALIDATED'); assert.equal(purged.purge_reason, '来源要求清除原文。');
    const opportunity = (await app.request(`/opportunities/${item.id}`)).body;
    assert.equal(opportunity.qualification_status, 'REASSESSMENT_REQUIRED');
    assert.ok(opportunity.evidence.every(evidence => evidence.raw_text === ''));
    const blocked = (await app.request(`/drafts/${draft.id}`)).body;
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.claims.find(claim => claim.kind === 'EVIDENCE').quote, '[原文已按保留政策清除]');
    assert.equal(JSON.stringify(blocked.reviews).includes('Sample branded laundry pods offered in US.'), false);
    assert.equal((await app.request(`/drafts/${draft.id}/copy-events`, 'POST', { expected_version: blocked.version, draft_version_id: blocked.current_version_id, part: 'body' })).status, 409);
    for (const suffix of ['', '-wal']) {
      try {
        const content = await readFile(path + suffix);
        assert.equal(content.includes(Buffer.from('Sample branded laundry pods offered in US. Source for manual review.')), false, `残留于 ${path}${suffix}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    assert.equal((await app.request(`/evidence/${proof.id}/verify`, 'POST', { expected_version: purged.version, reason: '尝试恢复。', confirmed: true })).status, 409);
    assert.equal((await app.request(`/evidence/${proof.id}/invalidate`, 'POST', { expected_version: purged.version, reason: '再次失效。' })).status, 409);
    assert.equal((await app.request(`/evidence/${proof.id}/purge`, 'POST', { expected_version: purged.version, reason: '再次清除。', confirmed: true })).status, 409);
    const csv = await (await app.fetch('/exports/evidence')).text();
    assert.equal(csv.includes('Sample branded laundry pods offered in US.'), false);
    assert.equal(csv.includes('来源要求清除原文。'), true);
    const logs = JSON.stringify(app.db.prepare("SELECT details FROM audit_logs WHERE action='EVIDENCE_PURGED'").all());
    assert.ok(!logs.includes('Sample branded laundry pods offered in US.'));
    const reimport = await app.request('/evidence', 'POST', { account_id: item.account_id, source_url: 'https://example.com/us/pods', raw_text: 'Sample branded laundry pods offered in US. Source for manual review.' });
    assert.equal(reimport.status, 200); assert.equal(reimport.body.duplicate, true); assert.equal(reimport.body.purged, true);
    await app.close(); app = await runApp(path);
    const stored = (await app.request('/evidence')).body.items[0];
    assert.equal(stored.raw_text, ''); assert.ok(stored.purged_at);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('audit log pagination is newest-first and never exposes credentials', async () => {
  const app = await runApp(':memory:');
  try {
    for (let index = 0; index < 4; index++) {
      await app.request('/accounts', 'POST', { brand_name: `Audit ${index}`, website: `https://audit${index}.example.com` });
    }
    const first = await app.request('/audit-logs?limit=2');
    assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.items.length, 2, JSON.stringify(first.body));
    assert.ok(first.body.next_cursor);
    assert.ok(first.body.items[0].created_at >= first.body.items[1].created_at);
    const second = await app.request(`/audit-logs?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
    assert.equal(second.status, 200); assert.equal(second.body.items.length, 2);
    const all = [...first.body.items, ...second.body.items];
    assert.equal(new Set(all.map(item => item.id)).size, 4);
    for (const item of all) assert.ok(!('password' in item.details) && !('cookie' in item.details));
    assert.equal((await app.request('/audit-logs?limit=101')).status, 422);
    assert.equal((await app.request('/audit-logs?cursor=bad')).status, 422);
  } finally { await app.close(); }
});
