const $ = selector => document.querySelector(selector);
function download(blob, filename) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function setupTransfer({ api, state, refresh, notify, escape, formHandler }) {
  function prepareImport() {
    $('#evidence-import-results').replaceChildren();
    $('#import-account-reference').innerHTML = state.accountOptions.length ? `<ul class="sn-history">${state.accountOptions.map(a => `<li>${escape(a.brand_name)}<br><code>${escape(a.id)}</code></li>`).join('')}</ul>` : '<p class="sn-helper">尚无品牌，请先在品牌池录入。即使导入文件提供未知 ID，也不会自动创建品牌。</p>';
  }
  $('#evidence-template').addEventListener('click', () => download(new Blob(['\uFEFFaccount_id,product_id,source_url,raw_text,published_at,observed_at\r\n'], { type: 'text/csv;charset=utf-8' }), 'botein-evidence-template.csv'));
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-export]'); if (!button) return;
    const label = button.textContent; button.disabled = true; button.textContent = '正在导出…';
    const feedback = $('#export-feedback'); feedback.textContent = '';
    try {
      const result = await fetch(`/api/v1/exports/${encodeURIComponent(button.dataset.export)}`);
      if (result.status === 401) window.dispatchEvent(new Event('sn-auth-expired'));
      if (!result.ok) throw new Error((await result.json()).error?.message || '导出失败，请重试。');
      const filename = result.headers.get('content-disposition')?.match(/filename="([a-z0-9.-]+)"/i)?.[1] || 'botein-export.csv';
      download(await result.blob(), filename);
      feedback.textContent = `已准备下载 ${filename}，范围为当前工作空间全部记录。`;
      notify(feedback.textContent);
    } catch (error) { feedback.textContent = error.message; notify(error.message); }
    finally { button.disabled = false; button.textContent = label; }
  });
  formHandler('#evidence-import-form', async form => {
    const file = form.elements.file.files[0];
    if (!file || file.size > 500000) throw new Error('请选择不超过 500 KB 的 CSV 文件。');
    let csv;
    try { csv = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new Error('文件不是有效 UTF-8，请另存为 CSV UTF-8 后导入。'); }
    const result = await api('/evidence/imports', 'POST', { csv });
    const labels = { CREATED: '新增', SKIPPED: '跳过', FAILED: '失败' };
    $('#evidence-import-results').innerHTML = `<p>新增 ${result.counts.CREATED} · 跳过 ${result.counts.SKIPPED} · 失败 ${result.counts.FAILED}</p><ul>${result.results.map(row => `<li>第 ${row.row} 条记录：${labels[row.status]}，${escape(row.reason)}${row.id ? `<br>证据 ID：${escape(row.id)}` : ''}</li>`).join('')}</ul><p class="sn-helper">失败记录未写入。修改后可重新提交，相同证据会跳过；未自动核验任何来源。</p>`;
    $('#evidence-import-results').scrollIntoView({ block: 'nearest' });
    // Keep the import result visible even if a subsequent page refresh fails.
    try { await refresh(); } catch (error) { notify(`导入结果已保存，但列表刷新失败：${error.message}`); }
  });
  return { prepareImport };
}
