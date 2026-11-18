const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../core/session.js');

const SITE = 'persist:sessionAuth';
const POLICY = 'persist:persist';
const OLD = 'emiasSlotHunter:auth';
const auth = (account, access = 'site-a') => JSON.stringify({
  accessToken: JSON.stringify(access),
  refreshToken: JSON.stringify('site-r'),
  idToken: JSON.stringify(account),
});
const policy = (id) => JSON.stringify({ persistOmsNumber: JSON.stringify(id) });
const refreshReply = { ok: true, json: async () => ({ access_token: 'new-a', refresh_token: 'new-r' }) };

function setup(fetch = async () => refreshReply) {
  const data = new Map([[SITE, auth('login-one')], [POLICY, policy('one')], [OLD, 'old-session']]);
  const storage = { getItem: (k) => data.get(k) ?? null, removeItem: (k) => data.delete(k) };
  return { data, session: createSession({ storage, fetch, now: () => 1234 }) };
}

test('игнорирует и удаляет старую копию токенов', () => {
  const { data, session } = setup();
  assert.equal(data.has(OLD), false);
  assert.equal(session.read().access, 'site-a');
});

test('копия токенов существует только в памяти до выхода с сайта', async () => {
  const { data, session } = setup();
  session.read();
  assert.equal(await session.refresh(), true);
  assert.equal(session.token(), 'new-a');
  assert.equal(data.has(OLD), false);
  assert.equal(data.get(SITE), auth('login-one'));
  data.delete(SITE);
  assert.throws(() => session.token(), { name: 'SessionError' });
  assert.throws(() => session.read(), /нет входа/i);
});

test('сохраняет работу при ротации токена сайта с тем же входом', () => {
  const { data, session } = setup();
  session.read();
  data.set(SITE, auth('login-one', 'rotated-a'));
  assert.equal(session.token(), 'rotated-a');
});

test('останавливает работу при смене входа или полиса', () => {
  const { data, session } = setup();
  session.read();
  data.set(POLICY, policy('two'));
  assert.throws(() => session.token(), { name: 'SessionError' });
  session.read();
  data.set(SITE, auth('login-two'));
  assert.throws(() => session.token(), { name: 'SessionError' });
});

test('запоздавшее продление не перезаписывает сессию после выхода и нового входа', async () => {
  let reply;
  const { data, session } = setup(() => new Promise((resolve) => { reply = resolve; }));
  session.read();
  const pending = session.refresh();
  assert.equal(session.refresh(), pending);
  data.set(SITE, auth('login-two', 'other-a'));
  session.read();
  reply(refreshReply);
  await assert.rejects(pending, { name: 'SessionError' });
  assert.equal(session.token(), 'other-a');
});
