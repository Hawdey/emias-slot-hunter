// core/util.js
(function (root) {
  'use strict';

  const VERSION = '0.2.3';
  const TZ = 'Europe/Moscow';

  function createUtil() {
    const fmt = (d, opts) => d.toLocaleString('sv-SE', { timeZone: TZ, ...opts });
    const mskDate = (d = new Date()) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10);
    const mskTime = (d = new Date()) => fmt(d, { hour: '2-digit', minute: '2-digit', hour12: false });
    const mskDateTime = (d = new Date()) => fmt(d, { hour12: false });
    const hasZone = (iso) => /[+-]\d\d:?\d\d$|Z$/.test(String(iso).slice(10));
    const toMs = (iso) => new Date(hasZone(iso) ? iso : iso + '+03:00').getTime();
    const slotHHMM = (iso) => mskTime(new Date(toMs(iso)));
    const distTo = (range, startMs, endMs) =>
      Math.max(0, toMs(range.start) - endMs, startMs - toMs(range.end));
    const campus = (addr) => String(addr || '').replace(/,\s*к\.\s*\d+.*$/i, '').trim().toLowerCase();
    const jitter = (ms, rnd = Math.random) => Math.round(ms * (0.8 + rnd() * 0.4));

    return { VERSION, mskDate, mskTime, mskDateTime, toMs, slotHHMM, distTo, campus, jitter };
  }

  // Ограничиваем и ожидание заголовков, и чтение тела ответа.
  function createTimedFetch(fetch, timeoutMs = 12000) {
    return async (url, opts) => {
      if (typeof url !== 'string' || !/^\/(?:api-eip\/[a-z0-9/_-]+|web-api\/refreshTokens\/)$/i.test(url)) {
        throw new Error('Запрос за пределами разрешённых путей ЕМИАС.');
      }
      const controller = new AbortController();
      let timeout;
      const expired = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Истекло время ожидания ответа ЕМИАС.'));
        }, timeoutMs);
      });
      const request = async () => {
        const response = await fetch(url, { ...opts, mode: 'same-origin', redirect: 'error', signal: controller.signal });
        if (typeof response.text !== 'function') {
          const json = await response.json();
          return { ok: response.ok, status: response.status, headers: response.headers, json: async () => json, text: async () => JSON.stringify(json) };
        }
        const text = await response.text();
        return { ok: response.ok, status: response.status, headers: response.headers, text: async () => text, json: async () => JSON.parse(text) };
      };
      try { return await Promise.race([request(), expired]); }
      finally { clearTimeout(timeout); }
    };
  }

  const api = { VERSION, createUtil, createTimedFetch };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
