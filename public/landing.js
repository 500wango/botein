export function setupLanding({ onEnterAuth, onEnterWorkspace }) {
  const screen = document.querySelector('#landing-screen');
  if (!screen) return { syncLandingState() {} };

  const tabs = [...screen.querySelectorAll('[data-specimen-tab]')];
  const panels = [...screen.querySelectorAll('[data-specimen-panel]')];
  const drawer = document.querySelector('#landing-mobile-drawer');
  const burger = document.querySelector('#landing-menu-toggle');

  function activateTab(key) {
    for (const tab of tabs) {
      const selected = tab.dataset.specimenTab === key;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) {
      const active = panel.dataset.specimenPanel === key;
      panel.hidden = !active;
      if (active) {
        panel.classList.remove('is-panel-in');
        void panel.offsetWidth;
        panel.classList.add('is-panel-in');
      }
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.specimenTab));
    tab.addEventListener('keydown', event => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activateTab(tabs[next].dataset.specimenTab);
      tabs[next].focus();
    });
  });

  function setDrawerOpen(open) {
    if (!drawer || !burger) return;
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      drawer.hidden = false;
      drawer.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => drawer.classList.add('is-open'));
    } else {
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      setTimeout(() => {
        if (!drawer.classList.contains('is-open')) drawer.hidden = true;
      }, 420);
    }
  }

  burger?.addEventListener('click', () => {
    const expanded = burger.getAttribute('aria-expanded') === 'true';
    setDrawerOpen(!expanded);
  });

  screen.addEventListener('click', event => {
    const workspaceTrigger = event.target.closest('[data-enter-workspace]');
    if (workspaceTrigger) {
      event.preventDefault();
      setDrawerOpen(false);
      onEnterWorkspace?.();
      return;
    }
    const authTrigger = event.target.closest('[data-enter-auth]');
    if (authTrigger) {
      event.preventDefault();
      setDrawerOpen(false);
      onEnterAuth(authTrigger.dataset.enterAuth || 'login');
      return;
    }
    const anchor = event.target.closest('a[href^="#landing-"]');
    if (anchor) {
      const target = document.querySelector(anchor.getAttribute('href'));
      if (target) {
        event.preventDefault();
        setDrawerOpen(false);
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });

  const revealTargets = [...screen.querySelectorAll('[data-reveal]')];
  const heroTargets = [...screen.querySelectorAll('[data-hero-reveal]')];
  let observer = null;

  function triggerLandingMotion() {
    if (screen.hidden) return;
    requestAnimationFrame(() => {
      heroTargets.forEach(el => el.classList.add('is-revealed'));
    });
    if ('IntersectionObserver' in window) {
      observer?.disconnect();
      observer = new IntersectionObserver(entries => {
        let revealedAny = false;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-revealed');
            observer.unobserve(entry.target);
            revealedAny = true;
          }
        }
        if (revealedAny) {
          for (const el of revealTargets) {
            if (!el.classList.contains('is-revealed') && el.getBoundingClientRect().top < window.innerHeight) {
              el.classList.add('is-revealed');
              observer.unobserve(el);
            }
          }
        }
      }, { threshold: 0.08, rootMargin: '0px 0px -24px 0px' });
      revealTargets.forEach(el => {
        if (!el.classList.contains('is-revealed')) observer.observe(el);
      });
    } else {
      revealTargets.forEach(el => el.classList.add('is-revealed'));
    }
  }

  const visibilityWatcher = new MutationObserver(() => {
    if (!screen.hidden) triggerLandingMotion();
  });
  visibilityWatcher.observe(screen, { attributes: true, attributeFilter: ['hidden'] });
  if (!screen.hidden) triggerLandingMotion();

  function setButtonLabel(button, label, mode, { workspace = false } = {}) {
    if (!button) return;
    const span = button.querySelector('.sn-lp-cta-label');
    if (span) span.textContent = label;
    else button.textContent = label;
    if (workspace) {
      delete button.dataset.enterAuth;
      button.dataset.enterWorkspace = 'true';
    } else if (mode) {
      delete button.dataset.enterWorkspace;
      button.dataset.enterAuth = mode;
    }
  }

  function syncLandingState({ setupRequired, multiOrgEnabled, authenticated = false }) {
    const primary = document.querySelector('#landing-primary-cta');
    const secondary = document.querySelector('#landing-secondary-cta');
    const navInvite = document.querySelector('#landing-nav-invite');
    const navRegister = document.querySelector('#landing-nav-register');
    const navLogin = document.querySelector('#landing-nav-login');
    const bottomPrimary = document.querySelector('#landing-bottom-cta');
    const bottomSecondary = document.querySelector('#landing-bottom-secondary');
    const drawerPrimary = document.querySelector('#landing-drawer-cta');
    const drawerLogin = document.querySelector('#landing-drawer-login');

    if (authenticated) {
      setButtonLabel(primary, '进入工作台', null, { workspace: true });
      setButtonLabel(navRegister, '进入工作台', null, { workspace: true });
      setButtonLabel(bottomPrimary, '进入工作台', null, { workspace: true });
      setButtonLabel(drawerPrimary, '进入工作台', null, { workspace: true });
      if (secondary) secondary.hidden = true;
      if (navInvite) navInvite.hidden = true;
      if (navLogin) navLogin.hidden = true;
      if (navRegister) navRegister.hidden = false;
      if (bottomSecondary) bottomSecondary.hidden = true;
      if (drawerLogin) drawerLogin.hidden = true;
      return;
    }

    if (setupRequired) {
      setButtonLabel(primary, '初始化负责人账号', 'setup');
      setButtonLabel(navRegister, '初始化账号', 'setup');
      setButtonLabel(bottomPrimary, '初始化本地工作空间', 'setup');
      setButtonLabel(drawerPrimary, '初始化负责人账号', 'setup');
      if (secondary) secondary.hidden = true;
      if (navInvite) navInvite.hidden = true;
      if (navLogin) navLogin.hidden = true;
      if (navRegister) navRegister.hidden = false;
      if (bottomSecondary) bottomSecondary.hidden = true;
      if (drawerLogin) drawerLogin.hidden = true;
      return;
    }

    if (navInvite) navInvite.hidden = false;
    if (navLogin) {
      navLogin.hidden = false;
      setButtonLabel(navLogin, '登录', 'login');
    }
    if (drawerLogin) {
      drawerLogin.hidden = false;
      setButtonLabel(drawerLogin, '登录工作空间', 'login');
    }

    if (multiOrgEnabled) {
      setButtonLabel(primary, '创建企业工作区', 'register');
      setButtonLabel(secondary, '登录已有工作空间', 'login');
      setButtonLabel(navRegister, '创建工作区', 'register');
      setButtonLabel(bottomPrimary, '创建企业工作区', 'register');
      setButtonLabel(bottomSecondary, '登录工作空间', 'login');
      setButtonLabel(drawerPrimary, '创建企业工作区', 'register');
      if (secondary) secondary.hidden = false;
      if (navRegister) navRegister.hidden = false;
      if (bottomSecondary) bottomSecondary.hidden = false;
    } else {
      setButtonLabel(primary, '登录工作空间', 'login');
      setButtonLabel(secondary, '接受成员邀请', 'accept_invite');
      setButtonLabel(bottomPrimary, '登录工作空间', 'login');
      setButtonLabel(bottomSecondary, '接受成员邀请', 'accept_invite');
      setButtonLabel(drawerPrimary, '登录工作空间', 'login');
      if (secondary) secondary.hidden = false;
      if (navRegister) navRegister.hidden = true;
      if (bottomSecondary) bottomSecondary.hidden = false;
    }
  }

  return { syncLandingState };
}
