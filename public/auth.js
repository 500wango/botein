const $ = selector => document.querySelector(selector);
export function startAuth({ onAuthenticated, notify, dirty, clearDirty }) {
  let setup = false, authenticated = false, reloading = false, currentUser = null, checking = false;
  async function request(path, body) {
    const response = await fetch(`/api/v1/auth${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error?.message || '账号服务暂不可用，请重试。');
      error.status = response.status; error.field = data.error?.field;
      throw error;
    }
    return data;
  }
  function forget(message) {
    if (reloading) return;
    reloading = true; authenticated = false; clearDirty();
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    $('#workspace-shell').hidden = true;
    sessionStorage.setItem('botein-auth-message', message);
    location.reload(); // Discard in-memory business data and detached forms, not just hide them.
  }
  function showError(form, error) {
    const node = form.querySelector('.sn-form-error'); node.textContent = error.message; node.hidden = false;
    const field = error.field && form.elements.namedItem(error.field);
    if (field instanceof HTMLElement) field.focus();
    else { node.tabIndex = -1; node.focus(); }
  }
  async function status() {
    $('#auth-retry').hidden = true;
    try {
      const info = await request('/status');
      setup = info.setup_required;
      if (info.authenticated) {
        currentUser = info.user;
        // Never show a cached business view until authentication and data loading have both succeeded.
        await onAuthenticated();
        authenticated = true;
        $('#signed-in-owner').textContent = ` / ${info.user.display_name}`;
        $('#auth-session-info').textContent = `账号 ${info.user.username} · 本地负责人 · 本次登录到期 ${new Date(info.expires_at).toLocaleString('zh-CN')}。`;
        $('#auth-screen').hidden = true; $('#workspace-shell').hidden = false;
        const title = document.querySelector('[data-view]:not([hidden]) h1')?.textContent || '工作空间';
        document.title = `${title} · Botein`;
        $('#main').focus();
        return;
      }
      $('#auth-title').textContent = setup ? '创建本地负责人账号' : '登录你的工作空间';
      document.title = `${$('#auth-title').textContent} · Botein`;
      $('#auth-description').textContent = setup ? '首次设置只创建本地登录账号，现有工厂和业务资料会继续保留。' : '登录后继续整理线索、审核草稿和跟进客户。';
      const form = $('#auth-form'); form.hidden = false;
      form.dataset.mode = setup ? 'setup' : 'login';
      $('#auth-display-field').hidden = !setup; form.elements.display_name.required = setup;
      $('#auth-confirm-field').hidden = !setup; form.elements.confirm_password.required = setup;
      $('#auth-username-help').hidden = !setup;
      form.elements.password.autocomplete = setup ? 'new-password' : 'current-password';
      if (setup) form.elements.password.minLength = 8;
      else form.elements.password.removeAttribute('minlength');
      form.querySelector('[type=submit]').textContent = setup ? '创建账号并进入' : '登录';
      $('#auth-password-help').textContent = setup ? '至少 8 个字符，最多 256 个 UTF-8 字节。请保存到密码管理器。' : '支持粘贴和密码管理器。';
    } catch (error) {
      $('#auth-feedback').textContent = `读取失败：${error.message}`;
      $('#auth-retry').hidden = false;
    }
  }
  $('#auth-feedback').textContent = sessionStorage.getItem('botein-auth-message') || '';
  sessionStorage.removeItem('botein-auth-message');
  $('#auth-retry').addEventListener('click', status);
  $('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('[type=submit]');
    form.querySelector('.sn-form-error').hidden = true;
    if (setup && form.elements.password.value !== form.elements.confirm_password.value) return showError(form, { message:'两次输入的密码不一致。', field:'confirm_password' });
    const label = button.textContent; button.disabled = true; button.textContent = setup ? '正在创建…' : '正在登录…';
    try {
      await request(setup ? '/setup' : '/login', { username: form.elements.username.value, display_name: form.elements.display_name.value, password: form.elements.password.value });
      form.reset(); await status();
    } catch (error) {
      form.elements.password.value = ''; form.elements.confirm_password.value = '';
      showError(form, error);
      if (error.status === 409) await status();
    } finally { button.disabled = false; button.textContent = label; }
  });
  $('#logout-button').addEventListener('click', async event => {
    const hasInput = dirty() || document.querySelector('dialog[open]');
    if (hasInput && !window.confirm('退出将丢弃尚未保存的输入，已保存资料保留。继续退出吗？')) return;
    const button = event.currentTarget; button.disabled = true;
    try { await request('/logout', {}); forget('已退出登录。'); }
    catch (error) { notify(`退出失败：${error.message}`); }
    finally { button.disabled = false; }
  });
  $('#open-password-change').addEventListener('click', () => {
    const form = $('#password-form'); form.reset(); form.elements.username.value = currentUser?.username || '';
    form.querySelector('.sn-form-error').hidden = true; $('#password-dialog').showModal();
  });
  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type=submit]');
    form.querySelector('.sn-form-error').hidden = true;
    if (form.elements.new_password.value !== form.elements.confirm_password.value) return showError(form, { message:'两次新密码输入不一致。', field:'confirm_password' });
    button.disabled = true;
    try {
      const result = await request('/password', { current_password: form.elements.current_password.value, new_password: form.elements.new_password.value });
      form.reset(); $('#password-dialog').close();
      $('#auth-session-info').textContent = `账号 ${currentUser.username} · 本地负责人 · 本次登录到期 ${new Date(result.expires_at).toLocaleString('zh-CN')}。`;
      notify('密码已更新，其他登录会话已退出；本窗口保留登录。');
    } catch (error) {
      form.elements.current_password.value = ''; form.elements.new_password.value = ''; form.elements.confirm_password.value = '';
      if (error.status === 401) {
        try { if (!(await request('/status')).authenticated) { forget('会话已过期，请重新登录。'); return; } }
        catch { /* Preserve the original failure message if the connection also went away. */ }
      }
      showError(form, error);
    } finally { button.disabled = false; }
  });
  let sessions = [], sessionsBusy = false, sessionsRequest = 0;
  function sessionMessage(error) {
    if (error.status === 401) forget('登录已过期或被撤销，请重新登录。');
    else $('#sessions-feedback').textContent = error.message;
  }
  function renderSessions() {
    const list = $('#sessions-list'); list.replaceChildren();
    for (const item of sessions) {
      const row = document.createElement('article'); row.className = 'sn-session-row';
      const heading = document.createElement('h3');
      heading.textContent = item.current ? '当前登录' : '其他登录';
      const times = document.createElement('p'); times.className = 'sn-helper';
      times.textContent = `创建：${new Date(item.created_at).toLocaleString('zh-CN')}；到期：${new Date(item.expires_at).toLocaleString('zh-CN')}`;
      const identifier = document.createElement('p'); identifier.className = 'sn-helper';
      identifier.textContent = `会话标识：${item.id}`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'sn-button sn-secondary';
      button.textContent = item.current ? '退出当前登录' : '撤销此登录'; button.disabled = sessionsBusy;
      button.addEventListener('click', () => revokeSession(item));
      row.append(heading, times, identifier, button); list.append(row);
    }
    $('#revoke-other-sessions').disabled = sessionsBusy || !sessions.some(s => !s.current);
    $('#refresh-sessions').disabled = sessionsBusy;
  }
  async function loadSessions() {
    const requestId = ++sessionsRequest;
    $('#sessions-feedback').textContent = '正在读取有效登录…';
    try {
      const data = await request('/sessions');
      if (requestId !== sessionsRequest) return;
      sessions = data.items; renderSessions();
      $('#sessions-feedback').textContent = `${sessions.length} 个有效登录，读取于 ${new Date(data.generated_at).toLocaleString('zh-CN')}。`;
    } catch (error) {
      if (requestId !== sessionsRequest) return;
      sessions = []; renderSessions(); sessionMessage(error);
    }
  }
  async function revokeSession(item) {
    if (sessionsBusy) return;
    const prompt = item?.current ? '退出当前登录将清除未保存输入；已保存资料保留。继续吗？' : item ? '撤销这次登录？该会话下次请求会返回登录页。' : '退出其他所有会话？本窗口保留登录，其他窗口未保存的输入可能丢失。';
    if (!window.confirm(prompt)) return;
    sessionsBusy = true; ++sessionsRequest; renderSessions();
    try {
      const path = item ? `/sessions/${encodeURIComponent(item.id)}/revoke` : '/sessions/revoke-others';
      const result = await request(path, { confirmed: true });
      if (!result.authenticated) { forget('当前登录已退出。'); return; }
      await loadSessions();
      notify(item ? '指定登录已撤销，本窗口保留登录。' : `已退出 ${result.revoked_count} 个其他有效会话。`);
    } catch (error) {
      if (error.status === 404) { await loadSessions(); $('#sessions-feedback').textContent = '目标登录已失效，列表已刷新。'; }
      else sessionMessage(error);
    } finally { sessionsBusy = false; renderSessions(); }
  }
  $('#open-session-manager').addEventListener('click', () => {
    sessions = []; renderSessions(); $('#sessions-dialog').showModal(); loadSessions();
  });
  $('#refresh-sessions').addEventListener('click', loadSessions);
  $('#revoke-other-sessions').addEventListener('click', () => revokeSession());
  window.addEventListener('sn-auth-expired', () => forget('登录已过期或被撤销，请重新登录。未保存输入已清除。'));
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  async function recheck() {
    if (!authenticated || checking || document.visibilityState !== 'visible') return;
    checking = true;
    try { if (!(await request('/status')).authenticated) forget('当前会话已失效，请重新登录。'); }
    catch { /* Network failure is not evidence of logout; API calls remain gated. */ }
    finally { checking = false; }
  }
  window.addEventListener('focus', recheck); document.addEventListener('visibilitychange', recheck);
  status();
}
