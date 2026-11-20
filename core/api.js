// core/api.js
(function (root) {
  'use strict';

  class SessionError extends Error {
    constructor(message) {
      super(message);
      this.name = 'SessionError';
    }
  }

  const NET_STEPS = [30000, 60000, 120000, 300000];

  function retryAfterTime(r, at) {
    const header = r.headers?.get?.('Retry-After')?.trim();
    if (!header) return 0;
    const time = /^\d+$/.test(header) ? at + Number(header) * 1000 : Date.parse(header);
    return Number.isSafeInteger(time) ? time : 0;
  }

  function createApi({ session, errors, fetch, now, wait }) {
    let backoffUntil = 0;
    let netStep = -1;
    let nextRequestAt = 0;
    let queue = Promise.resolve();

    function waitForTurn(canSend) {
      const turn = queue.then(async () => {
        if (canSend && !canSend()) return;
        if (now() < backoffUntil) return;
        const delay = nextRequestAt - now();
        if (delay > 0) await wait(delay);
        if ((!canSend || canSend()) && now() >= backoffUntil) nextRequestAt = now() + 2000;
      });
      queue = turn.catch(() => {});
      return turn;
    }

    // Общая часть post() и get(): заголовки, сетевой бэкофф, продление сессии
    // по 401, разбор ответа. body === undefined → запрос без тела (GET), с
    // телом → Content-Type и JSON.stringify (POST).
    async function request(method, path, body, retried, canSend) {
      if (wait) await waitForTurn(canSend);
      if (canSend && !canSend()) return { ok: false, aborted: true };
      if (now() < backoffUntil) {
        const seconds = Math.ceil((backoffUntil - now()) / 1000);
        return { ok: false, status: 429, json: null, explained: { message: `Пауза ЕМИАС. Следующий запрос через ${seconds} сек.`, action: 'wait' } };
      }
      const headers = { Accept: 'application/json', 'EI-Token': session.token(), 'X-App': 'portal' };
      const opts = { method, headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      let r;
      let text;
      try {
        r = await fetch('/api-eip/' + path, opts);
        text = await r.text();
      } catch (e) {
        // Увеличиваем паузу при сетевой ошибке: 30s → 60s → 120s → 300s
        netStep = Math.min(netStep + 1, NET_STEPS.length - 1);
        backoffUntil = Math.max(backoffUntil, now() + NET_STEPS[netStep]);
        return { ok: false, status: 0, json: null, explained: { message: 'Нет связи с ЕМИАС — попробую позже.', action: 'wait' } };
      }
      // Сброс счётчика сетевых ошибок при успешном соединении
      netStep = -1;

      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }

      // 401: пытаемся один раз продлить сессию и повторить запрос
      if (r.status === 401 && !retried) {
        if (canSend && !canSend()) return { ok: false, aborted: true };
        let refreshed = false;
        try { refreshed = await session.refresh(); }
        catch (e) { if (e?.name === 'SessionError') throw e; }
        if (canSend && !canSend()) return { ok: false, aborted: true };
        if (refreshed) return request(method, path, body, true, canSend);
      }
      // Повторный 401 — сессия не продлевается. Текст этого сообщения попадает
      // пользователю на глаза как есть (userscript/ui-dom.js onSessionLost
      // показывает payload.message из core/runner.js 'сессия потеряна'/e.message
      // в пояснении к значку), поэтому пишем его по-человечески, а не
      // техническим языком — и той же формулировкой, что уже даёт errors.js
      // для 401 (см. explain()), чтобы текст не расходился в зависимости от
      // того, через какой путь сессия оказалась потеряна.
      if (r.status === 401) throw new SessionError('Вход в ЕМИАС закончился. Войдите заново и настройте поиск.');
      let pauseSeconds;
      if (r.status === 429 || r.status >= 500) {
        const at = now();
        backoffUntil = Math.max(backoffUntil, at + (r.status === 429 ? 60000 : 30000), retryAfterTime(r, at));
        pauseSeconds = Math.ceil((backoffUntil - at) / 1000);
      }

      // Если 2xx статус но JSON не разобрался и текст не пустой (например, HTML-заглушка) — это ошибка
      // Пустой текст с 2xx считается успехом (json: null)
      if (r.ok && json === null && text.trim() !== '') {
        return {
          ok: false, status: r.status, json: null,
          explained: errors.explain({ status: r.status }),
        };
      }

      const err = json && (json.error || (json.errorCode ? { code: json.errorCode, description: json.description } : null));
      const ok = r.ok && !err;
      return {
        ok, status: r.status, json,
        explained: ok ? null : errors.explain({ status: r.status, code: err?.code, description: err?.description, pauseSeconds }),
      };
    }

    function post(path, body, canSend) {
      const id = session.identity();
      return request('POST', path, { omsNumber: id.oms, birthDate: id.birth, ...body }, false, canSend);
    }

    // GET без тела и без omsNumber/birthDate — используется до того, как
    // личность вообще определена (core/index.js: фолбэк даты рождения на
    // /v2/policy/list), поэтому в отличие от post() ничего не берёт из
    // session.identity().
    function get(path, retried) {
      return request('GET', path, undefined, retried);
    }

    return { post, get, backoffUntil: () => backoffUntil, SessionError };
  }

  const api = { createApi, SessionError };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
