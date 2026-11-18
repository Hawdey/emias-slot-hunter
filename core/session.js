// Токены охотника хранятся только в памяти и действуют в рамках входа сайта.
(function (root) {
  'use strict';

  const SITE_KEY = 'persist:sessionAuth';
  const LEGACY_KEY = 'emiasSlotHunter:auth';

  function selectedPolicy(storage) {
    try { return JSON.parse(JSON.parse(storage.getItem('persist:persist')).persistOmsNumber) || null; }
    catch (e) { return null; }
  }

  function sessionError(message = 'Войдите в ЕМИАС и настройте поиск заново.') {
    return Object.assign(new Error(message), { name: 'SessionError' });
  }

  function createSession({ storage, fetch, now }) {
    let site = null;
    let auth = null;
    let identity = { oms: null, birth: null };
    let refreshing = null;
    let refreshedAt = 0;

    try { storage.removeItem(LEGACY_KEY); } catch (e) { /* хранилище может быть недоступно */ }

    function readSite() {
      try {
        const raw = JSON.parse(storage.getItem(SITE_KEY));
        const access = JSON.parse(raw.accessToken);
        if (typeof access !== 'string' || !access) return null;
        const parse = (value) => { try { return JSON.parse(value); } catch (e) { return null; } };
        return { access, refresh: parse(raw.refreshToken), idToken: parse(raw.idToken) };
      } catch (e) { return null; }
    }

    function clear() {
      site = null;
      auth = null;
      identity = { oms: null, birth: null };
      refreshing = null;
      refreshedAt = 0;
    }

    function clearAfter(pending) {
      const scope = site;
      const clearIfUnchanged = () => { if (site === scope) clear(); };
      pending.then(clearIfUnchanged, clearIfUnchanged);
    }

    function read() {
      clear();
      const current = readSite();
      if (!current) throw sessionError('Нет входа в ЕМИАС. Войдите на сайте.');
      site = { ...current, policy: selectedPolicy(storage) };
      auth = { access: site.access, refresh: site.refresh };
      return site;
    }

    function assertContext(expected = site) {
      const current = readSite();
      if (!expected || expected !== site) throw sessionError();
      if (!current || (current.idToken || current.access) !== (site.idToken || site.access)
          || selectedPolicy(storage) !== site.policy) {
        clear();
        throw sessionError('Вход или выбранный полис изменился. Настройте поиск заново.');
      }
      if (current.access !== site.access || current.refresh !== site.refresh) {
        site.access = current.access;
        site.refresh = current.refresh;
        auth = { access: site.access, refresh: site.refresh };
      }
      return site;
    }

    function refresh() {
      const scope = assertContext();
      if (refreshing) return refreshing;
      const previous = auth;
      if (!previous.refresh) return Promise.resolve(false);
      const pending = (async () => {
        const r = await fetch('/web-api/refreshTokens/', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-App': 'portal' },
          body: JSON.stringify({ refreshToken: previous.refresh }),
        });
        const j = r.ok ? await r.json().catch(() => null) : null;
        assertContext(scope);
        // Если сайт уже обновил вход, используем его ответ.
        if (auth !== previous) return true;
        if (typeof j?.access_token !== 'string' || !j.access_token) return false;
        auth = { access: j.access_token, refresh: j.refresh_token || previous.refresh };
        refreshedAt = now();
        return true;
      })().finally(() => { if (refreshing === pending) refreshing = null; });
      refreshing = pending;
      return pending;
    }

    return {
      read, clear, clearAfter, assertContext, refresh,
      token: () => { assertContext(); return auth.access; },
      identity: () => identity,
      setIdentity: (value, scope) => { assertContext(scope); identity = value; },
      get refreshedAt() { return refreshedAt; },
    };
  }

  const api = { createSession };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
