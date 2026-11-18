// test/security.test.js — публичная гарантия: скрипт работает только на
// emias.info и обращается только к ЕМИАС. Если кто-то (автор по ошибке,
// чужой пулл-реквест или взломщик) расширит @match, добавит разрешения
// Tampermonkey или запрос на сторонний адрес, этот тест упадёт, и GitHub
// Action покажет красный крестик у коммита.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTimedFetch } = require('../core/util.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist/emias-slot-hunter.user.js');

function split() {
  const src = fs.readFileSync(DIST, 'utf8');
  const end = src.indexOf('// ==/UserScript==');
  assert.ok(src.startsWith('// ==UserScript==') && end > 0, 'файл должен начинаться с шапки userscript');
  const meta = src.slice(0, end).split('\n')
    .map((l) => l.match(/^\/\/ @(\S+)\s*(.*)$/)).filter(Boolean)
    .map((m) => ({ key: m[1], value: m[2].trim() }));
  return { meta, body: src.slice(end) };
}

const values = (meta, key) => meta.filter((m) => m.key === key).map((m) => m.value);

test('шапка: скрипт запускается только на emias.info', () => {
  const { meta } = split();
  assert.deepEqual(values(meta, 'match'), ['https://emias.info/*']);
  assert.deepEqual(values(meta, 'include'), [], '@include запрещён — только @match');
});

test('шапка: никаких разрешений Tampermonkey и внешних подключений', () => {
  const { meta } = split();
  assert.deepEqual(values(meta, 'grant'), ['none']);
  for (const key of ['connect', 'require', 'resource', 'antifeature', 'webRequest']) {
    assert.deepEqual(values(meta, key), [], `@${key} запрещён`);
  }
});

test('шапка: скрипт обновляется только вручную', () => {
  const { meta } = split();
  assert.deepEqual(values(meta, 'updateURL'), []);
  assert.deepEqual(values(meta, 'downloadURL'), ['none']);
});

test('код: в нём нет адресов, кроме emias.info', () => {
  const { body } = split();
  const hosts = new Set([...body.matchAll(/(?:https?:|wss?:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) => m[1].toLowerCase()));
  for (const h of hosts) assert.equal(h, 'emias.info', `в коде найден посторонний адрес: ${h}`);
});

test('код: fetch только по относительным путям ЕМИАС', () => {
  const { body } = split();
  // Обёртка с таймаутом проверяет относительный путь, origin и отключает редиректы.
  const wrapped = "fetch(url, { ...opts, mode: 'same-origin', redirect: 'error', signal: controller.signal })";
  assert.equal(body.split(wrapped).length, 2);
  const direct = body.replace(wrapped, '');
  const calls = [...direct.matchAll(/\bfetch\s*\(\s*(.)/g)];
  assert.ok(calls.length > 0);
  for (const c of calls) {
    const rest = direct.slice(c.index + c[0].length - 1, c.index + c[0].length + 1);
    assert.ok(/^['"`]\//.test(rest), `fetch должен начинаться с пути '/…' на том же сайте: ${direct.slice(c.index, c.index + 60)}`);
  }
});

test('обёртка fetch отбрасывает сторонние URL и переходы между путями', async () => {
  let calls = 0;
  const fetch = createTimedFetch(async () => { calls++; });
  for (const url of ['https://example.invalid/api-eip/slots', '//example.invalid/api-eip/slots', '/api-eip/../other']) {
    await assert.rejects(fetch(url, {}), /разрешённых путей/);
  }
  assert.equal(calls, 0);
});

test('код: нет других способов отправить данные или выполнить чужой код', () => {
  const { body } = split();
  const banned = [
    [/XMLHttpRequest/, 'XMLHttpRequest'], [/sendBeacon/, 'navigator.sendBeacon'],
    [/\bWebSocket\b/, 'WebSocket'], [/\bEventSource\b/, 'EventSource'],
    [/\bGM_\w+|\bGM\.\w+/, 'API Tampermonkey (GM_*)'], [/\beval\s*\(/, 'eval'],
    [/new\s+Function\b/, 'new Function'], [/\bimport\s*\(/, 'import()'],
    [/importScripts/, 'importScripts'], [/new\s+Image\b/, 'new Image'],
    [/createElement\(\s*['"`](script|img|iframe|link|form)/i, 'вставка script/img/iframe/link/form'],
    [/\.(src|action|href)\s*=(?!=)/, 'присваивание .src/.action/.href'],
    [/window\.open\s*\(/, 'window.open'], [/(?:location\.href\s*=|location\.(assign|replace)\s*\()/, 'переход на другой адрес'],
  ];
  for (const [re, name] of banned) assert.ok(!re.test(body), `в коде появился запрещённый приём: ${name}`);
  // Единственный Worker — таймер из Blob (core/index.js), чтобы фоновая вкладка не засыпала.
  assert.equal((body.match(/new\s+Worker\s*\(/g) || []).length, 1, 'Worker допускается только один — таймер');
});
