import { setupLanding } from './landing.js';
const $ = selector => document.querySelector(selector);
export function startAuth({ onAuthenticated, onEnterWorkspace, notify, dirty, clearDirty }) {
  let setup = false, multiOrgEnabled = true, authMode = 'login', authenticated = false, reloading = false, currentUser = null, checking = false;
  const landing = setupLanding({
    onEnterAuth: mode => enterAuth(mode, { pushHistory: true }),
    onEnterWorkspace: () => enterWorkspace({ pushHistory: true }),
  });
  async function request(path, body) {
    const response = await fetch(`/api/v1/auth${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const raw = await response.text();
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); }
      catch { throw Object.assign(new Error(`服务端返回异常响应 (${response.status})，请重试。`), { status: response.status }); }
    }
    if (!response.ok) {
      const error = new Error(data.error?.message || '账号服务暂不可用，请重试。');
      error.status = response.status; error.code = data.error?.code; error.field = data.error?.field;
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
  function applyAuthFormMode(mode) {
    authMode = setup ? 'setup' : mode;
    const form = $('#auth-form');
    form.hidden = false;
    form.dataset.mode = authMode;
    form.querySelector('.sn-form-error').hidden = true;
    const isSetup = authMode === 'setup';
    const isReg = authMode === 'register';
    const isInvite = authMode === 'accept_invite';
    const isResetReq = authMode === 'reset_request';
    const isResetConf = authMode === 'reset_confirm';
    const isLogin = authMode === 'login';

    $('#auth-org-name-field').hidden = !isReg; form.elements.org_name.required = isReg;
    $('#auth-org-field').hidden = isSetup || isInvite || isResetConf;
    form.elements.org_slug.required = isReg;
    $('#auth-token-field').hidden = !(isInvite || isResetConf);
    form.elements.token.required = isInvite || isResetConf;
    $('#auth-display-field').hidden = !(isSetup || isReg);
    form.elements.display_name.required = isSetup || isReg;
    $('#auth-email-field').hidden = !(isSetup || isReg);
    $('#auth-username-field').hidden = isInvite || isResetConf;
    form.elements.username.required = !(isInvite || isResetConf);
    $('#auth-password-field').hidden = isResetReq;
    form.elements.password.required = !isResetReq;
    $('#auth-confirm-field').hidden = !(isSetup || isReg || isInvite || isResetConf);
    form.elements.confirm_password.required = isSetup || isReg || isInvite || isResetConf;
    $('#auth-totp-field').hidden = true;
    $('#auth-username-help').hidden = !(isSetup || isReg);
    form.elements.password.autocomplete = isLogin ? 'current-password' : 'new-password';
    if (isSetup || isReg || isInvite || isResetConf) form.elements.password.minLength = 8;
    else form.elements.password.removeAttribute('minlength');

    const titles = {
      setup: '创建本地负责人账号',
      login: '登录你的工作空间',
      register: '注册新企业工作空间',
      accept_invite: '接受团队成员邀请',
      reset_request: '请求重置密码',
      reset_confirm: '使用重置凭据设置新密码',
    };
    const submitLabels = {
      setup: '创建账号并进入',
      login: '登录',
      register: '注册并进入工作空间',
      accept_invite: '设置密码并加入',
      reset_request: '发送重置凭据',
      reset_confirm: '确认重置密码',
    };
    $('#auth-title').textContent = titles[authMode] || '登录';
    document.title = `${$('#auth-title').textContent} · Botein`;
    form.querySelector('[type=submit]').textContent = submitLabels[authMode] || '提交';
    $('#auth-mode-actions').hidden = setup;
    if ($('#auth-mode-register')) $('#auth-mode-register').hidden = !multiOrgEnabled;
    $('#auth-password-help').textContent = isLogin ? '支持粘贴和密码管理器。' : '至少 8 个字符，最多 256 个 UTF-8 字节。';
  }
  function updateMfaUi() {
    const enabled = Boolean(currentUser?.mfa_enabled);
    if ($('#auth-mfa-status')) $('#auth-mfa-status').textContent = `双因素认证（TOTP）：${enabled ? '已开启' : '未开启（建议绑定 Authenticator）'}`;
    if ($('#mfa-setup-panel')) $('#mfa-setup-panel').hidden = enabled;
    if ($('#mfa-disable-form')) $('#mfa-disable-form').hidden = !enabled;
  }
  function enterAuth(mode = authMode, { pushHistory = false } = {}) {
    if ($('#boot-screen')) $('#boot-screen').hidden = true;
    if ($('#landing-screen')) $('#landing-screen').hidden = true;
    $('#auth-screen').hidden = false;
    $('#auth-description').textContent = setup ? '首次设置只创建本地登录账号，现有工厂和业务资料会继续保留。' : '登录后继续整理线索、审核草稿和跟进客户。';
    const allowed = ['login', 'register', 'accept_invite', 'reset_request', 'reset_confirm', 'setup'];
    let targetMode = allowed.includes(mode) ? mode : 'login';
    if (setup) targetMode = 'setup';
    else if (targetMode === 'register' && !multiOrgEnabled) targetMode = 'login';
    applyAuthFormMode(targetMode);
    if (pushHistory && location.pathname !== '/app') history.pushState({ view: 'auth', mode: targetMode }, '', '/app');
    $('#auth-screen').focus();
  }
  function enterLanding({ pushHistory = false } = {}) {
    if ($('#boot-screen')) $('#boot-screen').hidden = true;
    $('#auth-screen').hidden = true;
    $('#workspace-shell').hidden = true;
    if ($('#landing-screen')) $('#landing-screen').hidden = false;
    document.title = 'Botein · 海外品牌智能开发工作台';
    if (pushHistory) {
      if (authenticated) {
        if (location.pathname !== '/welcome') history.pushState({ view: 'landing' }, '', '/welcome');
      } else if (location.pathname === '/app') {
        history.pushState({ view: 'landing' }, '', '/');
      }
    }
    $('#landing-screen')?.focus();
  }
  function enterWorkspace({ pushHistory = false } = {}) {
    if ($('#boot-screen')) $('#boot-screen').hidden = true;
    if ($('#landing-screen')) $('#landing-screen').hidden = true;
    $('#auth-screen').hidden = true;
    $('#workspace-shell').hidden = false;
    if (location.pathname === '/app') history.replaceState({}, '', `/${location.hash}`);
    else if (pushHistory && location.pathname === '/welcome') history.pushState({ view: 'workspace' }, '', `/${location.hash}`);
    onEnterWorkspace?.();
    const title = document.querySelector('[data-view]:not([hidden]) h1')?.textContent || '工作空间';
    document.title = `${title} · Botein`;
    $('#main').focus();
  }
  async function status() {
    $('#auth-retry').hidden = true;
    try {
      const info = await request('/status');
      setup = info.setup_required;
      multiOrgEnabled = info.multi_org_enabled !== false;
      landing.syncLandingState({ setupRequired: setup, multiOrgEnabled, authenticated: Boolean(info.authenticated) });
      if ($('#boot-screen')) $('#boot-screen').hidden = true;
      if (info.authenticated) {
        currentUser = info.user;
        const roleLabel = info.user.role === 'OWNER' ? '负责人 (OWNER)' : '团队成员 (MEMBER)';
        document.body.dataset.role = info.user.role || 'OWNER';
        document.querySelectorAll('[data-owner-only]').forEach(el => { el.hidden = info.user.role !== 'OWNER'; });
        // Never show a cached business view until authentication and data loading have both succeeded.
        await onAuthenticated();
        authenticated = true;
        if ($('#workspace-name')) $('#workspace-name').textContent = info.organization?.name || 'LANCCO';
        $('#signed-in-owner').textContent = ` / ${info.user.display_name} (${info.user.role || 'OWNER'})`;
        $('#auth-session-info').textContent = `账号 ${info.user.username} · ${roleLabel} · 工作区 ${info.organization?.name || '本地'} · 本次登录到期 ${new Date(info.expires_at).toLocaleString('zh-CN')}。`;
        updateMfaUi();
        if (location.pathname === '/welcome') enterLanding({ pushHistory: false });
        else enterWorkspace({ pushHistory: false });
        return;
      }
      const queryMode = new URLSearchParams(location.search).get('auth');
      const hasNotice = Boolean($('#auth-feedback').textContent.trim());
      if (location.pathname === '/app' || hasNotice || queryMode) {
        enterAuth(queryMode || authMode, { pushHistory: false });
      } else {
        enterLanding({ pushHistory: false });
      }
    } catch (error) {
      if ($('#boot-screen')) $('#boot-screen').hidden = true;
      if ($('#landing-screen')) $('#landing-screen').hidden = true;
      $('#auth-screen').hidden = false;
      $('#auth-feedback').textContent = `读取失败：${error.message}`;
      $('#auth-retry').hidden = false;
    }
  }
  $('#auth-feedback').textContent = sessionStorage.getItem('botein-auth-message') || '';
  sessionStorage.removeItem('botein-auth-message');
  $('#auth-retry').addEventListener('click', status);
  $('#back-to-landing')?.addEventListener('click', () => enterLanding({ pushHistory: true }));
  $('#auth-brand-link')?.addEventListener('click', event => {
    event.preventDefault();
    enterLanding({ pushHistory: true });
  });
  $('#workspace-landing-link')?.addEventListener('click', event => {
    if (!authenticated) return;
    event.preventDefault();
    enterLanding({ pushHistory: true });
  });
  window.addEventListener('popstate', () => {
    if (authenticated) {
      if (location.pathname === '/welcome') enterLanding({ pushHistory: false });
      else enterWorkspace({ pushHistory: false });
      return;
    }
    if (location.pathname === '/app') enterAuth(authMode, { pushHistory: false });
    else enterLanding({ pushHistory: false });
  });
  $('#auth-mode-actions')?.addEventListener('click', event => {
    const btn = event.target.closest('[data-auth-mode]');
    if (btn) applyAuthFormMode(btn.dataset.authMode);
  });
  $('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('[type=submit]');
    form.querySelector('.sn-form-error').hidden = true;
    const needsConfirm = ['setup', 'register', 'accept_invite', 'reset_confirm'].includes(authMode);
    if (needsConfirm && form.elements.password.value !== form.elements.confirm_password.value) {
      return showError(form, { message: '两次输入的密码不一致。', field: 'confirm_password' });
    }
    const label = button.textContent; button.disabled = true; button.textContent = '提交中…';
    try {
      if (authMode === 'reset_request') {
        const res = await request('/password-reset/request', {
          username: form.elements.username.value,
          org_slug: form.elements.org_slug.value.trim() || undefined,
        });
        $('#auth-feedback').textContent = res.message || '如果账号存在，重置指令已发送。';
        applyAuthFormMode('reset_confirm');
        return;
      }
      if (authMode === 'reset_confirm') {
        await request('/password-reset/confirm', {
          token: form.elements.token.value.trim(),
          new_password: form.elements.password.value,
        });
        $('#auth-feedback').textContent = '密码已重置，请使用新密码登录。';
        form.reset();
        applyAuthFormMode('login');
        return;
      }
      if (authMode === 'accept_invite') {
        await request('/invitations/accept', {
          token: form.elements.token.value.trim(),
          display_name: form.elements.display_name.value.trim() || undefined,
          password: form.elements.password.value,
        });
        form.reset(); await status();
        return;
      }
      if (authMode === 'register') {
        await request('/organizations/register', {
          org_name: form.elements.org_name.value,
          org_slug: form.elements.org_slug.value,
          username: form.elements.username.value,
          display_name: form.elements.display_name.value,
          email: form.elements.email.value.trim() || undefined,
          password: form.elements.password.value,
        });
        form.reset(); await status();
        return;
      }
      if (authMode === 'setup') {
        await request('/setup', {
          username: form.elements.username.value,
          display_name: form.elements.display_name.value,
          email: form.elements.email.value.trim() || undefined,
          password: form.elements.password.value,
        });
        form.reset(); await status();
        return;
      }
      await request('/login', {
        username: form.elements.username.value,
        org_slug: form.elements.org_slug.value.trim() || undefined,
        password: form.elements.password.value,
        totp_code: form.elements.totp_code.value.trim() || undefined,
      });
      form.reset(); await status();
    } catch (error) {
      if (error.code === 'MFA_REQUIRED') {
        $('#auth-totp-field').hidden = false;
        showError(form, error);
        form.elements.totp_code.focus();
      } else {
        form.elements.password.value = ''; form.elements.confirm_password.value = '';
        showError(form, error);
        if (error.status === 409) await status();
      }
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
      const roleLabel = currentUser?.role === 'OWNER' ? '负责人 (OWNER)' : '团队成员 (MEMBER)';
      $('#auth-session-info').textContent = `账号 ${currentUser.username} · ${roleLabel} · 本次登录到期 ${new Date(result.expires_at).toLocaleString('zh-CN')}。`;
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
  $('#open-mfa-setup')?.addEventListener('click', () => {
    $('#mfa-secret-box').hidden = true;
    $('#mfa-enable-form')?.reset();
    $('#mfa-disable-form')?.reset();
    $('#mfa-enable-form .sn-form-error').hidden = true;
    $('#mfa-disable-form .sn-form-error').hidden = true;
    updateMfaUi();
    $('#mfa-dialog').showModal();
  });
  $('#mfa-generate-btn')?.addEventListener('click', async () => {
    try {
      const res = await request('/mfa/setup', {});
      $('#mfa-secret-box').hidden = false;
      const box = $('#mfa-secret-box');
      box.replaceChildren();
      const p1 = document.createElement('p');
      p1.append('密钥 (Base32)：');
      const c1 = document.createElement('code');
      c1.textContent = res.secret;
      p1.append(c1);
      const p2 = document.createElement('p');
      p2.className = 'sn-helper';
      p2.append('URI：');
      const c2 = document.createElement('code');
      c2.textContent = res.otpauth_uri;
      p2.append(c2);
      box.append(p1, p2);
    } catch (error) { notify(error.message); }
  });
  $('#mfa-enable-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    form.querySelector('.sn-form-error').hidden = true;
    try {
      await request('/mfa/enable', { totp_code: form.elements.totp_code.value.trim() });
      currentUser.mfa_enabled = true;
      updateMfaUi();
      $('#mfa-dialog').close();
      notify('双因素认证已开启，下次登录需验证 6 位动态码。');
    } catch (error) { showError(form, error); }
  });
  $('#mfa-disable-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    form.querySelector('.sn-form-error').hidden = true;
    try {
      await request('/mfa/disable', {
        current_password: form.elements.current_password.value,
        totp_code: form.elements.totp_code.value.trim(),
      });
      currentUser.mfa_enabled = false;
      updateMfaUi();
      $('#mfa-dialog').close();
      notify('双因素认证已关闭。');
    } catch (error) { showError(form, error); }
  });
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
