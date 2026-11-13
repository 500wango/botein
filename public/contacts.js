const $ = selector => document.querySelector(selector);
export function setupContacts({ api, refresh, notify, escape, formHandler, date }) {
  let items = [], suppressions = [], contactTotal = 0, suppressionTotal = 0;
  let contactCursor = null, suppressionCursor = null, editRequest = 0, filterTimer;
  const statuses = { VERIFIED:'已人工核验', UNVERIFIED:'待核验', STALE:'需重新核对' };
  async function loadContacts(reset = true) {
    const query = new URLSearchParams({ limit: '20' });
    const term = $('#contact-directory-filter').value.trim(); if (term) query.set('q', term);
    if (!reset && contactCursor) query.set('cursor', contactCursor);
    const result = await api(`/contacts?${query}`);
    items = reset ? result.items : [...items, ...result.items];
    contactTotal = result.total; contactCursor = result.next_cursor;
    renderDirectory();
  }
  async function loadSuppressions(reset = true) {
    const query = new URLSearchParams({ limit: '20' });
    if (!reset && suppressionCursor) query.set('cursor', suppressionCursor);
    const result = await api(`/contact-suppressions?${query}`);
    suppressions = reset ? result.items : [...suppressions, ...result.items];
    suppressionTotal = result.total; suppressionCursor = result.next_cursor;
    renderDirectory();
  }
  async function loadDirectory() { await Promise.all([loadContacts(true), loadSuppressions(true)]); }
  function renderDirectory() {
    $('#contact-directory-list').innerHTML = `<p class="sn-helper">${items.length} / ${contactTotal} 条联系人记录</p>` +
      (items.map(c => `<article class="sn-product-entry"><h3>${escape(c.full_name)}</h3><p>${escape(c.brand_name)} · ${escape(c.job_title || '职能未知')}</p><p>${escape(c.email)}</p><p class="sn-helper">${c.suppression_reason ? `禁止联系：${escape(c.suppression_reason)}` : statuses[c.verification_status]}</p><button type="button" class="sn-button sn-secondary" data-contact-edit="${escape(c.id)}">编辑资料 / 历史</button></article>`).join('') || '<p class="sn-muted">暂无符合条件的联系人，可在商机详情添加。</p>') +
      (contactCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-contacts-more>加载更多联系人</button></div>' : '');
    $('#contact-suppressions-list').innerHTML = `<p class="sn-helper">${suppressions.length} / ${suppressionTotal} 条禁止联系记录</p>` +
      (suppressions.map(s => `<article class="sn-product-entry"><h3>${escape(s.email)}</h3><p>${escape(s.reason)}</p><p class="sn-helper">${date(s.created_at)} · 影响 ${s.contact_count} 条联系人记录</p></article>`).join('') || '<p class="sn-muted">当前没有禁止联系记录。</p>') +
      (suppressionCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-suppressions-more>加载更多禁止联系记录</button></div>' : '');
  }
  $('#contact-directory-filter').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => loadContacts(true).catch(error => notify(error.message)), 250);
  });
  $('#open-contact-directory').addEventListener('click', async () => {
    $('#contact-directory-filter').value = ''; $('#contact-directory-list').textContent = '正在读取…'; $('#contact-suppressions-list').replaceChildren();
    $('#contact-directory-dialog').showModal();
    try { await loadDirectory(); } catch (error) { $('#contact-directory-list').textContent = error.message; }
  });
  async function openEdit(id) {
    const token = ++editRequest, form = $('#contact-edit-form');
    form.reset(); form.querySelector('.sn-form-error').hidden = true;
    form.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid'));
    form.dataset.id = id; form.querySelector('[type="submit"]').disabled = true;
    $('#contact-edit-context').textContent = '正在读取…'; $('#contact-edit-history').replaceChildren();
    $('#contact-directory-dialog').close(); $('#contact-edit-dialog').showModal();
    try {
      const contact = await api(`/contacts/${encodeURIComponent(id)}`); if (token !== editRequest) return;
      form.dataset.version = contact.version;
      for (const key of ['full_name','job_title','email','source_url']) form.elements[key].value = contact[key];
      $('#contact-edit-context').textContent = `${contact.brand_name} · ${contact.suppression_reason ? `禁止联系：${contact.suppression_reason}` : statuses[contact.verification_status]} · 版本 ${contact.version}`;
      const actionLabels = { CONTACT_RECORDED:'录入',CONTACT_UPDATED:'修改资料',CONTACT_VERIFY:'人工核验',CONTACT_STALE:'标记失效',CONTACT_SUPPRESS:'禁止联系' };
      $('#contact-edit-history').innerHTML = `<ol class="sn-history">${contact.history.map(h => `<li>${date(h.created_at)} · ${actionLabels[h.action] || escape(h.action)}<p>${escape(h.details.reason || '初次录入')}</p>${h.details.before ? `<p>姓名：${escape(h.details.before.full_name)} → ${escape(h.details.after.full_name)}<br>职能：${escape(h.details.before.job_title || '未填写')} → ${escape(h.details.after.job_title || '未填写')}<br>来源：${escape(h.details.before.source_url)} → ${escape(h.details.after.source_url)}</p>` : ''}</li>`).join('')}</ol>`;
      form.querySelector('[type="submit"]').disabled = false;
    } catch (error) { if (token === editRequest) $('#contact-edit-context').textContent = error.message; }
  }
  formHandler('#contact-edit-form', async form => {
    const result = await api(`/contacts/${form.dataset.id}`, 'PATCH', { ...Object.fromEntries(new FormData(form)), expected_version: Number(form.dataset.version) });
    await refresh(); $('#contact-edit-dialog').close(); notify(result.unchanged ? '联系人资料未变化。' : '联系人资料已保存，需要重新核验；原草稿批准不继承，历史快照保留。');
  });
  document.addEventListener('click', event => {
    const edit = event.target.closest('[data-contact-edit]'); if (edit) openEdit(edit.dataset.contactEdit).catch(error => notify(error.message));
    if (event.target.closest('[data-contacts-more]')) loadContacts(false).catch(error => notify(error.message));
    if (event.target.closest('[data-suppressions-more]')) loadSuppressions(false).catch(error => notify(error.message));
  });
}
