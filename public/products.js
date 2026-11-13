const $ = selector => document.querySelector(selector);
const categoryLabels = { LAUNDRY_PODS: '洗衣凝珠', DISHWASHER_TABLETS: '洗碗块 · 范围外', OTHER: '其他品类 · 范围外', UNKNOWN: '品类待确认' };
export function setupProducts({ api, state, refresh, notify, escape, formHandler, date }) {
  let accountId = '', products = [], productTotal = 0, productCursor = null, request = 0, selectorRequest = 0;
  const clearError = form => { form.querySelector('.sn-form-error').hidden = true; form.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid')); };
  function productSnapshot(details) {
    const fields = { product_name: '名称', product_category: '品类', product_url: '原始链接', external_sku: 'SKU', marketplace: '平台', packaging_type: '包装', notes: '备注', status: '资料状态' };
    const show = value => value == null || value === '' ? '未填写' : String(value);
    const row = details.after || details.data || {};
    return `<dl class="sn-product-changes">${Object.entries(fields).filter(([key]) => !details.changed || details.changed.includes(key)).map(([key,label]) => `<dt>${label}</dt><dd>${details.before ? `${escape(show(details.before[key]))} → ` : ''}${escape(show(row[key]))}</dd>`).join('')}</dl>`;
  }
  function evidenceLabel(e) {
    return `<p class="sn-helper">${e.product_id ? `关联产品：${escape(e.product_name || '产品资料暂不可用')} · ${escape(categoryLabels[e.product_category] || '待确认')}${e.product_status === 'ARCHIVED' ? ' · 已归档' : ''} · 关联时的产品版本 ${e.product_version ?? '未知'}` : '品牌层级证据 · 具体产品 / SKU 未确认'}</p>`;
  }
  function options(items) {
    return '<option value="">品牌层级，具体产品未确认</option>' + items.filter(p => p.status === 'ACTIVE').map(p => `<option value="${escape(p.id)}">${escape(p.product_name)} · ${categoryLabels[p.product_category]}${p.external_sku ? ` · ${escape(p.external_sku)}` : ''}</option>`).join('');
  }
  async function openProducts(id) {
    accountId = id; request++; products = []; productCursor = null;
    $('#products-title').textContent = `${state.accountOptions.find(a => a.id === id)?.brand_name || '品牌'}的产品`;
    $('#new-product').disabled = true;
    if (!$('#products-dialog').open) $('#products-dialog').showModal();
    await loadProducts(true);
  }
  function renderProducts() {
    $('#products-list').innerHTML = `<p class="sn-helper">${products.length} / ${productTotal} 个产品</p>` +
      (products.length ? products.map(p => `<article class="sn-product-entry"><div class="sn-section-heading"><h3>${escape(p.product_name)}</h3><span class="sn-state">${p.status === 'ARCHIVED' ? '已归档' : '资料已录入'} · v${p.version}</span></div><p>${categoryLabels[p.product_category]}</p><p class="sn-helper">SKU：${escape(p.external_sku || '未知')} · 平台：${escape(p.marketplace || '未填写')}<br>包装：${escape(p.packaging_type || '未知')} · 关联证据 ${p.evidence_count} 条</p><a href="${escape(p.product_url)}" target="_blank" rel="noopener noreferrer">${escape(p.product_url)}</a>${p.notes ? `<p>${escape(p.notes)}</p>` : ''}<div class="sn-actions"><button class="sn-button sn-secondary" data-product-edit="${escape(p.id)}">编辑 / 归档</button><button class="sn-button sn-secondary" data-product-history="${escape(p.id)}">查看变更记录</button></div><div id="product-history-${escape(p.id)}"></div></article>`).join('') : '<div class="sn-empty"><h3>还没有产品资料</h3><p>记录品牌已公开的产品链接、品类和平台编号，未知参数可以留空。</p></div>') +
      (productCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-products-more>加载更多产品</button></div>' : '');
  }
  async function loadProducts(reset = true) {
    const token = request;
    const query = new URLSearchParams({ limit: '20' });
    if (!reset && productCursor) query.set('cursor', productCursor);
    $('#products-list').innerHTML = '<p class="sn-muted">正在读取产品资料…</p>';
    try {
      const result = await api(`/accounts/${encodeURIComponent(accountId)}/products?${query}`);
      if (token !== request) return;
      products = reset ? result.items : [...products, ...result.items];
      productTotal = result.total; productCursor = result.next_cursor;
      $('#new-product').disabled = false;
      renderProducts();
    } catch (error) { if (token === request) $('#products-list').innerHTML = `<p role="alert">${escape(error.message)}</p>`; }
  }
  function editProduct(id) {
    const p = id ? products.find(p => p.id === id) : null;
    if (id && !p) return;
    const form = $('#product-editor-form'); form.reset(); clearError(form);
    form.dataset.accountId = accountId; form.dataset.id = p?.id || ''; form.dataset.version = p?.version || '';
    for (const name of ['product_name', 'product_category', 'product_url', 'external_sku', 'marketplace', 'packaging_type', 'notes', 'status']) {
      form.elements[name].value = p?.[name] ?? (name === 'product_category' ? 'LAUNDRY_PODS' : name === 'status' ? 'ACTIVE' : '');
    }
    form.elements.reason.required = !!p; $('#product-change-reason').hidden = !p;
    $('#product-editor-title').textContent = p ? '编辑品牌产品' : '新增品牌产品';
    $('#products-dialog').close(); $('#product-editor-dialog').showModal();
  }
  $('#new-product').addEventListener('click', () => editProduct());
  formHandler('#product-editor-form', async form => {
    const body = Object.fromEntries(new FormData(form)); body.expected_version = Number(form.dataset.version);
    const result = await api(`/accounts/${form.dataset.accountId}/products${form.dataset.id ? `/${form.dataset.id}` : ''}`, form.dataset.id ? 'PATCH' : 'POST', body);
    await refresh(); $('#product-editor-dialog').close(); await openProducts(form.dataset.accountId);
    notify(result.reused ? '产品已存在，已复用原记录。' : result.unchanged ? '产品资料未变化。' : '产品已保存；核心资料变化会同步要求关联证据重新核验。');
  });
  async function showHistory(button) {
    const selectedAccount = accountId; button.disabled = true;
    try {
      const product = await api(`/accounts/${selectedAccount}/products/${button.dataset.productHistory}`);
      const target = document.getElementById(`product-history-${product.id}`);
      if (!target || accountId !== selectedAccount) return;
      target.innerHTML = `<ol class="sn-history">${product.history.map(h => `<li>${date(h.created_at)} · ${h.action === 'PRODUCT_CREATED' ? '创建产品' : '修改产品'} · 本地负责人<br>${escape(h.details.reason || '初次录入')}<details><summary>当时的产品资料</summary>${productSnapshot(h.details)}</details></li>`).join('')}</ol>`;
    } catch (error) { notify(error.message); } finally { button.disabled = false; }
  }
  async function populateEvidenceProducts() {
    const form = $('#evidence-form'), brand = form.elements.account_id.value, token = ++selectorRequest;
    const select = form.elements.product_id, submit = form.querySelector('[type="submit"]');
    select.innerHTML = '<option value="">正在读取产品…</option>'; select.disabled = true; submit.disabled = true;
    try {
      const data = await api(`/accounts/${encodeURIComponent(brand)}/products/options`);
      if (token !== selectorRequest) return;
      select.innerHTML = options(data.items); select.disabled = false; submit.disabled = false;
      $('#evidence-product-hint').textContent = '选择对应产品；无法确认时留在品牌层级。没有列出的产品可先在品牌池录入。';
    } catch (error) {
      if (token === selectorRequest) { $('#evidence-product-hint').textContent = `产品读取失败：${error.message} 请关闭后重试。`; }
    }
  }
  $('#evidence-form').elements.account_id.addEventListener('change', populateEvidenceProducts);
  async function linkEvidence(id) {
    const e = state.evidence.find(e => e.id === id); if (!e) return;
    const form = $('#evidence-product-form'); form.reset(); clearError(form);
    form.dataset.id = e.id; form.dataset.version = e.version;
    const selected = form.elements.product_id, submit = form.querySelector('[type="submit"]');
    selected.innerHTML = '<option value="">正在读取…</option>'; selected.disabled = true; submit.disabled = true;
    $('#evidence-product-preview').innerHTML = `<p>${escape(e.brand_name)}</p>${evidenceLabel(e)}<blockquote class="sn-quote">${escape(e.raw_text)}</blockquote>`;
    $('#evidence-product-dialog').showModal();
    try {
      const result = await api(`/accounts/${e.account_id}/products/options`);
      if (form.dataset.id !== e.id) return;
      selected.innerHTML = options(result.items);
      const current = result.items.find(p => p.id === e.product_id);
      if (current?.status === 'ARCHIVED') selected.insertAdjacentHTML('beforeend', `<option value="${escape(current.id)}" disabled>${escape(current.product_name)}（已归档，请改选或保留品牌层级）</option>`);
      selected.value = e.product_id || ''; selected.disabled = false; submit.disabled = false;
    } catch (error) { form.querySelector('.sn-form-error').hidden = false; form.querySelector('.sn-form-error').textContent = error.message; }
  }
  formHandler('#evidence-product-form', async form => {
    await api(`/evidence/${form.dataset.id}/product`, 'PATCH', { expected_version: Number(form.dataset.version), product_id: form.elements.product_id.value || null, reason: form.elements.reason.value });
    await refresh(); $('#evidence-product-dialog').close(); notify('产品归属已保存；发生变更的证据需重新核验，原文与审核历史保留。');
  });
  document.addEventListener('click', event => {
    const manage = event.target.closest('[data-products-account]'); if (manage) openProducts(manage.dataset.productsAccount);
    const edit = event.target.closest('[data-product-edit]'); if (edit) editProduct(edit.dataset.productEdit);
    const history = event.target.closest('[data-product-history]'); if (history) showHistory(history);
    const link = event.target.closest('[data-evidence-product]'); if (link) linkEvidence(link.dataset.evidenceProduct);
    if (event.target.closest('[data-products-more]')) loadProducts(false).catch(error => notify(error.message));
  });
  return { evidenceLabel, populateEvidenceProducts };
}
