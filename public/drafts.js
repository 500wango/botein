const $ = selector => document.querySelector(selector);
const labels = { DRAFT: '草稿', IN_REVIEW: '待审核', APPROVED: '已批准', REJECTED: '已拒绝', BLOCKED: '已阻断', SUPERSEDED: '已被新版本替代' };
export function setupDrafts({ api, state, refresh, notify, escape, formHandler, date }) {
  const displayValue = value => Array.isArray(value) ? value.join(' / ') : String(value ?? '未知');
  const current = id => state.detail?.drafts.find(d => d.id === id);
  const clearError = form => { form.querySelector('.sn-form-error').hidden = true; form.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid')); };
  function referenceText(c) {
    return c.kind === 'EVIDENCE' ? `证据 ${c.evidence_id.slice(0, 8)} / 版本 ${c.evidence_version}${c.time_sensitive ? ' / 时效性陈述' : ''}` : `工厂版本 ${c.profile_version} / ${state.capabilities.fields[c.field]}：${displayValue(c.value)}`;
  }
  function claimMarkup(claims) {
    return claims.length ? `<ol class="sn-draft-claims">${claims.map(c => `<li><p><strong>${escape(c.text)}</strong></p><p class="sn-helper">${escape(referenceText(c))}${c.validation_status ? ` · ${c.validation_status === 'SUPPORTED' ? '已人工确认支持' : c.validation_status === 'UNSUPPORTED' ? '引用未通过当前校验' : '待人工确认语义支持'}` : ''}</p>${c.kind === 'EVIDENCE' ? `<blockquote class="sn-quote">${escape(c.quote)}</blockquote>` : ''}</li>`).join('')}</ol>` : '<p class="sn-helper">未标记事实陈述；审核人仍需逐字核对全文，确认确实没有事实性承诺或遗漏。</p>';
  }
  function render(d) {
    return `<section class="sn-detail-section"><div class="sn-section-heading"><h3>英文开发信</h3><button class="sn-button sn-secondary" data-draft-new ${!d.contacts.some(c => !c.suppression_reason) || ['REJECTED','ARCHIVED'].includes(d.qualification_status) || ['WON','LOST'].includes(d.sales_stage) ? 'disabled' : ''}>撰写人工草稿</button></div><p class="sn-helper">模型尚未接入。可录入自己的英文草稿并人工审核；批准后的复制仍不等于发送。</p>${d.drafts.map(v => `<article class="sn-draft-entry"><div class="sn-section-heading"><h3>${escape(v.subject)}</h3><span class="sn-state">${labels[v.status]} · v${v.number}</span></div><p class="sn-helper">联系人：${escape(v.contact_snapshot?.full_name || d.contacts.find(c => c.id === v.contact_id)?.full_name || '已失效')} · 人工撰写${v.contact_snapshot?.provenance === 'MIGRATED_CURRENT_RECORD' ? ' · 联系人快照来自升级时资料，非历史身份验证' : ' · 联系人为草稿录入时快照'}</p><p class="sn-draft-body">${escape(v.body)}</p>${v.warnings.length ? `<ul class="sn-draft-warnings">${v.warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul>` : ''}${claimMarkup(v.claims)}<div class="sn-actions"><button class="sn-button sn-secondary" data-draft-edit="${escape(v.id)}">编辑新版本</button><button class="sn-button sn-secondary" data-draft-review="${escape(v.id)}" ${v.status === 'APPROVED' ? 'disabled' : ''}>审核此版本</button><button class="sn-button sn-secondary" data-draft-copy="${escape(v.id)}" data-part="subject" ${v.status !== 'APPROVED' ? 'disabled' : ''}>复制已审核主题</button><button class="sn-button sn-secondary" data-draft-copy="${escape(v.id)}" data-part="body" ${v.status !== 'APPROVED' ? 'disabled' : ''}>复制已审核正文</button></div><details class="sn-history-details"><summary>版本与审核历史</summary>${v.versions.map(old => `<details><summary>版本 ${old.number} · ${labels[old.status]} · ${date(old.created_at)}</summary><p>${escape(old.subject)}</p><p class="sn-helper">${escape(old.contact_snapshot?.full_name || '未记录姓名')} / ${escape(old.contact_snapshot?.email || '未记录邮箱')} · ${old.contact_snapshot?.provenance === 'MIGRATED_CURRENT_RECORD' ? '升级时资料快照' : '草稿录入时快照'}</p><p class="sn-draft-body">${escape(old.body)}</p>${claimMarkup(old.claims)}</details>`).join('')}<ul>${v.reviews.map(r => `<li>${date(r.created_at)} · ${escape({ APPROVE: '人工批准', REJECT: '人工拒绝', APPROVAL_INVALIDATED: '批准失效', SUPERSEDED: '旧版本保留' }[r.action] || r.action)}<p>${escape(r.reason)}</p></li>`).join('')}</ul></details></article>`).join('') || '<p class="sn-muted">还没有草稿。先录入带来源的联系人，再撰写并关联事实依据。</p>'}</section>`;
  }
  function renderCapabilities() {
    $('#check-capability').disabled = state.workspace.factory.status !== 'ACTIVE' || state.factoryDirty;
    const items = state.capabilities.items || [];
    $('#capability-summary').innerHTML = `<p class="sn-helper">${items.length} / ${state.capabilityTotal ?? items.length} 条已核验字段记录（当前档案版本）</p>` +
      (items.length ? `<ul class="sn-history">${items.map(c => `<li>${escape(state.capabilities.fields[c.field])}：${escape(displayValue(c.value))} · 版本 ${c.profile_version}</li>`).join('')}</ul>` : '<p class="sn-helper">当前档案版本尚无字段核验。</p>') +
      (state.capabilityCursor ? '<div class="sn-actions"><button class="sn-button sn-secondary" type="button" data-checks-more>加载更多字段核验</button></div>' : '');
  }
  function updateCapabilityValue() {
    const field = $('#capability-form').elements.field.value;
    $('#capability-value').textContent = `版本 ${state.workspace.factory.version} · ${displayValue(state.workspace.factory[field])}`;
  }
  $('#check-capability').addEventListener('click', () => {
    const form = $('#capability-form'); form.reset(); clearError(form); form.dataset.version = state.workspace.factory.version;
    form.elements.field.innerHTML = Object.entries(state.capabilities.fields).map(([key, label]) => `<option value="${key}">${escape(label)}</option>`).join('');
    updateCapabilityValue(); $('#capability-dialog').showModal();
  });
  $('#capability-form').elements.field.addEventListener('change', updateCapabilityValue);
  formHandler('#capability-form', async form => {
    await api('/factory-profile/checks', 'POST', { field: form.elements.field.value, reason: form.elements.reason.value, confirmed: form.elements.confirmed.checked, expected_version: Number(form.dataset.version) });
    await refresh(); $('#capability-dialog').close(); notify('该版本的能力字段已由本地负责人核验。修改工厂档案后需要重新核对。');
  });
  function sourceOptions() {
    return '<option value="">请选择支持依据</option>' + state.detail.evidence.map(e => `<option value="e:${escape(e.id)}">证据 ${escape(e.id.slice(0,8))} · ${e.verification_status === 'VERIFIED' ? '已核验' : '未核验/失效'} · ${escape(e.raw_text.slice(0,55))}</option>`).join('') + state.checkOptions.map(c => `<option value="f:${escape(c.id)}">工厂字段 ${escape(state.capabilities.fields[c.field])} · ${escape(displayValue(c.value))}</option>`).join('');
  }
  function addClaim(claim) {
    if ($('#draft-claim-rows').children.length >= 30) { notify('最多填写 30 条事实陈述。'); return; }
    const row = document.createElement('fieldset'); row.className = 'sn-claim-row';
    row.innerHTML = `<legend>事实陈述</legend><label class="sn-field">主题或正文中的事实原句<textarea data-claim-text rows="2" maxlength="2000" required></textarea></label><label class="sn-field">支持依据<select data-claim-source required>${sourceOptions()}</select></label><label class="sn-field" data-quote-label>证据中的原文片段<textarea data-claim-quote rows="2" maxlength="5000"></textarea><span class="sn-helper">须与保存的原文一致；请从下方来源摘录。</span></label><div data-source-preview class="sn-helper sn-source-preview"></div><label class="sn-check" data-time-label><input data-claim-time type="checkbox">这是“当前在售”等时效性陈述，引用需在 7 天内核验。</label><button class="sn-button sn-secondary" type="button" data-claim-remove>移除此条陈述</button>`;
    row.querySelector('[data-claim-text]').value = claim?.text || '';
    row.querySelector('[data-claim-quote]').value = claim?.quote || '';
    row.querySelector('[data-claim-time]').checked = claim?.time_sensitive || false;
    row.querySelector('[data-claim-source]').value = claim ? claim.kind === 'EVIDENCE' ? `e:${claim.evidence_id}` : `f:${claim.check_id}` : '';
    row.querySelector('[data-claim-source]').addEventListener('change', () => updateClaim(row));
    row.querySelector('[data-claim-remove]').addEventListener('click', () => row.remove());
    $('#draft-claim-rows').append(row); updateClaim(row);
  }
  function updateClaim(row) {
    const [kind, id] = row.querySelector('[data-claim-source]').value.split(':');
    const isEvidence = kind === 'e';
    row.querySelector('[data-quote-label]').hidden = !isEvidence;
    row.querySelector('[data-claim-quote]').required = isEvidence;
    row.querySelector('[data-time-label]').hidden = !isEvidence;
    const source = isEvidence ? state.detail.evidence.find(e => e.id === id)?.raw_text : state.checkOptions.find(c => c.id === id)?.reason;
    row.querySelector('[data-source-preview]').textContent = source || '请先选择依据。旧工厂字段核验不在当前版本中时，需重新核验后选择。';
  }
  $('#add-draft-claim').addEventListener('click', () => addClaim());
  function openEditor(id) {
    if (!state.detail) return;
    const draft = id ? current(id) : null, form = $('#draft-editor-form');
    form.reset(); clearError(form); form.dataset.id = draft?.id || ''; form.dataset.version = draft?.version || ''; form.dataset.opportunity = state.detail.id;
    form.elements.contact_id.innerHTML = '<option value="">请选择联系人</option>' + state.detail.contacts.filter(c => !c.suppression_reason).map(c => `<option value="${escape(c.id)}">${escape(c.full_name)} · ${escape(c.email)}</option>`).join('');
    form.elements.contact_id.value = draft?.contact_id || '';
    form.elements.subject.value = draft?.subject || ''; form.elements.body.value = draft?.body || '';
    $('#draft-claim-rows').replaceChildren();
    for (const claim of draft?.claims || []) addClaim(claim);
    $('#draft-editor-dialog').showModal();
  }
  formHandler('#draft-editor-form', async form => {
    const claims = [...$('#draft-claim-rows').children].map(row => {
      const [kind, id] = row.querySelector('[data-claim-source]').value.split(':');
      return { text: row.querySelector('[data-claim-text]').value, kind: kind === 'e' ? 'EVIDENCE' : 'FACTORY', evidence_id: kind === 'e' ? id : undefined, check_id: kind === 'f' ? id : undefined, quote: row.querySelector('[data-claim-quote]').value, time_sensitive: row.querySelector('[data-claim-time]').checked };
    });
    const data = { ...Object.fromEntries(new FormData(form)), claims, expected_version: Number(form.dataset.version) };
    await api(form.dataset.id ? `/drafts/${form.dataset.id}` : `/opportunities/${form.dataset.opportunity}/drafts`, form.dataset.id ? 'PATCH' : 'POST', data);
    await refresh(); $('#draft-editor-dialog').close(); notify('人工草稿已保存为新版本，旧批准不会继承。');
  });
  function approvalChecks() {
    const approve = $('#draft-review-form').elements.action.value === 'APPROVE';
    $('#draft-approval-checks').hidden = !approve;
    $('#draft-approval-checks').querySelectorAll('input').forEach(e => { e.required = approve; });
  }
  $('#draft-review-form').elements.action.addEventListener('change', approvalChecks);
  function openReview(id) {
    const draft = current(id); if (!draft) return;
    const form = $('#draft-review-form'); form.reset(); clearError(form);
    form.dataset.id = id; form.dataset.version = draft.version; form.dataset.versionId = draft.current_version_id;
    $('#draft-review-preview').innerHTML = `<h3>${escape(draft.subject)}</h3><p class="sn-draft-body">${escape(draft.body)}</p>${claimMarkup(draft.claims)}<ul class="sn-draft-warnings">${draft.warnings.map(w => `<li>${escape(w)}</li>`).join('')}</ul><p class="sn-helper">系统没有模型语义审核能力。请打开商机来源核对全文，包括未标注的陈述和时效性，不要仅凭引用存在批准。</p>`;
    approvalChecks(); $('#draft-review-dialog').showModal();
  }
  formHandler('#draft-review-form', async form => {
    await api(`/drafts/${form.dataset.id}/review`, 'POST', { expected_version: Number(form.dataset.version), draft_version_id: form.dataset.versionId, action: form.elements.action.value, reason: form.elements.reason.value, full_text_confirmed: form.elements.full_text_confirmed.checked, claims_confirmed: form.elements.claims_confirmed.checked });
    await refresh(); $('#draft-review-dialog').close(); notify('已保存此版本的人工审核记录。复制仍需再次校验当前依赖。');
  });
  async function copyDraft(button) {
    const draft = current(button.dataset.draftCopy); if (!draft) return;
    button.disabled = true;
    try {
      const result = await api(`/drafts/${draft.id}/copy-events`, 'POST', { expected_version: draft.version, draft_version_id: draft.current_version_id, part: button.dataset.part });
      await navigator.clipboard.writeText(result.content);
      notify(`已复制审核通过的${result.part === 'subject' ? '主题' : '正文'}（版本 ${draft.number}）。尚未记录发送。`);
    } catch (error) { notify(`复制未完成：${error.message}。请刷新核对状态；不会记录为已发送。`); }
    finally { await refresh().catch(error => notify(error.message)); }
  }
  document.addEventListener('click', event => {
    if (event.target.closest('[data-draft-new]')) openEditor();
    const edit = event.target.closest('[data-draft-edit]'); if (edit) openEditor(edit.dataset.draftEdit);
    const review = event.target.closest('[data-draft-review]'); if (review) openReview(review.dataset.draftReview);
    const copy = event.target.closest('[data-draft-copy]'); if (copy) copyDraft(copy).catch(error => notify(error.message));
  });
  return { render, renderCapabilities };
}
