/* ==========================================================================
   auth.js - Google Identity Services sign-in.

   The browser holds a Google ID token; every privileged API call sends it in
   the POST body and the backend verifies it against Google before trusting any
   claim in it. Nothing here is a security boundary - hiding the Admin link is
   a convenience, and the server re-checks the allow-list on every call.

   The token lives in sessionStorage: it expires after an hour anyway, and
   keeping it out of localStorage means it does not survive the tab.
   ========================================================================== */

const Auth = (function () {
  const STORAGE_KEY = 'pfc.idToken';
  const listeners = [];

  let clientId = '';
  let token = null;
  let profile = null;   // decoded from the token, for display only
  let me = null;        // server's answer to whoAmI, including isTeacher
  let initialised = false;
  let initPromise = null;

  /* ---- Token plumbing -------------------------------------------------- */

  function decodeJwt(jwt) {
    try {
      const payload = jwt.split('.')[1];
      const json = decodeURIComponent(
        atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  /** Treat a token as expired 60s early so it cannot die mid-request. */
  function isExpired(claims) {
    if (!claims || !claims.exp) return true;
    return (claims.exp * 1000) - 60000 <= Date.now();
  }

  function restore() {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const claims = decodeJwt(stored);
    if (isExpired(claims)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    token = stored;
    profile = claims;
  }

  function getToken() {
    if (!token) return null;
    if (isExpired(profile)) {
      clearToken();
      return null;
    }
    return token;
  }

  function clearToken() {
    token = null;
    profile = null;
    me = null;
    sessionStorage.removeItem(STORAGE_KEY);
    notify();
  }

  function signOut() {
    try {
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.disableAutoSelect();
      }
    } catch (e) { /* not fatal */ }
    clearToken();
    UI.toast('You have been signed out.', 'info', 4000);
  }

  /* ---- Listeners ------------------------------------------------------- */

  function onChange(callback) {
    listeners.push(callback);
    if (initialised) callback(state());
    return () => {
      const i = listeners.indexOf(callback);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function state() {
    return {
      signedIn: !!getToken(),
      email: (me && me.email) || (profile && profile.email) || '',
      name: (me && me.name) || (profile && profile.name) || '',
      picture: (me && me.picture) || (profile && profile.picture) || '',
      isTeacher: !!(me && me.isTeacher),
      resolved: !!me     // false until whoAmI has come back
    };
  }

  function notify() {
    renderChrome();
    const snapshot = state();
    listeners.forEach((cb) => {
      try { cb(snapshot); } catch (e) { console.error('Auth listener failed', e); }
    });
  }

  /* ---- Google Identity Services --------------------------------------- */

  function gisReady() {
    return new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.id) return resolve();
      let waited = 0;
      const timer = setInterval(() => {
        if (window.google && google.accounts && google.accounts.id) {
          clearInterval(timer);
          resolve();
        } else if ((waited += 100) > 10000) {
          clearInterval(timer);
          reject(new Error('Google Sign-In did not load. Check your connection or any ad blocker.'));
        }
      }, 100);
    });
  }

  /** Client ID from config.js, or from the backend when that is left blank. */
  async function resolveClientId() {
    const configured = (window.APP_CONFIG && window.APP_CONFIG.GOOGLE_CLIENT_ID || '').trim();
    if (configured) return configured;
    const remote = await Api.getConfig();
    if (!remote || !remote.googleClientId) {
      throw new Error(
        'No Google Client ID is configured. Set GOOGLE_CLIENT_ID in js/config.js, or run ' +
        'setOAuthClientId(...) in the Apps Script editor.'
      );
    }
    return remote.googleClientId;
  }

  async function onCredential(response) {
    const claims = decodeJwt(response.credential);
    if (!claims) {
      UI.toast('That sign-in could not be read. Please try again.', 'error');
      return;
    }
    token = response.credential;
    profile = claims;
    sessionStorage.setItem(STORAGE_KEY, token);
    notify();
    await refreshMe({ announce: true });
  }

  /**
   * Ask the server who we are. This is what populates isTeacher and what
   * surfaces a non-Rice account as a clear rejection rather than a silent
   * half-signed-in state.
   */
  async function refreshMe(opts = {}) {
    if (!getToken()) return null;
    try {
      me = await Api.whoAmI();
      notify();
      if (opts.announce) {
        UI.toast(`Signed in as ${me.name || me.email}.`, 'success', 4000);
      }
      return me;
    } catch (e) {
      me = null;
      if (e && e.code === 'FORBIDDEN_DOMAIN') {
        clearToken();
        UI.toast(e.message, 'error', 10000);
      } else if (e && e.code === 'UNAUTHENTICATED') {
        clearToken();
      } else {
        notify();
        UI.toast((e && e.message) || 'Could not verify your sign-in.', 'error');
      }
      return null;
    }
  }

  /* ---- Rendering ------------------------------------------------------- */

  function renderButtons() {
    if (!clientId || !window.google || !google.accounts || !google.accounts.id) return;
    document.querySelectorAll('.g-signin-holder').forEach((holder) => {
      holder.innerHTML = '';
      google.accounts.id.renderButton(holder, {
        theme: 'outline',
        size: holder.dataset.size || 'medium',
        text: 'signin_with',
        shape: 'rectangular',
        logo_alignment: 'left',
        width: holder.dataset.width ? Number(holder.dataset.width) : undefined
      });
    });
  }

  function initials(name, email) {
    const source = (name || email || '?').trim();
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }

  /** Header slot: sign-in button when signed out, user chip when signed in. */
  function renderChrome() {
    const snapshot = state();

    document.querySelectorAll('[data-teacher-only]').forEach((el) => {
      el.hidden = !snapshot.isTeacher;
    });

    const slot = document.querySelector('#auth-slot');
    if (!slot) return;

    if (!snapshot.signedIn) {
      slot.innerHTML = '<div class="g-signin-holder" data-size="medium"></div>';
      renderButtons();
      return;
    }

    const avatar = snapshot.picture
      ? `<img src="${UI.esc(snapshot.picture)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="avatar" aria-hidden="true">${UI.esc(initials(snapshot.name, snapshot.email))}</span>`;

    slot.innerHTML = `
      <div class="user-chip" title="${UI.esc(snapshot.email)}">
        <span class="user-chip-name">${UI.esc(snapshot.name || snapshot.email)}</span>
        ${avatar}
      </div>
      <button class="btn btn-ghost btn-sm" type="button" id="sign-out-btn">Sign out</button>`;

    const button = slot.querySelector('#sign-out-btn');
    if (button) button.addEventListener('click', signOut);
  }

  /**
   * Render a sign-in call to action into a container, for pages that need an
   * identity before they can show anything.
   */
  function renderSignInPrompt(container, message) {
    container.innerHTML = `
      <div class="signin-prompt">
        <div>
          <h3>Sign in to continue</h3>
          <p class="muted">${UI.esc(message || 'Use your Rice University Google account.')}</p>
        </div>
        <div class="g-signin-holder" data-size="large" data-width="280"></div>
      </div>`;
    renderButtons();
  }

  /* ---- Init ------------------------------------------------------------ */

  /**
   * Wire everything up. Safe to call from every page; the work happens once.
   */
  function init() {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      restore();
      renderChrome();   // paint the signed-in chip immediately on reload

      try {
        clientId = await resolveClientId();
        await gisReady();

        google.accounts.id.initialize({
          client_id: clientId,
          callback: onCredential,
          auto_select: true,
          cancel_on_tap_outside: true,
          ux_mode: 'popup',
          itp_support: true,
          // Hint only - the account picker prefers this domain, and the server
          // rejects anything else regardless of what the picker allows.
          hd: (window.APP_CONFIG && window.APP_CONFIG.HOSTED_DOMAIN) || undefined
        });

        initialised = true;

        // Exactly one notify() on every path, so pages that wait for the first
        // auth callback still hear about a signed-out visitor.
        if (getToken()) {
          await refreshMe();
        } else {
          notify();
        }
      } catch (e) {
        initialised = true;
        console.error('Auth init failed:', e);
        UI.toast(e.message || 'Sign-in could not be set up.', 'error', 12000);
        notify();
      }

      return state();
    })();

    return initPromise;
  }

  /**
   * Show the One Tap / account chooser on demand, e.g. when a signed-out
   * visitor clicks Book.
   */
  function promptSignIn() {
    try {
      if (window.google && google.accounts && google.accounts.id) {
        google.accounts.id.prompt();
      }
    } catch (e) {
      console.warn('prompt() unavailable', e);
    }
  }

  return {
    init, onChange, state, getToken, clearToken, signOut,
    refreshMe, renderButtons, renderSignInPrompt, promptSignIn
  };
})();

window.Auth = Auth;
