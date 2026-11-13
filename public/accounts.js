const $ = selector => document.querySelector(selector);
const statusLabels = { PENDING: '待核对', DISTINCT: '已确认为独立品牌', REUSED: '已复用现有品牌', REJECTED: '已排除' };
export function setupAccounts({ api, state, refresh, notify, escape, formHandler, date }) {
  const clearError = form => { form.querySelector('.sn-form-error').hidden = true; form.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid')); };
  function candidateMarkup(c) {
    return `<h3>${escape(c.brand_name)}</h3><p><a href="${escape(c.website)}" target="_blank" rel="noopener noreferrer">${escape(c.website)}</a></p><p class="sn-helper">总部国家：${escape(c.headquarters_country || '未知')}<br>备注：${escape(c.notes || '未填写')}</p>`;
  }
  function renderIdentities() {
    const items = state.identities || [], pending = items.filter(r => r.status === 'PENDING');
    $('#identity-count').textContent = `${state.identityPendingTotal ?? pending.length} 条待核对 / ${state.identityTotal ?? items.length} 条记录（已加载 ${items.length}）`;
    const row = r => `<article class="sn-product-entry">${candidateMarkup(r.candidate)}<p class="sn-helper">${statusLabels[r.status]} · ${date(r.created_at)}${r.reason ? `<br>${escape(r.reason)}` : ''}</p><button class="sn-button sn-secondary" data-identity="${escape(r.id)}">${r.status === 'PENDING' ? '核对身份' : '查看 / 重新开启'}</button></article>`;
    $('#identity-list').innerHTML = (pending.map(row).join('') || '<p class="sn-muted">当前没有待处理的同域名身份冲突。</p>') + (items.length > pending.length ? `<details class="sn-history-details"><summary>已处理记录（${items.length - pending.length}）</summary>${items.filter(r => r.status !== 'PENDING').map(row).join('')}</details>` : '') + (state.identityCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-identities-more>加载更多核对记录</button></div>' : '');
  }
  async function openEdit(id) {
    const form = $('#account-edit-form');
    form.reset(); clearError(form); form.dataset.id = id;
    form.querySelector('[type="submit"]').disabled = true;
    $('#account-edit-history').textContent = '正在读取品牌资料…';
    $('#account-edit-dialog').showModal();
    try {
      const item = await api(`/accounts/${encodeURIComponent(id)}`);
      if (form.dataset.id !== id) return;
      form.dataset.version = item.version;
      for (const key of ['brand_name', 'website', 'headquarters_country', 'notes']) form.elements[key].value = item[key];
      $('#account-edit-history').innerHTML = `<ol class="sn-history">${item.history.map(h => `<li>${date(h.created_at)} · ${h.action === 'ACCOUNT_CREATED' ? '创建品牌' : '修改品牌'}<p>${escape(h.details.reason || '初次录入')}</p>${h.details.before ? `<p>名称：${escape(h.details.before.brand_name)} → ${escape(h.details.after.brand_name)}<br>官网：${escape(h.details.before.website)} → ${escape(h.details.after.website)}<br>总部：${escape(h.details.before.headquarters_country || '未知')} → ${escape(h.details.after.headquarters_country || '未知')}<br>备注：${escape(h.details.before.notes || '未填写')} → ${escape(h.details.after.notes || '未填写')}</p>` : ''}</li>`).join('')}</ol>`;
      form.querySelector('[type="submit"]').disabled = false;
    } catch (error) { $('#account-edit-history').textContent = error.message; }
  }
  formHandler('#account-edit-form', async form => {
    const result = await api(`/accounts/${form.dataset.id}`, 'PATCH', { ...Object.fromEntries(new FormData(form)), expected_version: Number(form.dataset.version), shared_domain_confirmed: form.elements.shared_domain_confirmed.checked });
    await refresh(); $('#account-edit-dialog').close(); notify(result.unchanged ? '资料未变化。' : '品牌资料已更新，涉及身份变更的资料需要重新核验。');
  });
  function updateAction() {
    const form = $('#identity-form'), action = form.elements.action.value;
    $('#identity-target-field').hidden = action !== 'REUSE'; form.elements.target_account_id.required = action === 'REUSE'; form.elements.target_account_id.disabled = action !== 'REUSE';
    const confirm = ['DISTINCT', 'REUSE'].includes(action);
    $('#identity-confirm-field').hidden = !confirm; form.elements.confirmed.required = confirm;
  }
  $('#identity-form').elements.action.addEventListener('change', updateAction);
  function openIdentity(id) {
    const item = state.identities.find(r => r.id === id); if (!item) return;
    const form = $('#identity-form'); form.reset(); clearError(form); form.dataset.id = id; form.dataset.version = item.version;
    $('#identity-preview').innerHTML = `${candidateMarkup(item.candidate)}<h3>同域名的已有记录</h3>${item.matches.map(a => `<p>${escape(a.brand_name)} · 版本 ${a.version}<br><a href="${escape(a.website)}" target="_blank" rel="noopener noreferrer">${escape(a.website)}</a><br>${escape(a.notes)}</p>`).join('') || '<p>当前没有同域名记录，请核对后处理。</p>'}<details class="sn-history-details"><summary>身份处理历史</summary><ol>${item.history.map(h => `<li>${date(h.created_at)} · ${escape(h.details.reason || '初次发现同域名身份冲突')}${h.details.action ? ` · ${escape({ DISTINCT:'确认独立', REUSE:'复用已有', REJECT:'排除' }[h.details.action] || h.details.action)}` : ''}</li>`).join('')}</ol></details>`;
    form.elements.action.innerHTML = item.status === 'PENDING' ? '<option value="DISTINCT">这是独立品牌，新增记录</option><option value="REUSE">这是现有品牌，复用记录</option><option value="REJECT">排除此候选，不创建品牌</option>' : '<option value="REOPEN">重新开启身份核对</option>';
    form.elements.target_account_id.innerHTML = '<option value="">请选择现有品牌</option>' + item.matches.map(a => `<option value="${escape(a.id)}" data-version="${a.version}">${escape(a.brand_name)}</option>`).join('');
    updateAction(); $('#identity-dialog').showModal();
  }
  formHandler('#identity-form', async form => {
    const data = Object.fromEntries(new FormData(form));
    data.expected_version = Number(form.dataset.version); data.confirmed = form.elements.confirmed.checked;
    data.target_expected_version = Number(form.elements.target_account_id.selectedOptions[0]?.dataset.version);
    await api(`/account-identity-reviews/${form.dataset.id}/resolve`, 'POST', data);
    await refresh(); $('#identity-dialog').close(); notify('身份结论已保存。已有品牌、产品和销售历史未被搬移或合并。');
  });
  document.addEventListener('click', event => {
    const edit = event.target.closest('[data-account-edit]'); if (edit) openEdit(edit.dataset.accountEdit).catch(e => notify(e.message));
    const review = event.target.closest('[data-identity]'); if (review) openIdentity(review.dataset.identity);
  });
  return { renderIdentities };
}
