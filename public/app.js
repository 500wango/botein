import { startAuth } from './auth.js';
import { setupContacts } from './contacts.js';
import { setupAccounts } from './accounts.js';
import { setupTransfer } from './data-transfer.js';
import { setupProducts } from './products.js';
import { setupDrafts } from './drafts.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const state = { workspace: null, accounts: [], accountOptions: [], accountTotal: 0, accountCursor: null, evidence: [], evidenceCursor: null, opportunities: [], opportunityOptions: [], opportunityTotal: 0, opportunityCursor: null, tasks: [], taskTotal: 0, taskCursor: null, upcomingTasks: [], researchJobs: [], researchJobTotal: 0, researchJobCursor: null, researchResults: null, sources: [], sourceOptions: [], sourceTotal: 0, sourceCursor: null, sourceReadiness: null, checkOptions: [], capabilityTotal: 0, capabilityCursor: null, identityTotal: 0, identityPendingTotal: 0, identityCursor: null, auditItems: [], auditCursor: null, detail: null, factoryDirty: false };
const date = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

async function api(path, method = 'GET', data) {
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: data ? { 'Content-Type': 'application/json', ...(data.idempotency_key ? { 'Idempotency-Key': data.idempotency_key } : {}) } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (response.status === 401) window.dispatchEvent(new Event('sn-auth-expired'));
  if (!response.ok) {
    const error = new Error(result.error?.message || '请求失败，请重试。');
    error.field = result.error?.field;
    throw error;
  }
  return result;
}
function notify(message) {
  $('#notice').textContent = message;
  $('#notice').hidden = false;
}
function clearError(form) {
  form.querySelector('.sn-form-error').hidden = true;
  form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
}
function formError(form, error) {
  const summary = form.querySelector('.sn-form-error');
  summary.textContent = error.message;
  summary.hidden = false;
  const control = error.field && form.elements.namedItem(error.field);
  if (control instanceof HTMLElement) { control.setAttribute('aria-invalid', 'true'); control.focus(); }
  else { summary.tabIndex = -1; summary.focus(); }
}
function formHandler(id, callback) {
  const form = $(id);
  form.addEventListener('submit', async event => {
    event.preventDefault(); clearError(form);
    const button = form.querySelector('[type="submit"]');
    const label = button.textContent;
    button.disabled = true; button.textContent = button.dataset.busyLabel || '正在保存…'; form.setAttribute('aria-busy', 'true');
    try { await callback(form); }
    catch (error) { formError(form, error); }
    finally {
      button.textContent = label; button.disabled = false; form.removeAttribute('aria-busy');
      if (id === '#activate-form') updateActivation();
      if (form.closest('dialog') && !form.closest('dialog').open) $('#main').focus();
    }
  });
}
function navigate() {
  const page = location.hash.slice(1).split('/')[0] || 'research';
  if (page === 'main') { $('#main').focus(); return; }
  const known = ['research', 'factory', 'accounts', 'evidence', 'opportunities', 'followups', 'analytics', 'settings'];
  if (!known.includes(page)) { location.hash = 'research'; return; }
  $$('[data-view]').forEach(el => { el.hidden = el.dataset.view !== page; });
  $$('[data-page]').forEach(el => {
    if (el.dataset.page === page) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  const title = $(`[data-view="${page}"] h1`).textContent;
  document.title = `${title} · Botein`;
  if (page === 'opportunities' && state.workspace) loadSelectedOpportunity();
  if (page === 'followups' && state.workspace) renderFollowups();
  if (page === 'analytics' && state.workspace) loadAnalytics().catch(error => formError($('#analytics-form'), error));
}
window.addEventListener('hashchange', () => { navigate(); $('#main').focus(); });
$('.sn-skip').addEventListener('click', event => { event.preventDefault(); const target = $('#workspace-shell').hidden ? $('#auth-screen') : $('#main'); target.focus(); target.scrollIntoView(); });
navigate();

function fillFactory() {
  const p = state.workspace.factory;
  const form = $('#factory-form');
  for (const name of ['factory_name', 'website', 'moq_quantity', 'unit', 'packaging_spec', 'lead_time_days', 'notes']) {
    form.elements[name].value = p[name] ?? '';
  }
  for (const name of ['supported_products', 'service_type', 'target_markets']) {
    form.querySelectorAll(`[name="${name}"]`).forEach(input => { input.checked = p[name].includes(input.value); });
  }
  $('#factory-status').textContent = p.status === 'ACTIVE' ? '基础档案已启用' : '草稿 · 待确认';
  $('#factory-version').textContent = `版本 ${p.version} · ${date(p.updated_at)}`;
  $('#factory-form [type="submit"]').disabled = false;
  $('#activate-form').reset();
  updateActivation();
}
function updateActivation() {
  const active = state.workspace?.factory.status === 'ACTIVE';
  const button = $('#activate-form [type="submit"]');
  button.disabled = !state.workspace || active || state.factoryDirty;
  button.textContent = state.factoryDirty ? '请先保存上方修改' : active ? '当前版本已启用' : '确认并启用';
}
$('#factory-form').addEventListener('input', () => { state.factoryDirty = true; updateActivation(); });
window.addEventListener('beforeunload', event => {
  if (state.factoryDirty) { event.preventDefault(); event.returnValue = ''; }
});

async function refresh() {
  const accountQuery = new URLSearchParams({ limit: '20' });
  const accountFilter = $('#account-filter').value.trim();
  if (accountFilter) accountQuery.set('q', accountFilter);
  const opportunityQuery = new URLSearchParams({ limit: '20', status: $('#opportunity-filter').value });
  const taskQuery = taskQueryFor($('#followup-filter').value);
  const [workspace, accountOptions, accounts, evidence, history, opportunityOptions, opportunities, upcomingTasks, tasks, checks, checkOptions, identities, researchJobs, sourceOptions, sources] = await Promise.all([
    api('/workspace'), api('/accounts/options'), api(`/accounts?${accountQuery}`), api('/evidence?limit=20'), api('/factory-profile/history'),
    api('/opportunities/options'), api(`/opportunities?${opportunityQuery}`), api('/follow-up-tasks?status=OPEN&limit=3'),
    api(`/follow-up-tasks?${taskQuery}`), api('/factory-profile/checks?limit=20'), api('/factory-profile/checks/options'),
    api('/account-identity-reviews?limit=20'), api('/research-jobs?limit=20'), api('/sources/options'), api('/sources?limit=20'),
  ]);
  Object.assign(state, {
    workspace, accountOptions: accountOptions.items, accounts: accounts.items, accountTotal: accounts.total, accountCursor: accounts.next_cursor,
    evidence: evidence.items, evidenceCursor: evidence.next_cursor, opportunityOptions: opportunityOptions.items,
    opportunities: opportunities.items, opportunityTotal: opportunities.total, opportunityCursor: opportunities.next_cursor,
    upcomingTasks: upcomingTasks.items, tasks: tasks.items, taskTotal: tasks.total, taskCursor: tasks.next_cursor,
    capabilities: { fields: checks.fields, profile_version: checks.profile_version, items: checks.items },
    checkOptions: checkOptions.items, capabilityTotal: checks.total, capabilityCursor: checks.next_cursor,
    identities: identities.items, identityTotal: identities.total, identityPendingTotal: identities.pending_total, identityCursor: identities.next_cursor,
    researchJobs: researchJobs.items, researchJobTotal: researchJobs.total, researchJobCursor: researchJobs.next_cursor,
    sourceOptions: sourceOptions.items, sources: sources.items, sourceTotal: sources.total, sourceCursor: sources.next_cursor, sourceReadiness: sources.readiness,
  });
  accountUI.renderIdentities();
  draftUI.renderCapabilities();
  if (!state.factoryDirty) fillFactory();
  $('#factory-readiness').textContent = workspace.factory.status === 'ACTIVE' ? '基础能力已确认，具体对外声明仍需核验。' : 'LANCCO 官网资料已预填，等待负责人确认。';
  const integrationsReady = Object.values(workspace.integrations).every(item => item.status === 'CONNECTED');
  $('#research-blocker').textContent = workspace.factory.status !== 'ACTIVE'
    ? '请先启用工厂档案，再运行研究。'
    : integrationsReady
      ? '本地搜索与模型网关已接入，可运行自动发现；也可选择仅分析品牌池。'
      : '自动发现需要本地 SearXNG 与模型网关；不可用时请选择“仅分析品牌池”。';
  $('#research-form [type="submit"]').disabled = workspace.factory.status !== 'ACTIVE';
  $('#factory-sources').innerHTML = workspace.sources.map(source => `<div class="sn-source"><a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${escape(source.title)}</a><p>${escape(source.detail)}</p></div>`).join('');
  $('#factory-history').innerHTML = history.items.length ? history.items.map(item => `<li>版本 ${item.version} · ${date(item.published_at)}</li>`).join('') : '<li>尚无已启用版本</li>';
  $('#integration-list').innerHTML = Object.values(workspace.integrations).map(item => `<article><h2>${escape(item.label)}</h2><span class="sn-state">${item.status === 'CONNECTED' ? '已接入' : '尚未接入'}</span><p>${escape(item.detail)}</p></article>`).join('');
  $('#prep-search-status').textContent = workspace.integrations.search.status === 'CONNECTED' ? '已接入' : '尚未接入';
  $('#prep-model-status').textContent = workspace.integrations.model.status === 'CONNECTED' ? '已接入' : '尚未接入';
  $$('[data-open]').forEach(button => { button.disabled = false; });
  $('#add-evidence').disabled = accountOptions.items.length === 0;
  $('#add-opportunity').disabled = accountOptions.items.length === 0;
  $('#add-followup').disabled = !opportunityOptions.items.length;
  renderAccounts(); renderEvidence(); renderOpportunities(); renderFollowups(); renderResearchJobs(); renderSources();
  if (location.hash === '#analytics') await loadAnalytics();
  if (location.hash.startsWith('#opportunities')) await loadSelectedOpportunity();
}
function renderAccounts() {
  const query = $('#account-filter').value.trim();
  const items = state.accounts, total = state.accountTotal ?? items.length;
  $('#account-count').textContent = `${items.length} / ${total} 个品牌`;
  if (!items.length) {
    $('#account-list').innerHTML = `<div class="sn-empty"><h2>${query ? '没有匹配的品牌' : '品牌池还是空的'}</h2><p>${query ? '尝试其他名称或域名。' : '先录入已知客户，或导入 CSV 名单。系统不会添加演示客户。'}</p></div>`;
    return;
  }
  $('#account-list').innerHTML = `<table class="sn-table"><caption>品牌归属与已保存证据，尚未自动分析</caption><thead><tr><th scope="col">品牌</th><th scope="col">官网</th><th scope="col">总部国家</th><th scope="col" class="sn-numeric">证据</th><th scope="col">操作</th></tr></thead><tbody>${items.map(item => `<tr><td><button type="button" class="sn-brand-edit" data-account-edit="${escape(item.id)}">${escape(item.brand_name)}</button>${item.notes ? `<p class="sn-helper">${escape(item.notes)}</p>` : ''}</td><td><a href="${escape(item.website)}" target="_blank" rel="noopener noreferrer">${escape(item.normalized_domain)}</a></td><td>${escape(item.headquarters_country || '待确认')}</td><td class="sn-numeric">${item.evidence_count}</td><td><button class="sn-button sn-secondary" data-evidence-account="${escape(item.id)}">记录证据</button> <button class="sn-button sn-secondary" data-products-account="${escape(item.id)}">产品（${item.product_count}）</button> <button class="sn-button sn-secondary" data-opportunity-account="${escape(item.id)}">加入商机</button></td></tr>`).join('')}</tbody></table>${state.accountCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-accounts-more>加载更多品牌</button></div>' : ''}`;
}
async function loadAccounts(reset = true) {
  const query = new URLSearchParams({ limit: '20' });
  const term = $('#account-filter').value.trim();
  if (term) query.set('q', term);
  if (!reset && state.accountCursor) query.set('cursor', state.accountCursor);
  const result = await api(`/accounts?${query}`);
  state.accounts = reset ? result.items : [...state.accounts, ...result.items];
  state.accountTotal = result.total;
  state.accountCursor = result.next_cursor;
  renderAccounts();
}
let accountFilterTimer;
function reloadAccountFilter() {
  clearTimeout(accountFilterTimer);
  loadAccounts(true).catch(error => notify(error.message));
}
$('#account-filter').addEventListener('input', () => {
  clearTimeout(accountFilterTimer);
  accountFilterTimer = setTimeout(() => loadAccounts(true).catch(error => notify(error.message)), 250);
});
$('#account-filter').addEventListener('search', reloadAccountFilter);
$('#account-filter').addEventListener('change', reloadAccountFilter);
function evidenceActions(item) {
  if (item.purged_at) return '';
  const verify = item.verification_status !== 'INVALIDATED'
    ? `<button class="sn-button sn-secondary" data-record="evidence" data-id="${escape(item.id)}" data-action="verify" ${!item.source_url ? 'disabled' : ''}>${item.verification_status === 'VERIFIED' ? '重新核验' : '人工核验'}</button><button class="sn-button sn-secondary" data-record="evidence" data-id="${escape(item.id)}" data-action="invalidate">标记失效</button>`
    : '';
  return `<div class="sn-actions">${verify}<button class="sn-button sn-secondary" data-record="evidence" data-id="${escape(item.id)}" data-action="purge">按保留政策清除原文</button></div>`;
}
function evidenceRecord(item) {
  const purged = Boolean(item.purged_at);
  return `<div class="sn-record"><h3>${purged ? '原文已清除' : escape(verificationLabels[item.verification_status])} · ${escape(item.id.slice(0, 8))}</h3>${productUI.evidenceLabel(item)}<button class="sn-button sn-secondary" data-evidence-product="${escape(item.id)}" ${purged ? 'disabled' : ''}>修订产品归属</button>${purged ? `<p class="sn-helper">原文已按保留政策清除：${escape(item.purge_reason || '未填写原因')} 仅保留来源、时间与审计元数据。</p>` : `<blockquote class="sn-quote">${escape(item.raw_text)}</blockquote>`}${item.source_url ? `<a href="${escape(item.source_url)}" target="_blank" rel="noopener noreferrer">查看原始来源</a>` : '<p class="sn-helper">未提供来源</p>'}<p class="sn-helper">${escape(purged ? `清除原因：${item.purge_reason || '未填写'}` : (item.verification_note || '尚未人工核验'))}${!purged && item.checked_at ? ` · ${date(item.checked_at)}` : ''}</p>${evidenceActions(item)}</div>`;
}
function renderEvidence() {
  if (!state.evidence.length) {
    $('#evidence-list').innerHTML = '<div class="sn-empty"><h2>让每条判断有据可查</h2><p>先在品牌池录入品牌，再保存产品页面、评论或其他公开资料的原文。系统只保存，不自动核验或推断采购意向。</p><a class="sn-text-link" href="#accounts">前往品牌池</a></div>';
    return;
  }
  $('#evidence-list').innerHTML = state.evidence.map(item => `<article class="sn-evidence-entry"><div class="sn-section-heading"><h2>${escape(item.brand_name)}</h2><span class="sn-state">${item.purged_at ? '原文已清除' : escape(verificationLabels[item.verification_status])}</span></div>${productUI.evidenceLabel(item)}<div class="sn-evidence-meta"><span>观察时间 ${date(item.observed_at)}</span><span>发布时间 ${item.published_at ? date(item.published_at) : '未知'}</span></div>${item.purged_at ? `<p class="sn-helper">原文已按保留政策清除：${escape(item.purge_reason || '未填写原因')} 仅保留来源、时间与审计元数据。</p>` : `<blockquote class="sn-quote">${escape(item.raw_text)}</blockquote>`}${item.source_url ? `<a href="${escape(item.source_url)}" target="_blank" rel="noopener noreferrer">查看原始来源：${escape(item.source_url)}</a>` : '<p class="sn-helper">未提供来源，文本仅供补充线索。</p>'}<button class="sn-button sn-secondary" data-evidence-product="${escape(item.id)}" ${item.purged_at ? 'disabled' : ''}>修订产品归属</button><p class="sn-helper">${escape(item.purged_at ? `清除原因：${item.purge_reason || '未填写'}` : (item.verification_note || '尚未核对原始来源。'))}</p>${evidenceActions(item)}</article>`).join('') + (state.evidenceCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-evidence-more>加载更多证据</button></div>' : '');
}
async function loadMoreEvidence() {
  if (!state.evidenceCursor) return;
  const result = await api(`/evidence?limit=20&cursor=${encodeURIComponent(state.evidenceCursor)}`);
  state.evidence = [...state.evidence, ...result.items];
  state.evidenceCursor = result.next_cursor;
  renderEvidence();
}
document.addEventListener('click', event => {
  if (event.target.closest('[data-accounts-more]')) loadAccounts(false).catch(error => notify(error.message));
  if (event.target.closest('[data-evidence-more]')) loadMoreEvidence().catch(error => notify(error.message));
  if (event.target.closest('[data-opportunities-more]')) loadOpportunities(false).catch(error => notify(error.message));
  if (event.target.closest('[data-tasks-more]')) loadTasks(false).catch(error => notify(error.message));
  if (event.target.closest('[data-sources-more]')) loadSources(false).catch(error => notify(error.message));
  if (event.target.closest('[data-research-jobs-more]')) loadResearchJobs(false).catch(error => notify(error.message));
  if (event.target.closest('[data-identities-more]')) loadIdentities(false).catch(error => notify(error.message));
  if (event.target.closest('[data-checks-more]')) loadChecks(false).catch(error => notify(error.message));
});
$('#fetch-source-page').addEventListener('click', async () => {
  const form = $('#evidence-form'), status = $('#fetch-source-status'), button = $('#fetch-source-page');
  const url = form.elements.source_url.value.trim();
  if (!url) { status.textContent = '请先填写来源网址。'; form.elements.source_url.focus(); return; }
  if (form.elements.raw_text.value.trim() && !window.confirm('读取页面将替换当前原始文本，是否继续？')) return;
  button.disabled = true; status.textContent = '正在读取公开页面…';
  try {
    const sourceId = form.elements.source_id.value;
    const page = await api('/sources/preview', 'POST', { url, ...(sourceId ? { source_id: sourceId } : {}) });
    form.elements.source_url.value = page.final_url;
    form.elements.raw_text.value = page.text;
    status.textContent = `已读取 ${page.byte_length} 字节 · ${page.content_type} · ${page.redirect_count} 次重定向。文本由简单标签清理生成${page.truncated ? '并截断到 20,000 字' : ''}，请核对后再保存；读取不等于来源核验。`;
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
function openDialog(id, accountId) {
  const dialog = document.getElementById(id), form = dialog.querySelector('form');
  form.reset(); clearError(form);
  if (id === 'evidence-dialog') {
    form.elements.account_id.innerHTML = state.accountOptions.map(item => `<option value="${escape(item.id)}">${escape(item.brand_name)}</option>`).join('');
    if (accountId) form.elements.account_id.value = accountId;
    form.elements.published_at.max = new Date().toISOString().slice(0, 10);
    form.elements.source_id.innerHTML = '<option value="">不关联来源治理</option>' + state.sourceOptions
      .map(source => `<option value="${escape(source.id)}">${escape(source.name)} · ≤ ${source.rate_limit_per_15m} 次/15 分钟</option>`).join('');
    $('#fetch-source-status').textContent = '仅在点击时由本机访问一次；不自动抓取，读取后仍需人工核对。';
    productUI.populateEvidenceProducts();
  }
  if (id === 'opportunity-dialog') {
    form.elements.account_id.innerHTML = state.accountOptions.map(item => `<option value="${escape(item.id)}">${escape(item.brand_name)}</option>`).join('');
    if (accountId) form.elements.account_id.value = accountId;
  }
  if (id === 'evidence-import-dialog') transferUI.prepareImport();
  if (id === 'import-dialog') $('#import-results').replaceChildren();
  dialog.showModal();
}
document.addEventListener('click', event => {
  const open = event.target.closest('[data-open]');
  if (open) openDialog(open.dataset.open);
  const evidence = event.target.closest('[data-evidence-account]');
  if (evidence) openDialog('evidence-dialog', evidence.dataset.evidenceAccount);
  const opportunity = event.target.closest('[data-opportunity-account]');
  if (opportunity) openDialog('opportunity-dialog', opportunity.dataset.opportunityAccount);
  const review = event.target.closest('[data-opportunity-review]');
  if (review) openOpportunityReview();
  const record = event.target.closest('[data-record]');
  if (record) openRecordAction(record.dataset.record, record.dataset.id, record.dataset.action);
  if (event.target.closest('[data-contact-add]')) openContactForm();
  if (event.target.closest('[data-activity-add]')) openActivityForm();
  const taskNew = event.target.closest('[data-task-new]');
  if (taskNew) openFollowupForm(null, taskNew.dataset.taskNew);
  const taskEdit = event.target.closest('[data-task-edit]');
  if (taskEdit) openFollowupForm(taskEdit.dataset.taskEdit, null, taskEdit.dataset.taskStatus);
  if (event.target.closest('[data-refresh-followups]')) refresh().catch(error => notify(error.message));
  const close = event.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
});
formHandler('#factory-form', async form => {
  const data = Object.fromEntries(new FormData(form));
  for (const name of ['supported_products', 'service_type', 'target_markets']) data[name] = new FormData(form).getAll(name);
  for (const name of ['moq_quantity', 'lead_time_days']) data[name] = data[name] === '' ? null : Number(data[name]);
  data.expected_version = state.workspace.factory.version;
  await api('/factory-profile', 'PUT', data);
  state.factoryDirty = false; await refresh();
  notify('工厂草稿已保存。请核对基础承接能力后启用。');
});
formHandler('#activate-form', async form => {
  await api('/factory-profile/activate', 'POST', { expected_version: state.workspace.factory.version, confirmed: form.elements.confirmed.checked });
  await refresh(); notify('基础档案已启用。官网中的认证、产能和性能声明仍需单独核验。');
});
formHandler('#account-form', async form => {
  const result = await api('/accounts', 'POST', Object.fromEntries(new FormData(form)));
  await refresh(); $('#account-dialog').close(); notify(result.status === 'NEEDS_REVIEW' ? '同域名品牌待核对，候选已保存在品牌池下方的身份核对列表。' : result.status === 'SKIPPED' ? (result.reason || '已按现有品牌身份记录处理。') : '品牌已保存，可以继续记录证据。');
});
formHandler('#import-form', async form => {
  const file = form.elements.file.files[0];
  if (!file || file.size > 500_000) throw new Error('请选择不超过 500 KB 的 CSV 文件。');
  const result = await api('/accounts/imports', 'POST', { csv: await file.text() });
  await refresh();
  const labels = { CREATED: '已导入', SKIPPED: '已跳过', NEEDS_REVIEW: '待核对', FAILED: '失败' };
  $('#import-results').innerHTML = `<p>新增 ${result.counts.CREATED} · 跳过 ${result.counts.SKIPPED} · 待核对 ${result.counts.NEEDS_REVIEW} · 失败 ${result.counts.FAILED}</p><ul>${result.results.map(row => `<li>第 ${row.row} 行 ${escape(row.brand_name)}：${labels[row.status]}${row.reason ? `，${escape(row.reason)}` : ''}</li>`).join('')}</ul>`;
});
formHandler('#evidence-form', async form => {
  const result = await api('/evidence', 'POST', Object.fromEntries(new FormData(form)));
  await refresh(); $('#evidence-dialog').close(); location.hash = 'evidence';
  notify(result.duplicate ? '相同原文与来源已保存，未重复创建。' : '原始证据已保存，状态为待核验。');
});
const auditLabels = {
  FACTORY_DRAFT_SAVED: '保存工厂草稿', FACTORY_ACTIVATED: '启用工厂档案', FACTORY_FIELD_VERIFIED: '核验工厂字段',
  ACCOUNT_CREATED: '新增品牌', ACCOUNT_UPDATED: '修改品牌', ACCOUNT_IDENTITY_PENDING: '品牌身份待核对',
  ACCOUNT_IDENTITY_REOPENED: '重新打开品牌身份核对', ACCOUNT_IDENTITY_RESOLVED: '处理品牌身份核对',
  EVIDENCE_RECORDED: '记录证据', EVIDENCE_VERIFIED_MANUALLY: '人工核验证据', EVIDENCE_INVALIDATED: '标记证据失效',
  EVIDENCE_CSV_IMPORTED: '导入证据 CSV', EVIDENCE_PRODUCT_CHANGED: '修订证据产品归属',
  PRODUCT_CREATED: '新增产品', PRODUCT_UPDATED: '修改产品',
  OPPORTUNITY_CREATED_FROM_RESEARCH: '研究创建商机', CREATED_MANUALLY: '人工创建商机',
  CONTACT_RECORDED: '记录联系人', CONTACT_UPDATED: '修改联系人', FOLLOW_UP_CREATED: '新增待办', FOLLOW_UP_UPDATED: '更新待办',
  CSV_EXPORT_REQUESTED: '导出业务资料', APPROVED_COPY_REQUESTED: '请求复制已批准草稿',
  DRAFT_MANUALLY_CREATED: '人工创建草稿',
  RESEARCH_JOB_CREATED: '创建研究任务', RESEARCH_JOB_COMPLETED: '完成研究任务', RESEARCH_JOB_FAILED: '研究任务失败',
  RESEARCH_JOB_CANCELLED: '取消研究任务', RESEARCH_JOB_RETRY: '重试研究任务',
  SOURCE_REGISTERED: '登记来源', SOURCE_UPDATED: '修改来源', SOURCE_ACTIVATED: '启用来源',
  SOURCE_DISABLED: '停用来源', SOURCE_AUTO_DISABLED: '来源连续失败自动停用',
  SOURCE_PAGE_FETCHED: '读取来源页面', SOURCE_PAGE_FETCH_FAILED: '读取来源失败',
  OWNER_ACCOUNT_CREATED: '创建负责人账号', OWNER_LOGGED_IN: '负责人登录', OWNER_LOGGED_OUT: '负责人退出登录',
  OWNER_PASSWORD_CHANGED: '修改负责人密码', OWNER_SESSION_REVOKED: '撤销登录会话',
  OWNER_OTHER_SESSIONS_REVOKED: '撤销其他登录会话',
};
let auditRequest = 0;
async function loadAudit(reset = true) {
  const request = ++auditRequest;
  const query = new URLSearchParams({ limit: '20' });
  if (!reset && state.auditCursor) query.set('cursor', state.auditCursor);
  $('#audit-list').innerHTML = '<p class="sn-muted">正在读取审计记录…</p>';
  try {
    const result = await api(`/audit-logs?${query}`);
    if (request !== auditRequest) return;
    state.auditItems = reset ? result.items : [...state.auditItems, ...result.items];
    state.auditCursor = result.next_cursor;
    renderAudit();
  } catch (error) {
    if (request === auditRequest) $('#audit-list').innerHTML = `<p role="alert">${escape(error.message)}</p>`;
  }
}
function renderAudit() {
  const items = state.auditItems || [];
  if (!items.length) { $('#audit-list').innerHTML = '<p class="sn-muted">当前没有审计记录。</p>'; return; }
  $('#audit-list').innerHTML = `<div class="sn-table-region"><table class="sn-table"><caption>按时间倒序，每次加载 20 条</caption><thead><tr><th scope="col">时间</th><th scope="col">操作</th><th scope="col">对象</th><th scope="col">详情</th></tr></thead><tbody>${items.map(item => `<tr><td>${date(item.created_at)}</td><td>${escape(auditLabels[item.action] || item.action)}</td><td><code>${escape(item.object_id.slice(0, 12))}</code></td><td><details class="sn-audit-details"><summary>查看</summary><pre>${escape(JSON.stringify(item.details, null, 1).slice(0, 2000))}</pre></details></td></tr>`).join('')}</tbody></table></div>${state.auditCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-audit-more>加载更多</button></div>' : '<p class="sn-helper">已到最早记录。</p>'}`;
}
$('#load-audit').addEventListener('click', () => loadAudit(true));
document.addEventListener('click', event => {
  if (event.target.closest('[data-audit-more]')) loadAudit(false);
});
const sourceStatusLabels = { PENDING: '待启用', ACTIVE: '已启用', DISABLED: '已停用' };
const sourceKindLabels = { AUTO_DISCOVERY: '自动发现', USER_PROVIDED_URL: '用户提供网址' };
function renderSources() {
  const items = state.sources || [], readiness = state.sourceReadiness;
  $('#source-count').textContent = `${items.length} / ${state.sourceTotal ?? items.length} 个来源`;
  $('#source-readiness').textContent = readiness
    ? readiness.auto_discovery.ready
      ? `已启用 ${readiness.auto_discovery.active} 个自动发现来源；自动发现使用本地 SearXNG 与模型网关。`
      : '尚未启用自动发现来源；自动发现使用配置的本地 SearXNG 与模型网关，来源登记用于受治理页面读取。'
    : '正在读取来源状态…';
  $('#source-list').innerHTML = items.length ? `<table class="sn-table"><caption>来源范围、授权记录与限速</caption><thead><tr><th scope="col">来源</th><th scope="col">类型</th><th scope="col">状态</th><th scope="col">允许域名</th><th scope="col">限制</th><th scope="col">保留方式</th><th scope="col">操作</th></tr></thead><tbody>${items.map(item => `<tr><td><strong>${escape(item.name)}</strong><p class="sn-helper">${escape(item.usage_note || '未填写使用方式与授权记录')}</p>${item.consecutive_failures ? `<p class="sn-helper">连续失败 ${item.consecutive_failures} 次${item.last_error ? `：${escape(item.last_error)}` : ''}</p>` : ''}</td><td>${sourceKindLabels[item.kind] || escape(item.kind)}</td><td>${sourceStatusLabels[item.status] || escape(item.status)}</td><td>${item.base_domains.map(escape).join('<br>')}</td><td>≤ ${item.rate_limit_per_15m} 次 / 15 分钟<br>美国 · 洗衣凝珠</td><td>${escape(item.retention_note || '未填写')}</td><td>${item.status === 'ACTIVE' ? `<button class="sn-button sn-secondary" data-source-disable="${escape(item.id)}" data-source-version="${item.version}">停用</button>` : `<button class="sn-button sn-secondary" data-source-activate="${escape(item.id)}" data-source-version="${item.version}">启用</button>`}</td></tr>`).join('')}</tbody></table>${state.sourceCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-sources-more>加载更多来源</button></div>' : ''}` : '<div class="sn-empty"><h3>还没有登记来源</h3><p>自动发现来源接入前，先登记使用方式、授权记录和允许域名。当前不会自动抓取。</p></div>';
}
async function loadSources(reset = true) {
  const query = new URLSearchParams({ limit: '20' });
  if (!reset && state.sourceCursor) query.set('cursor', state.sourceCursor);
  const result = await api(`/sources?${query}`);
  state.sources = reset ? result.items : [...state.sources, ...result.items];
  state.sourceTotal = result.total;
  state.sourceCursor = result.next_cursor;
  state.sourceReadiness = result.readiness;
  renderSources();
}
async function activateSource(id, version) {
  if (!window.confirm('确认已核对来源的使用方式、授权或允许使用记录，以及原始内容保留方式？')) return;
  try {
    await api(`/sources/${encodeURIComponent(id)}/activate`, 'POST', { expected_version: Number(version), terms_confirmed: true });
    await refresh(); notify('来源已启用。来源治理用于受治理页面读取；自动发现使用本地搜索与模型。');
  } catch (error) { notify(error.message); }
}
async function disableSource(id, version) {
  const reason = window.prompt('请输入停用原因。');
  if (!reason?.trim()) return;
  try {
    await api(`/sources/${encodeURIComponent(id)}/disable`, 'POST', { expected_version: Number(version), reason: reason.trim() });
    await refresh(); notify('来源已停用。');
  } catch (error) { notify(error.message); }
}
document.addEventListener('click', event => {
  const activate = event.target.closest('[data-source-activate]');
  if (activate) activateSource(activate.dataset.sourceActivate, activate.dataset.sourceVersion);
  const disable = event.target.closest('[data-source-disable]');
  if (disable) disableSource(disable.dataset.sourceDisable, disable.dataset.sourceVersion);
});
formHandler('#source-form', async form => {
  const data = Object.fromEntries(new FormData(form));
  data.base_domains = data.base_domains.split(/[\s,]+/).filter(Boolean);
  data.markets = ['US']; data.product_categories = ['LAUNDRY_PODS'];
  data.rate_limit_per_15m = Number(data.rate_limit_per_15m);
  await api('/sources', 'POST', data);
  await refresh(); $('#source-dialog').close();
  notify('来源已登记为待启用。请在列表中核对后启用。');
});
const researchStatusLabels = { QUEUED: '排队中', RUNNING: '执行中', COMPLETED: '已完成', PARTIAL: '部分完成', FAILED: '失败', CANCELLED: '已取消' };
const researchTierLabels = { PRIORITY_REVIEW: '优先审核', NEEDS_INFORMATION: '待补资料', NOT_FIT: '不匹配' };
const researchStopLabels = { TARGET_REACHED: '达到数量上限', SOURCE_SCOPE_EXHAUSTED: '已分析完品牌池', BUDGET_EXHAUSTED: '预算耗尽', TIME_LIMIT: '时间用尽', DEPENDENCY_FAILURE: '依赖故障', USER_CANCELLED: '用户取消' };
const contactStatusLabels = { CONTACT_NOT_FOUND: '未找到联系人', NO_VERIFIED_CHANNEL: '有联系人但无已核验渠道', AVAILABLE: '有已核验联系人' };
function renderResearchJobs() {
  const jobs = state.researchJobs || [];
  $('#research-job-count').textContent = `${jobs.length} / ${state.researchJobTotal ?? jobs.length} 个任务`;
  $('#research-job-list').innerHTML = jobs.length ? `<table class="sn-table"><caption>研究任务快照，包含执行状态、停止原因和来源模式</caption><thead><tr><th scope="col">创建时间</th><th scope="col">状态</th><th scope="col">来源</th><th scope="col">处理结果</th><th scope="col">停止原因</th><th scope="col">操作</th></tr></thead><tbody>${jobs.map(job => `<tr><td>${date(job.created_at)}</td><td>${researchStatusLabels[job.status] || escape(job.status)}<p class="sn-helper">第 ${job.attempt} 次执行</p></td><td>${job.source_mode === 'POOL' ? '仅品牌池' : '自动发现'}</td><td>发现 ${job.counts.discovered} · 新建机会 ${job.counts.new_opportunities} · 复用 ${job.counts.reused_opportunities} · 排除 ${job.counts.not_fit}</td><td>${researchStopLabels[job.stop_reason] || '—'}<p class="sn-helper">${job.budget.usage.cost_usd}/${job.budget.limits.cost_usd} USD · ${Math.round(job.budget.usage.runtime_ms / 1000)} 秒</p></td><td><button class="sn-button sn-secondary" data-research-results="${escape(job.id)}">查看结果</button>${['PARTIAL', 'FAILED'].includes(job.status) ? `<button class="sn-button sn-secondary" data-research-retry="${escape(job.id)}">重试</button>` : ''}${['QUEUED', 'RUNNING'].includes(job.status) ? `<button class="sn-button sn-secondary" data-research-cancel="${escape(job.id)}">取消</button>` : ''}</td></tr>`).join('')}</tbody></table>${state.researchJobCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-research-jobs-more>加载更多任务</button></div>' : ''}` : '<div class="sn-empty"><h3>还没有研究任务</h3><p>启用工厂档案后，可运行自动发现，或选择“仅分析品牌池”。</p></div>';
}
async function loadResearchJobs(reset = true) {
  const query = new URLSearchParams({ limit: '20' });
  if (!reset && state.researchJobCursor) query.set('cursor', state.researchJobCursor);
  const result = await api(`/research-jobs?${query}`);
  state.researchJobs = reset ? result.items : [...state.researchJobs, ...result.items];
  state.researchJobTotal = result.total;
  state.researchJobCursor = result.next_cursor;
  renderResearchJobs();
}
async function loadIdentities(reset = true) {
  const query = new URLSearchParams({ limit: '20' });
  if (!reset && state.identityCursor) query.set('cursor', state.identityCursor);
  const result = await api(`/account-identity-reviews?${query}`);
  state.identities = reset ? result.items : [...state.identities, ...result.items];
  state.identityTotal = result.total;
  state.identityPendingTotal = result.pending_total;
  state.identityCursor = result.next_cursor;
  accountUI.renderIdentities();
}
async function loadChecks(reset = true) {
  const query = new URLSearchParams({ limit: '20' });
  if (!reset && state.capabilityCursor) query.set('cursor', state.capabilityCursor);
  const result = await api(`/factory-profile/checks?${query}`);
  state.capabilities = { ...state.capabilities, items: reset ? result.items : [...state.capabilities.items, ...result.items] };
  state.capabilityTotal = result.total;
  state.capabilityCursor = result.next_cursor;
  draftUI.renderCapabilities();
}
function renderResearchResults(result) {
  const job = result.job, items = result.items;
  $('#research-result-count').textContent = `返回 ${result.counts.returned} 个候选 · ${result.counts.not_fit} 个排除记录`;
  const summary = `<p class="sn-result-note">任务 ${escape(job.id.slice(0, 8))} · ${researchStatusLabels[job.status] || escape(job.status)} · ${job.source_mode === 'POOL' ? '仅分析品牌池' : '自动发现'} · ${researchStopLabels[job.stop_reason] || '无停止原因'}。预算：搜索 ${job.budget.usage.search_requests}/${job.budget.limits.search_requests} 次，费用 ${job.budget.usage.cost_usd}/${job.budget.limits.cost_usd} USD，运行 ${Math.round(job.budget.usage.runtime_ms / 1000)} 秒。</p>`;
  if (!items.length) {
    $('#research-results').innerHTML = summary + '<div class="sn-empty"><h3>本次没有可返回候选</h3><p>品牌池为空，或所有品牌都缺少基础资料。补齐品牌、产品和证据后重新研究。</p><a class="sn-text-link" href="#accounts">前往品牌池</a></div>';
    return;
  }
  $('#research-results').innerHTML = summary + items.map(item => `<article class="sn-task-row"><div class="sn-task-heading"><h3>${escape(item.brand_name)}</h3><span class="sn-task-status">${researchTierLabels[item.tier] || escape(item.tier)}</span></div><div class="sn-detail-metadata"><a href="${escape(item.website)}" target="_blank" rel="noopener noreferrer">${escape(item.website)}</a><span>证据 ${item.evidence.verified}/${item.evidence.total} 已核验 · 质量 ${escape(item.evidence.quality)}</span><span>${contactStatusLabels[item.contact.status] || escape(item.contact.status)}</span></div><p>${escape(item.reason)}</p>${item.tier !== 'NOT_FIT' && item.missing_information.length ? `<p class="sn-helper">待补：${item.missing_information.map(escape).join('；')}</p>` : ''}${Array.isArray(item.next_actions) && item.next_actions.length ? `<ul class="sn-next-actions">${item.next_actions.map(action => `<li>${escape(action)}</li>`).join('')}</ul>` : ''}<p class="sn-helper">${escape(item.evidence.quality_reason)}</p><p class="sn-helper">草稿：本轮未生成 AI 草稿；可在商机详情人工撰写。</p>${item.opportunity_id ? `<p class="sn-helper">已有商机：<a href="#opportunities/${escape(item.opportunity_id)}">${qualificationLabels[item.current_qualification_status] || escape(item.current_qualification_status || '')} · ${stageLabels[item.current_sales_stage] || escape(item.current_sales_stage || '')}</a>${item.is_new ? ' · 本次新建待审核商机' : ' · 复用既有商机，未覆盖审核与销售记录'}</p>` : item.tier === 'NOT_FIT' ? '<p class="sn-helper">已列入排除记录，不计入返回数量，不创建商机。</p>' : '<p class="sn-helper">品类未确认，未自动创建商机。</p>'}</article>`).join('');
}
async function loadResearchResults(jobId) {
  $('#research-results').innerHTML = '<p class="sn-muted">正在读取研究结果…</p>';
  try { renderResearchResults(await api(`/research-jobs/${encodeURIComponent(jobId)}/results`)); }
  catch (error) { $('#research-results').innerHTML = `<p role="alert">${escape(error.message)}</p>`; }
}
async function retryResearchJob(id) {
  try {
    const job = await api(`/research-jobs/${encodeURIComponent(id)}/retry`, 'POST', {});
    await refresh(); await loadResearchResults(job.id);
    notify('研究任务已重试，人工审核与销售记录不会覆盖。');
  } catch (error) { notify(error.message); }
}
async function cancelResearchJob(id) {
  if (!window.confirm('取消此研究任务？已完成的资料不会删除。')) return;
  try {
    await api(`/research-jobs/${encodeURIComponent(id)}/cancel`, 'POST', {});
    await refresh(); notify('研究任务已取消。');
  } catch (error) { notify(error.message); }
}
document.addEventListener('click', event => {
  const results = event.target.closest('[data-research-results]');
  if (results) loadResearchResults(results.dataset.researchResults);
  const retry = event.target.closest('[data-research-retry]');
  if (retry) retryResearchJob(retry.dataset.researchRetry);
  const cancel = event.target.closest('[data-research-cancel]');
  if (cancel) cancelResearchJob(cancel.dataset.researchCancel);
});
$('#research-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('[type="submit"]');
  clearError(form);
  const label = button.textContent;
  button.disabled = true; button.textContent = '正在整理…'; form.setAttribute('aria-busy', 'true');
  try {
    const job = await api('/research-jobs', 'POST', {
      market: form.elements.market.value, quantity: Number(form.elements.quantity.value),
      source_mode: form.elements.source_mode.value, min_evidence_quality: form.elements.min_evidence_quality.value,
    });
    await refresh();
    await loadResearchResults(job.id);
    notify(job.status === 'COMPLETED' ? '研究已完成。结果仅整理已保存资料，未自动确认合格商机。' : `研究任务状态：${researchStatusLabels[job.status] || job.status}。`);
  } catch (error) { formError(form, error); }
  finally {
    button.textContent = label; form.removeAttribute('aria-busy');
    button.disabled = state.workspace?.factory.status !== 'ACTIVE';
  }
});

const verificationLabels = { UNVERIFIED: '待核验', VERIFIED: '已人工核验', INVALIDATED: '已失效', STALE: '需重新核对' };
const qualificationLabels = { NEW: '新线索', REVIEWING: '审核中', NEEDS_EVIDENCE: '待补证据', QUALIFIED: '已合格', REJECTED: '不合格', ARCHIVED: '已归档', REASSESSMENT_REQUIRED: '需重新评估' };
const stageLabels = { NOT_STARTED: '未触达', CONTACTED: '已触达', REPLIED: '收到回复', MEETING: '已安排会议', SAMPLE: '样品阶段', QUOTATION: '已报价', WON: '已成交', LOST: '已丢单' };
const actionLabels = { START_REVIEW: '开始 / 恢复审核', QUALIFY: '标记合格', REQUEST_EVIDENCE: '要求补充证据', REJECT: '标记不合格', ARCHIVE: '归档', REOPEN: '重新开启审核', CREATED_MANUALLY: '人工创建', REASSESSMENT_REQUIRED: '转为待重评', ACTIVITY_RECORDED: '记录销售活动', ACTIVITY_VOIDED: '作废错误活动' };
const availableActions = {
  NEW: ['START_REVIEW', 'REQUEST_EVIDENCE', 'ARCHIVE'], REVIEWING: ['QUALIFY', 'REQUEST_EVIDENCE', 'REJECT', 'ARCHIVE'],
  NEEDS_EVIDENCE: ['START_REVIEW', 'ARCHIVE'], QUALIFIED: ['ARCHIVE'], REASSESSMENT_REQUIRED: ['START_REVIEW', 'ARCHIVE'], REJECTED: ['REOPEN'], ARCHIVED: ['REOPEN'],
};
const activityLabels = Object.fromEntries([...$('#activity-form').elements.activity_type.options].map(o => [o.value, o.textContent]));
const sentimentLabels = { POSITIVE: '正向回复', NEUTRAL: '中性回复', NEGATIVE: '负向回复', UNKNOWN: '回复性质待判断' };
let detailRequest = 0;
function renderOpportunities() {
  const filter = $('#opportunity-filter').value;
  const items = state.opportunities, total = state.opportunityTotal ?? items.length;
  $('#opportunity-count').textContent = `${items.length} / ${total} 个商机 · 人工录入`;
  const selected = location.hash.split('/')[1] || items[0]?.id;
  $('#opportunity-list').innerHTML = items.length
    ? items.map(x => `<a class="sn-opportunity-link" href="#opportunities/${escape(x.id)}" ${x.id === selected ? 'aria-current="true"' : ''}><strong>${escape(x.brand_name)}</strong><p>${qualificationLabels[x.qualification_status]} · ${stageLabels[x.sales_stage]}</p><p>洗衣凝珠 · 美国</p></a>`).join('') + (state.opportunityCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-opportunities-more>加载更多商机</button></div>' : '')
    : `<div class="sn-empty"><h2>${filter === 'ALL' ? '暂无商机' : '当前筛选没有商机'}</h2><p>从已知品牌开始，证据和审核记录会随商机一起保留。</p></div>`;
}
async function loadOpportunities(reset = true) {
  const query = new URLSearchParams({ limit: '20', status: $('#opportunity-filter').value });
  if (!reset && state.opportunityCursor) query.set('cursor', state.opportunityCursor);
  const result = await api(`/opportunities?${query}`);
  state.opportunities = reset ? result.items : [...state.opportunities, ...result.items];
  state.opportunityTotal = result.total;
  state.opportunityCursor = result.next_cursor;
  renderOpportunities();
  if (reset && location.hash.startsWith('#opportunities')) {
    const selected = location.hash.split('/')[1];
    if (selected && !state.opportunities.some(item => item.id === selected)) {
      location.hash = state.opportunities[0] ? `opportunities/${state.opportunities[0].id}` : 'opportunities';
    }
    await loadSelectedOpportunity();
  }
}
$('#opportunity-filter').addEventListener('change', () => loadOpportunities(true).catch(error => notify(error.message)));
async function loadSelectedOpportunity() {
  const id = location.hash.split('/')[1] || state.opportunities[0]?.id;
  const request = ++detailRequest;
  state.detail = null;
  renderOpportunities();
  if (!id) {
    $('#opportunity-detail').innerHTML = '<div class="sn-empty"><h2>从已知品牌开始审核</h2><p>先在品牌池录入品牌，再添加商机与原始证据。</p><a class="sn-text-link" href="#accounts">前往品牌池</a></div>';
    return;
  }
  $('#opportunity-detail').innerHTML = '<p class="sn-muted">正在读取商机详情…</p>';
  try {
    const [detail, drafts] = await Promise.all([api(`/opportunities/${encodeURIComponent(id)}`), api(`/opportunities/${encodeURIComponent(id)}/drafts`)]);
    detail.drafts = drafts.items;
    if (request !== detailRequest) return;
    state.detail = detail; renderOpportunityDetail();
  } catch (error) {
    if (request === detailRequest) $('#opportunity-detail').innerHTML = `<p role="alert">${escape(error.message)}</p>`;
  }
}
function renderOpportunityDetail() {
  const d = state.detail;
  const roles = { PRODUCT: '品牌 / 产品', MARKET: '美国在售', REASON: '开发理由' };
  $('#opportunity-detail').innerHTML = `
    <header class="sn-detail-header"><div><h2>${escape(d.brand_name)}</h2><p><a href="${escape(d.website)}" target="_blank" rel="noopener noreferrer">${escape(d.website)}</a></p></div><button class="sn-button" data-opportunity-review>审核商机</button></header>
    <div class="sn-detail-metadata"><span>资格：${qualificationLabels[d.qualification_status]}</span><span>销售：${stageLabels[d.sales_stage]}</span><span>版本 ${d.version} · 本地负责人</span></div>
    <div class="sn-result-note">${d.qualification_status === 'QUALIFIED' ? '已确认值得首次联系，采购意向与订单条件仍待核实。' : '这是人工维护的开发线索，尚无 AI 分析或自动采购意向判断。'}${d.factory_version ? ` 审核依据工厂版本 ${d.factory_version}。` : ''}</div>
    <section class="sn-detail-section"><h3>开发理由与待确认项</h3><p>${escape(d.reason)}</p><p class="sn-muted">${escape(d.pending_info || '采购量、MOQ、包装与交期需求待确认。')}</p></section>
    <section class="sn-detail-section"><div class="sn-section-heading"><h3>品牌产品与 SKU</h3><button class="sn-button sn-secondary" data-products-account="${escape(d.account_id)}">管理产品</button></div><p class="sn-helper">产品资料在品牌下维护。以下每条证据可关联具体产品，也可保留为品牌层级；同品牌多个产品仍复用此商机。</p></section>
    <section class="sn-detail-section"><div class="sn-section-heading"><h3>原始证据</h3><button class="sn-button sn-secondary" data-evidence-account="${escape(d.account_id)}">补充证据</button></div>
      ${d.references.length ? `<ul>${d.references.map(ref => `<li>${roles[ref.role]}：证据 ${escape(ref.evidence_id.slice(0, 8))}，审核时版本 ${ref.evidence_version}</li>`).join('')}</ul>` : '<p class="sn-helper">审核合格时，需要选择支持品类、美国在售和开发理由的证据。</p>'}
      ${d.evidence.map(evidenceRecord).join('') || '<p class="sn-muted">尚无证据。先保留原文，再核对来源。</p>'}
    </section>
    <section class="sn-detail-section"><div class="sn-section-heading"><h3>联系人</h3><button class="sn-button sn-secondary" data-contact-add>添加联系人</button></div>
      ${d.contacts.map(c => `<div class="sn-record"><h3>${escape(c.full_name)}${c.job_title ? ` / ${escape(c.job_title)}` : ''}</h3><p>${escape(c.email)}</p><p class="sn-helper">${c.suppression_reason ? `禁止联系：${escape(c.suppression_reason)}` : verificationLabels[c.verification_status]}</p><a href="${escape(c.source_url)}" target="_blank" rel="noopener noreferrer">查看联系人来源</a><div class="sn-actions"><button class="sn-button sn-secondary" data-contact-edit="${escape(c.id)}">编辑资料 / 历史</button>${!c.suppression_reason ? `<button class="sn-button sn-secondary" data-record="contact" data-id="${escape(c.id)}" data-action="verify">核验身份与渠道</button><button class="sn-button sn-secondary" data-record="contact" data-id="${escape(c.id)}" data-action="stale">标记失效</button><button class="sn-button sn-secondary" data-record="contact" data-id="${escape(c.id)}" data-action="suppress">禁止联系</button>` : ''}</div></div>`).join('') || '<p class="sn-muted">还没有联系人，可以记录公开的商务邮箱或职能邮箱。</p>'}
    </section>
    ${draftUI.render(d)}
    <section class="sn-detail-section"><div class="sn-section-heading"><h3>下一步跟进</h3><button class="sn-button sn-secondary" data-task-new="${escape(d.id)}">安排待办</button></div>${state.tasks.filter(t => t.opportunity_id === d.id).map(taskRow).join('') || '<p class="sn-muted">还没有安排下一步，可以设置截止时间并记录要确认的事项。</p>'}</section>
    <section class="sn-detail-section"><div class="sn-section-heading"><h3>销售活动</h3><button class="sn-button sn-secondary" data-activity-add>记录活动</button></div><p class="sn-helper">仅记录外部实际发生的活动，不发送邮件，不验证外部发送结果。</p>
      ${d.activities.map(a => `<div class="sn-record"><h3>${activityLabels[a.activity_type]}${a.voided_at ? ' · 已作废' : ''}</h3><p class="sn-helper">${date(a.occurred_at)}${a.full_name ? ` · ${escape(a.full_name)}${a.email ? ` / ${escape(a.email)}` : ''}` : ''} · 人工补录</p>${a.contact_snapshot ? `<p class="sn-helper">${JSON.parse(a.contact_snapshot).provenance === 'MIGRATED_CURRENT_RECORD' ? '联系人为升级时资料快照，未证明历史发送时身份。' : '联系人信息为录入此活动时保存的快照。'}</p>` : ''}${a.draft_version_id ? `<p class="sn-helper">已关联发送时的草稿版本：${escape(a.draft_version_id.slice(0, 8))}（内容见上方版本历史）</p>` : ''}${a.activity_type === 'REPLY_RECEIVED' ? `<p>${sentimentLabels[a.reply_sentiment]}</p>` : ''}${a.activity_type === 'DEAL_WON' ? `<p>成交金额：${a.amount_cents === null ? '未知' : `${(a.amount_cents / 100).toFixed(2)} ${escape(a.currency)}`}</p>` : ''}<p>${escape(a.notes)}</p>${a.voided_at ? `<p class="sn-helper">作废原因：${escape(a.void_reason)}</p>` : `<button class="sn-button sn-secondary" data-record="activity" data-id="${escape(a.id)}" data-action="void">更正误录</button>`}</div>`).join('') || '<p class="sn-muted">尚无销售活动。复制信息或查看联系人不会改变销售阶段。</p>'}
    </section>
    <details class="sn-history-details"><summary>审核与活动历史（${d.history.length} 条）</summary><ol>${d.history.map(h => `<li>${date(h.created_at)} · ${escape(actionLabels[h.action] || h.action)} · 本地负责人<br>${escape(h.reason)}${h.snapshot.from ? `<br>${qualificationLabels[h.snapshot.from]} → ${qualificationLabels[h.snapshot.to]}` : ''}</li>`).join('')}</ol></details>`;
}
function evidenceOptions() {
  return '<option value="">请选择已核验证据</option>' + state.detail.evidence.filter(e => e.verification_status === 'VERIFIED').map(e => `<option value="${escape(e.id)}">${escape(e.id.slice(0, 8))} · ${escape(e.raw_text.slice(0, 70))}</option>`).join('');
}
function openOpportunityReview() {
  if (!state.detail) return;
  const form = $('#opportunity-review-form'), d = state.detail;
  form.reset(); clearError(form); form.dataset.id = d.id; form.dataset.version = d.version;
  form.elements.action.innerHTML = availableActions[d.qualification_status].map(action => `<option value="${action}">${actionLabels[action]}</option>`).join('');
  form.elements.reason.value = d.reason;
  form.elements.pending_info.value = d.pending_info || '采购量、MOQ、包装条件及交期需求待确认。';
  for (const role of ['product', 'market', 'reason']) {
    const select = form.elements[`${role}_evidence_id`]; select.innerHTML = evidenceOptions();
    const previous = d.references.find(r => r.role === role.toUpperCase());
    if (previous) select.value = previous.evidence_id;
  }
  updateQualifyFields(); $('#opportunity-review-dialog').showModal();
}
function updateQualifyFields() {
  const form = $('#opportunity-review-form'), qualify = form.elements.action.value === 'QUALIFY';
  $('#qualify-fields').hidden = !qualify;
  $('#qualify-fields').querySelectorAll('input, select, textarea').forEach(input => { input.disabled = !qualify; input.required = qualify; });
}
$('#opportunity-review-form').elements.action.addEventListener('change', updateQualifyFields);
function openRecordAction(kind, id, action) {
  const record = kind === 'evidence' ? state.evidence.find(e => e.id === id) : kind === 'contact' ? state.detail?.contacts.find(c => c.id === id) : state.detail?.activities.find(a => a.id === id);
  if (!record) return;
  const form = $('#record-action-form'); form.reset(); clearError(form);
  form.dataset.path = kind === 'evidence' ? `/evidence/${id}/${action}` : kind === 'contact' ? `/contacts/${id}/${action}` : `/opportunities/${state.detail.id}/activities/${id}/void`;
  form.dataset.version = kind === 'activity' ? state.detail.version : record.version;
  const titles = { verify: '人工核验', invalidate: '标记证据失效', purge: '按保留政策清除原文', suppress: '禁止联系此渠道', stale: '标记联系人需重新核对', void: '作废误录活动' };
  $('#record-action-title').textContent = titles[action];
  $('#record-action-context').innerHTML = kind === 'evidence'
    ? action === 'purge'
      ? `<p>将永久清除这条证据的原文和核验备注，来源网址、时间、产品归属与审计记录保留。引用它的合格商机需重新评估，已批准草稿会被阻断。</p><p class="sn-helper">此操作不可恢复，重新导入相同原文也不会恢复内容。</p>`
      : `<p><a href="${escape(record.source_url)}" target="_blank" rel="noopener noreferrer">打开原始来源</a></p><blockquote class="sn-quote">${escape(record.raw_text)}</blockquote><p>核验出处、原文和品牌归属，不代表其产品问题或采购意向已被证实。失效后，引用它的合格商机需重新评估。</p>`
    : kind === 'contact' ? `<p>${escape(record.full_name)} · ${escape(record.email)}</p><a href="${escape(record.source_url)}" target="_blank" rel="noopener noreferrer">查看公开来源</a><p>禁止联系对本组织相同邮箱的所有记录生效，重复录入不会恢复。</p>` : '<p>原活动会保留并标为已作废，销售阶段根据其他有效活动重新计算。需要时再补记正确活动。</p>';
  $('#record-confirmation').hidden = !['verify', 'purge'].includes(action);
  form.elements.confirmed.required = ['verify', 'purge'].includes(action);
  $('#record-confirmation span').textContent = kind === 'evidence'
    ? (action === 'purge' ? '我确认清除原文且不可恢复，依赖它的批准将失效。' : '我已打开来源并核对原文和品牌归属。')
    : '我已核对公开来源中的身份、职能和联系渠道。';
  $('#record-action-dialog').showModal();
}
function openContactForm() {
  if (!state.detail) return;
  const form = $('#contact-form'); form.reset(); clearError(form); form.dataset.accountId = state.detail.account_id;
  $('#contact-dialog').showModal();
}
function openActivityForm() {
  if (!state.detail) return;
  const form = $('#activity-form'); form.reset(); clearError(form);
  form.dataset.id = state.detail.id; form.dataset.version = state.detail.version; form.dataset.key = crypto.randomUUID();
  form.elements.contact_id.innerHTML = '<option value="">未指定联系人</option>' + state.detail.contacts.map(c => `<option value="${escape(c.id)}">${escape(c.full_name)} / ${escape(c.email)}${c.suppression_reason ? '（禁止联系，仅补记历史）' : ''}</option>`).join('');
  const now = new Date(); const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  form.elements.occurred_at.value = local; form.elements.occurred_at.max = local;
  form.elements.draft_version_id.innerHTML = '<option value="">外部自行撰写 / 未关联</option>' + (state.detail.drafts || []).flatMap(d => d.versions.map(v => `<option value="${escape(v.id)}" data-contact="${escape(v.contact_id)}">${escape(v.subject.slice(0, 45))} · 版本 ${v.number}</option>`)).join('');
  updateActivityFields(); $('#activity-dialog').showModal();
}
function updateActivityFields() {
  const form = $('#activity-form'), type = form.elements.activity_type.value;
  $('#activity-draft-field').hidden = type !== 'EMAIL_SENT'; form.elements.draft_version_id.disabled = type !== 'EMAIL_SENT';
  $('#reply-fields').hidden = type !== 'REPLY_RECEIVED'; $('#deal-fields').hidden = type !== 'DEAL_WON';
  $('#sent-confirmation').hidden = type !== 'EMAIL_SENT'; form.elements.sent_confirmed.required = type === 'EMAIL_SENT';
  form.elements.notes.required = type === 'DEAL_LOST'; form.elements.contact_id.required = ['EMAIL_SENT', 'REPLY_RECEIVED'].includes(type);
}
$('#activity-form').elements.activity_type.addEventListener('change', updateActivityFields);
formHandler('#opportunity-form', async form => {
  const result = await api('/opportunities', 'POST', Object.fromEntries(new FormData(form)));
  await refresh(); $('#opportunity-dialog').close(); location.hash = `opportunities/${result.id}`;
  notify(result.reused ? '已打开现有商机，未覆盖原审核与跟进记录。' : '已添加待审核商机。请补充并核验支持事实的证据。');
});
formHandler('#opportunity-review-form', async form => {
  const data = Object.fromEntries(new FormData(form)); data.expected_version = Number(form.dataset.version);
  data.no_known_conflict = form.elements.no_known_conflict.checked; data.facts_confirmed = form.elements.facts_confirmed.checked;
  await api(`/opportunities/${form.dataset.id}/transitions`, 'POST', data);
  await refresh(); $('#opportunity-review-dialog').close(); notify('审核结果已保存，历史记录已保留。');
});
formHandler('#record-action-form', async form => {
  await api(form.dataset.path, 'POST', { expected_version: Number(form.dataset.version), reason: form.elements.reason.value, confirmed: form.elements.confirmed.checked });
  await refresh(); $('#record-action-dialog').close(); notify('核对结果已保存，相关商机状态已同步。');
});
formHandler('#contact-form', async form => {
  const result = await api('/contacts', 'POST', { ...Object.fromEntries(new FormData(form)), account_id: form.dataset.accountId });
  await refresh(); $('#contact-dialog').close(); notify(result.reused ? '已复用该品牌下的现有邮箱记录，原核验与禁止联系状态保持不变。' : '联系人已保存为待核验。');
});
formHandler('#activity-form', async form => {
  const data = Object.fromEntries(new FormData(form));
  data.occurred_at = new Date(data.occurred_at).toISOString(); data.expected_version = Number(form.dataset.version);
  data.idempotency_key = form.dataset.key; data.sent_confirmed = form.elements.sent_confirmed.checked;
  const result = await api(`/opportunities/${form.dataset.id}/activities`, 'POST', data);
  await refresh(); $('#activity-dialog').close(); notify(result.warning || '实际销售活动已记录。系统未发送任何邮件。');
});

const taskLabels = { OPEN: '待处理', DONE: '已完成', CANCELLED: '已取消' };
const localInput = value => {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
function taskRow(t) {
  const overdue = t.status === 'OPEN' && Date.parse(t.due_at) < Date.now();
  return `<article class="sn-task-row"><div class="sn-task-heading"><h3>${escape(t.title)}</h3><span class="sn-task-status ${overdue ? 'sn-task-overdue' : ''}">${overdue ? '已逾期 · 待处理' : taskLabels[t.status]}</span></div><div class="sn-detail-metadata"><a href="#opportunities/${escape(t.opportunity_id)}">${escape(t.brand_name)}</a><span>截止 ${date(t.due_at)}</span><span>本地负责人</span></div>${t.notes ? `<p>${escape(t.notes)}</p>` : ''}${t.closed_at ? `<p class="sn-helper">${taskLabels[t.status]}于 ${date(t.closed_at)}</p>` : ''}<p class="sn-helper">商机：${qualificationLabels[t.qualification_status]} · ${stageLabels[t.sales_stage]}</p><div class="sn-actions"><button class="sn-button sn-secondary" data-task-edit="${escape(t.id)}">编辑待办</button>${t.status === 'OPEN' ? `<button class="sn-button sn-secondary" data-task-edit="${escape(t.id)}" data-task-status="DONE">标记完成</button>` : `<button class="sn-button sn-secondary" data-task-edit="${escape(t.id)}" data-task-status="OPEN">重新开启</button>`}</div></article>`;
}
function taskQueryFor(status) {
  const query = new URLSearchParams({ limit: '20', status });
  if (status === 'TODAY') {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 86400000);
    query.set('from', start.toISOString());
    query.set('to', end.toISOString());
  }
  return query;
}
function renderFollowups() {
  const items = state.tasks, total = state.taskTotal ?? items.length;
  $('#followup-count').textContent = `${items.length} / ${total} 条待办`;
  $('#followup-list').innerHTML = (items.map(taskRow).join('') + (state.taskCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-tasks-more>加载更多待办</button></div>' : '')) || '<div class="sn-empty"><h2>当前范围没有待办</h2><p>在商机详情中安排下一步，或选择其他状态查看历史。</p><a class="sn-text-link" href="#opportunities">前往商机跟进</a></div>';
  const upcoming = state.upcomingTasks || [];
  $('#home-followups').innerHTML = upcoming.map(taskRow).join('') || '<div class="sn-empty"><h3>还没有安排跟进事项</h3><p>从商机中记录下一步与截止时间，待处理事项会按时间出现在这里。</p><a class="sn-text-link" href="#opportunities">查看商机</a></div>';
}
async function loadTasks(reset = true) {
  const query = taskQueryFor($('#followup-filter').value);
  if (!reset && state.taskCursor) query.set('cursor', state.taskCursor);
  const result = await api(`/follow-up-tasks?${query}`);
  state.tasks = reset ? result.items : [...state.tasks, ...result.items];
  state.taskTotal = result.total;
  state.taskCursor = result.next_cursor;
  renderFollowups();
}
$('#followup-filter').addEventListener('change', () => loadTasks(true).catch(error => notify(error.message)));
function openFollowupForm(taskId, opportunityId, nextStatus) {
  const form = $('#followup-form'), task = taskId ? state.tasks.find(t => t.id === taskId) : null;
  if (taskId && !task) return;
  form.reset(); clearError(form);
  form.dataset.id = task?.id || ''; form.dataset.version = task?.version || '';
  form.dataset.key = crypto.randomUUID(); form.dataset.originalStatus = task?.status || '';
  form.elements.opportunity_id.innerHTML = '<option value="">请选择商机</option>' + state.opportunityOptions.map(o => `<option value="${escape(o.id)}">${escape(o.brand_name)} · ${qualificationLabels[o.qualification_status]}</option>`).join('');
  form.elements.opportunity_id.value = task?.opportunity_id || opportunityId || '';
  form.elements.opportunity_id.disabled = !!task;
  form.elements.title.value = task?.title || ''; form.elements.notes.value = task?.notes || '';
  form.elements.due_at.value = localInput(task?.due_at || Date.now() + 86400000);
  form.elements.status.value = nextStatus || task?.status || 'OPEN';
  form.elements.status.disabled = !task; $('#followup-status-field').hidden = !task;
  $('#followup-form-title').textContent = task ? '更新跟进待办' : '新增跟进待办';
  updateTaskReason(); $('#followup-dialog').showModal();
}
function updateTaskReason() {
  const form = $('#followup-form');
  const changed = !!form.dataset.id && form.elements.status.value !== form.dataset.originalStatus;
  $('#followup-reason-field').hidden = !changed; form.elements.reason.required = changed; form.elements.reason.disabled = !changed;
}
$('#followup-form').elements.status.addEventListener('change', updateTaskReason);
formHandler('#followup-form', async form => {
  const body = Object.fromEntries(new FormData(form)); body.due_at = new Date(body.due_at).toISOString();
  if (form.dataset.id) body.expected_version = Number(form.dataset.version);
  else body.idempotency_key = form.dataset.key;
  await api(`/follow-up-tasks${form.dataset.id ? `/${form.dataset.id}` : ''}`, form.dataset.id ? 'PATCH' : 'POST', body);
  await refresh(); $('#followup-dialog').close(); notify('待办已保存。销售阶段与实际活动记录保持不变。');
});

const analyticsForm = $('#analytics-form');
const initialReportTime = new Date();
analyticsForm.elements.from.value = new Date(initialReportTime.getTime() - 29 * 86400000).toISOString().slice(0, 10);
analyticsForm.elements.to.value = initialReportTime.toISOString().slice(0, 10);
let analyticsRequest = 0;
async function loadAnalytics() {
  clearError(analyticsForm);
  const request = ++analyticsRequest;
  const values = new FormData(analyticsForm), query = new URLSearchParams();
  query.set('from', values.get('from')); query.set('to', values.get('to'));
  if (values.get('as_of')) query.set('as_of', new Date(values.get('as_of')).toISOString());
  $('#analytics-results').innerHTML = '<p class="sn-muted">正在统计这批商机…</p>';
  try {
    const report = await api(`/analytics/funnel?${query}`);
    if (request !== analyticsRequest) return;
    renderAnalytics(report);
  } catch (error) {
    if (request !== analyticsRequest) return;
    $('#analytics-results').innerHTML = '<p class="sn-muted">本次统计未完成，请检查日期条件后重试。</p>';
    throw error;
  }
}
function renderAnalytics(report) {
  const m = report.metrics, f = report.filters;
  const metrics = [
    ['候选商机', m.candidates, '按首次创建日期纳入，包含后续被拒绝、归档的记录。'],
    ['首次已审核', m.reviewed, '首次结论为合格或不合格；待补证据、未审归档不计入。'],
    ['首次审核合格', m.qualified, '首次审核结论为合格；重评或重开不重复计数。'],
    ['已触达', m.contacted, '有未作废的人工邮件发送记录。'],
    ['正向回复', m.positive_replies, '有未作废且人工标为正向的回复。'],
    ['已安排会议', m.meetings, '有未作废的会议安排记录，不表示已开会。'],
    ['样品请求', m.sample_requests, '有未作废的样品请求记录。'],
    ['已报价', m.quotations, '有未作废的报价记录。'],
    ['已成交', m.won, '有未作废的成交记录。'],
    ['已丢单', m.lost, '有未作废的丢单记录。'],
  ];
  const rate = m.qualification_rate === null ? 'N/A' : new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 }).format(m.qualification_rate);
  $('#analytics-results').innerHTML = `${!m.candidates ? '<p class="sn-result-note">所选日期内暂无商机。可以调整创建日期范围，或先在商机跟进中添加已有品牌。</p>' : ''}<div class="sn-report-summary"><div><h2>首次审核合格率</h2><strong class="sn-report-rate">${rate}</strong><p class="sn-helper">${m.qualified} 个首次合格 / ${m.reviewed} 个首次已审核${m.reviewed ? '' : '，暂无可计算分母'}</p></div><div class="sn-report-current"><h2>这批商机的当前状态</h2><p>当前合格 ${report.current.qualified} 个 · 待重评 ${report.current.reassessment_required} 个 · 待审核或补资料 ${report.current.pending} 个</p><p class="sn-helper">以上为查询时的当前状态；与首次审核结论分开，不改写历史合格率。</p></div></div>
    <p class="sn-helper sn-scroll-hint">表格可左右滚动查看统计依据。</p><div class="sn-table-region" tabindex="0" role="region" aria-label="商机去重统计表"><table class="sn-table sn-report-table"><caption>${escape(f.from)} 至 ${escape(f.to)}（UTC）创建的商机，每个阶段按商机去重</caption><thead><tr><th scope="col">阶段</th><th scope="col" class="sn-numeric">商机数</th><th scope="col">统计依据</th></tr></thead><tbody>${metrics.map(([label, value, rule]) => `<tr><th scope="row">${label}</th><td class="sn-numeric">${value}</td><td>${rule}</td></tr>`).join('')}</tbody></table></div>
    <div class="sn-report-footnote"><p>观察截止：${escape(f.as_of.replace('T', ' ').replace('Z', ' UTC'))}。生成时间：${escape(report.generated_at.replace('T', ' ').replace('Z', ' UTC'))}。</p><p>范围：本地工作空间 · 本地负责人 · 洗衣凝珠 · 美国。活动按实际发生时间统计，已作废活动排除；后补或更正历史记录可能改变往期结果。</p><p>允许业务阶段跳跃，各行不要求逐级递减。当前没有自动研究任务，以上反映人工维护的商机，不代表 Agent 的获客效果。</p></div>`;
}
formHandler('#analytics-form', async () => { await loadAnalytics(); });
$('#activity-form').elements.draft_version_id.addEventListener('change', () => {
  const form = $('#activity-form'), option = form.elements.draft_version_id.selectedOptions[0];
  if (option.dataset.contact) form.elements.contact_id.value = option.dataset.contact;
});
setupContacts({ api, refresh, notify, escape, formHandler, date });
const accountUI = setupAccounts({ api, state, refresh, notify, escape, formHandler, date });
const transferUI = setupTransfer({ api, state, refresh, notify, escape, formHandler });
const productUI = setupProducts({ api, state, refresh, notify, escape, formHandler, date });
const draftUI = setupDrafts({ api, state, refresh, notify, escape, formHandler, date });
startAuth({ onAuthenticated: refresh, notify, dirty: () => state.factoryDirty, clearDirty: () => { state.factoryDirty = false; } });
