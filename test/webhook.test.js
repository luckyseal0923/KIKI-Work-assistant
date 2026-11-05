import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from '../src/server.js';
import { validSignature } from '../src/webhook.js';
import { loadConfig, databaseConfig, ConfigError } from '../src/config.js';

// Entirely synthetic credentials, identities, and text. No live LINE traffic.
const secret = 'synthetic-test-secret-only';
const group = `C${'1'.repeat(32)}`;
const user = `U${'2'.repeat(32)}`;
const config = { mode: 'record', secret, allowedGroupId: group };
function event(overrides = {}) {
  return { type: 'message', webhookEventId: 'synthetic-event-1', timestamp: 1793836800123,
    source: { type: 'group', groupId: group, userId: user },
    message: { type: 'text', id: 'synthetic-message-1', text: '合成測試：明天開會\n"09:00" 🧪', quotedMessageId: 'synthetic-quote' },
    ...overrides };
}
const sign = raw => createHmac('sha256', secret).update(raw).digest('base64');
async function serve(t, options = {}) {
  const calls = [], logs = [];
  const store = { save: async events => { calls.push(events); return events.length; }, ready: async () => {}, ...options.store };
  const server = createServer({ config: options.config || config, store, log: (...args) => logs.push(args) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { calls, logs, url, post: (raw, signature = sign(raw), headers = {}) => fetch(`${url}/webhook`, {
    method: 'POST', headers: { 'x-line-signature': signature, ...headers }, body: raw,
  }) };
}

test('HMAC validates original bytes, rejects missing/forged signatures and parsed-reserialized JSON', () => {
  const raw = Buffer.from('{ "events": [], "sample":"合成\\n測試" }');
  assert.equal(validSignature(raw, sign(raw), secret), true);
  for (const bad of [undefined, '', '!', sign(raw).slice(1), 'A'.repeat(43) + '=']) {
    assert.equal(validSignature(raw, bad, secret), false);
  }
  assert.equal(validSignature(Buffer.from(JSON.stringify(JSON.parse(raw))), sign(raw), secret), false);
});

test('configuration fails closed and accepts only the dedicated role and explicit TLS policy', () => {
  assert.throws(() => loadConfig({ APP_MODE: 'discover' }), ConfigError);
  assert.throws(() => loadConfig({ APP_MODE: 'record', LINE_CHANNEL_SECRET: secret }), ConfigError);
  assert.throws(() => loadConfig({ APP_MODE: 'auto', LINE_CHANNEL_SECRET: secret }), ConfigError);
  assert.equal(loadConfig({ APP_MODE: 'discover', LINE_CHANNEL_SECRET: secret }).database, null);
  const env = { DB_HOST: 'synthetic-db.internal', DB_NAME: 'postgres', DB_USER: 'linebot_app', DB_PASSWORD: 'synthetic-only' };
  assert.equal(databaseConfig(env).ssl.rejectUnauthorized, true);
  assert.equal(databaseConfig(env).max, 2);
  assert.throws(() => databaseConfig({ ...env, DB_USER: 'postgres' }), ConfigError);
  assert.throws(() => databaseConfig({ ...env, DB_TLS: 'private' }), ConfigError);
  assert.throws(() => databaseConfig({ ...env, DB_TLS: 'require' }), ConfigError);
  assert.equal(databaseConfig({ ...env, DB_TLS: 'private', DB_PRIVATE_NETWORK_CONFIRMED: 'true' }).ssl, false);
});

test('signed allowed text preserves text, timestamp, quote, and nullable user ID', async t => {
  const s = await serve(t);
  const e = event({ source: { type: 'group', groupId: group } });
  assert.equal((await s.post(JSON.stringify({ events: [e] }))).status, 200);
  assert.deepEqual(s.calls[0][0], { kind: 'message', eventId: e.webhookEventId, groupId: group,
    at: new Date(e.timestamp).toISOString(), messageId: e.message.id, userId: null,
    text: e.message.text, quotedMessageId: e.message.quotedMessageId });
  const logs = JSON.stringify(s.logs);
  for (const excluded of [e.message.text, e.message.quotedMessageId, group, secret]) assert.equal(logs.includes(excluded), false);
});

test('other groups, personal chats, rooms, and non-text content are ignored', async t => {
  const s = await serve(t);
  const events = [event({ source: { type: 'group', groupId: `C${'3'.repeat(32)}` } }),
    event({ source: { type: 'user', userId: user } }),
    event({ source: { type: 'room', roomId: 'synthetic-room' } }),
    event({ message: { id: 'synthetic-photo', type: 'image' } }), event({ type: 'join' })];
  assert.equal((await s.post(JSON.stringify({ events }))).status, 200);
  assert.equal(s.calls.length, 0);
  assert.equal(s.logs.length, 0);
});

test('discovery works from already-joined group messages, logs only ID, and never stores text', async t => {
  const s = await serve(t, { config: { ...config, mode: 'discover' } });
  const raw = JSON.stringify({ events: [event(), event({ type: 'join' })] });
  assert.equal((await s.post(raw)).status, 200);
  assert.deepEqual(s.logs, [['group_candidate', { group_id: group }]]);
  assert.equal(s.calls.length, 0);
  await s.post(raw);
  assert.equal(s.logs.length, 1);
});

test('unsigned discovery cannot reveal a group and signature is checked before JSON parsing', async t => {
  const s = await serve(t, { config: { ...config, mode: 'discover' } });
  assert.equal((await s.post(JSON.stringify({ events: [event()] }), 'invalid')).status, 401);
  assert.equal((await s.post('not json', 'invalid')).status, 401);
  assert.equal(s.calls.length, 0);
  assert.equal(JSON.stringify(s.logs).includes(group), false);
});

test('signed empty verification succeeds; malformed data, oversized bodies and compression are rejected', async t => {
  const s = await serve(t);
  assert.equal((await s.post('{"events":[]}')).status, 200);
  assert.equal((await s.post('not json')).status, 400);
  assert.equal((await s.post('{}')).status, 400);
  assert.equal((await s.post(JSON.stringify({ events: [event({ timestamp: 'wrong' })] }))).status, 400);
  assert.equal((await s.post(JSON.stringify({ events: [event({ webhookEventId: undefined })] }))).status, 400);
  assert.equal((await s.post('x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await s.post('{"events":[]}', undefined, { 'content-encoding': 'gzip' })).status, 415);
  assert.equal(s.calls.length, 0);
});

test('database failure returns 503 and never logs error/row/connection information', async t => {
  const s = await serve(t, { store: { save: async () => { throw new Error('synthetic-row-secret database-password'); } } });
  const response = await s.post(JSON.stringify({ events: [event()] }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false });
  assert.deepEqual(s.logs, [['storage_unavailable', { status: 503 }]]);
});

test('does not acknowledge before storage commits', async t => {
  let entered, commit;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { commit = resolve; });
  const s = await serve(t, { store: { save: async () => { entered(); await gate; return 1; } } });
  let acknowledged = false;
  const pending = s.post(JSON.stringify({ events: [event()] })).then(r => { acknowledged = true; return r; });
  await started;
  await new Promise(setImmediate);
  assert.equal(acknowledged, false);
  commit();
  assert.equal((await pending).status, 200);
});

test('burst beyond four in-flight deliveries gets 503 with a bounded storage queue', async t => {
  let count = 0, entered, release;
  const full = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const s = await serve(t, { store: { save: async () => { if (++count === 4) entered(); await gate; return 1; } } });
  const raw = JSON.stringify({ events: [event()] });
  const pending = Array.from({ length: 4 }, () => s.post(raw));
  await full;
  try { assert.equal((await s.post(raw)).status, 503); assert.equal(count, 4); }
  finally { release(); await Promise.all(pending); }
});

test('health and cached readiness expose only status; database outage is not ready', async t => {
  let probes = 0;
  const s = await serve(t, { store: { ready: async () => { probes++; throw new Error('synthetic-private-host'); } } });
  const health = await fetch(`${s.url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const ready = await fetch(`${s.url}/readyz`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { ok: false });
  assert.equal((await fetch(`${s.url}/readyz`)).status, 503);
  assert.equal(probes, 1);
  assert.equal((await fetch(`${s.url}/missing`)).status, 404);
});
