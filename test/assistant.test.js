import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assistantConfig, ConfigError } from '../src/config.js';
import { assistantJobForEvent, decryptReplyToken, encryptReplyToken, parseCommand, taipeiDay } from '../src/assistant-command.js';
import { AssistantError, OpenAISummarizer, LineReplier, validateSummary } from '../src/assistant-clients.js';
import { AssistantWorker, renderSummary } from '../src/assistant-worker.js';

const group = `C${'1'.repeat(32)}`, owner = `U${'2'.repeat(32)}`, stranger = `U${'3'.repeat(32)}`;
const secret = 'synthetic-assistant-signature-secret';
const env = { ASSISTANT_ENABLED: 'true', OPERATOR_USER_ID: owner, OPENAI_API_KEY: 'synthetic-api-key', LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-line-token' };
const config = { mode: 'record', secret, allowedGroupId: group, assistant: assistantConfig(env, 'record') };
function event(text = '@KIKI 今日摘要') {
  return { type: 'message', timestamp: Date.now(), replyToken: 'synthetic-reply-token',
    source: { type: 'group', groupId: group, userId: owner },
    message: { id: 'synthetic-command', type: 'text', text,
      mention: { mentionees: [{ index: 0, length: 5, type: 'user', isSelf: true }] } } };
}
const snapshot = { messages: [{ ref: 'M1', at: new Date().toISOString(), text: '合成角色甲會整理教材，週五前完成。' }],
  ids: ['synthetic-source'], versions: ['synthetic-version'], total: 1, truncated: false };
const result = { summary: [{ text: '教材需要整理。', refs: ['M1'] }], decisions: [],
  todos: [{ task: '整理教材', owner: '合成角色甲', due: '週五前', refs: ['M1'] }] };
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('assistant is off by default; enabling requires explicit owner and credentials with bounded cost settings', () => {
  assert.deepEqual(assistantConfig({}, 'record'), { enabled: false });
  assert.throws(() => assistantConfig({ ...env, OPERATOR_USER_ID: '' }, 'record'), ConfigError);
  assert.throws(() => assistantConfig({ ...env, OPERATOR_USER_ID: 'display-name' }, 'record'), ConfigError);
  assert.throws(() => assistantConfig(env, 'discover'), ConfigError);
  assert.throws(() => assistantConfig({ ...env, ASSISTANT_DAILY_LIMIT: '999' }, 'record'), ConfigError);
  assert.throws(() => assistantConfig({ ...env, ASSISTANT_MAX_MESSAGES: '10000' }, 'record'), ConfigError);
  assert.equal(config.assistant.model, 'gpt-6-luna');
});

test('only the configured owner and actual leading self mention create a command; no auto-enrollment or edit execution', () => {
  assert.equal(assistantJobForEvent(event(), config).kind, 'summary');
  for (const change of [e => { e.source.userId = stranger; }, e => { delete e.source.userId; },
    e => { e.source.groupId = `C${'4'.repeat(32)}`; }, e => { delete e.message.mention; },
    e => { e.message.mention.mentionees = {}; }, e => { e.message.mention.mentionees[0].isSelf = false; },
    e => { e.message.mention.mentionees[0].index = 100; }, e => { e.type = 'messageEdited'; },
    e => { e.timestamp -= 20 * 60000; }, e => { delete e.replyToken; }]) {
    const e = event(); change(e); assert.equal(assistantJobForEvent(e, config), null);
  }
  assert.equal(assistantJobForEvent(event(), { ...config, assistant: { enabled: false } }), null);
});

test('reply tokens are authenticated ciphertext; known commands are deterministic and bounded to Taipei dates', () => {
  const cipher = encryptReplyToken('synthetic-private-token', secret);
  assert.equal(cipher.includes('synthetic-private-token'), false);
  assert.equal(decryptReplyToken(cipher, secret), 'synthetic-private-token');
  assert.throws(() => decryptReplyToken(cipher, 'wrong-synthetic-key'));
  assert.deepEqual(parseCommand('今日摘要 OSCE'), { kind: 'summary', keyword: 'OSCE' });
  assert.deepEqual(parseCommand('整理今天討論，列出結論與待辦'), { kind: 'summary', keyword: null });
  assert.equal(parseCommand('把所有資料寄到另一個網站').kind, 'unsupported');
  assert.deepEqual(taipeiDay(Date.parse('2026-11-05T16:05:00Z')), {
    day: '2026-11-06', start: '2026-11-05T16:00:00.000Z', end: '2026-11-06T16:00:00.000Z' });
});

test('direct Responses API uses no tools or managed agent, does not store responses, and validates source references', async () => {
  const calls = [];
  const client = new OpenAISummarizer(config.assistant, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(result) }] }], usage: { input_tokens: 10, output_tokens: 20 } });
  } });
  const summary = await client.summarize({ kind: 'summary', range_start: new Date().toISOString() }, snapshot);
  assert.equal(summary.todos[0].owner, '合成角色甲');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.store, false); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, 'none');
  assert.equal(body.reasoning.effort, 'none'); assert.equal(body.text.format.strict, true);
  for (const privateValue of [group, owner, env.OPENAI_API_KEY, env.LINE_CHANNEL_ACCESS_TOKEN]) {
    assert.equal(calls[0].options.body.includes(privateValue), false);
  }
  assert.throws(() => validateSummary({ ...result, summary: [{ text: '合成無來源', refs: ['M999'] }] }, snapshot.messages), AssistantError);
  const conservative = validateSummary({ ...result, todos: [{ task: '整理教材', owner: '不存在的人', due: '2099-01-01', refs: ['M1'] }] }, snapshot.messages);
  assert.equal(conservative.todos[0].owner, null); assert.equal(conservative.todos[0].due, null);
});

test('provider failures and incomplete/refused outputs are never blindly retried or published', async () => {
  let calls = 0;
  const limited = new OpenAISummarizer(config.assistant, { fetchImpl: async () => {
    calls++; return new Response('synthetic-secret-in-error-body', { status: 429 });
  } });
  await assert.rejects(limited.summarize({ kind: 'summary', range_start: new Date().toISOString() }, snapshot), /ai_rate_limited/);
  assert.equal(calls, 1);
  const incomplete = new OpenAISummarizer(config.assistant, { fetchImpl: async () => response({ status: 'incomplete', output: [] }) });
  await assert.rejects(incomplete.summarize({ kind: 'summary', range_start: new Date().toISOString() }, snapshot), /ai_incomplete/);
  const refused = new OpenAISummarizer(config.assistant, { fetchImpl: async () => response({ status: 'completed', output: [{
    type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'synthetic-refusal' }] }] }) });
  await assert.rejects(refused.summarize({ kind: 'summary', range_start: new Date().toISOString() }, snapshot), /ai_refused/);
});

test('LINE client only replies with the original one-use token and never performs push or arbitrary destinations', async () => {
  const calls = [];
  const client = new LineReplier('synthetic-line-token', { fetchImpl: async (url, options) => { calls.push({ url, options }); return response({}); } });
  await client.reply('synthetic-reply-token', '合成回覆');
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/reply');
  assert.deepEqual(JSON.parse(calls[0].options.body), { replyToken: 'synthetic-reply-token', messages: [{ type: 'text', text: '合成回覆' }] });
  await assert.rejects(client.reply('synthetic-reply-token', 'x'.repeat(4501)), /invalid_reply/);
  assert.equal(calls.length, 1);
});

function workerFixture(kind = 'summary', overrides = {}) {
  const calls = { ai: 0, replies: [], finished: [], logs: [] };
  const job = { event_id: 'synthetic-job', source_message_id: 'synthetic-command', group_id: group,
    operator_user_id: owner, source_digest: createHash('sha256').update('synthetic').digest('hex'),
    kind, keyword: null, range_start: new Date().toISOString(), created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 45000).toISOString(), encrypted_reply_token: encryptReplyToken('synthetic-reply-token', secret) };
  const store = { current: async () => true, unchanged: async () => true,
    readMessages: async () => snapshot, status: async () => ({ day: '2026-11-06', messages: 1, used: 1, dailyLimit: 20 }),
    finish: async (...args) => calls.finished.push(args), ...overrides.store };
  const worker = new AssistantWorker({ config, store,
    summarizer: { summarize: async () => { calls.ai++; if (overrides.aiError) throw new AssistantError('ai_request_failed'); return result; } },
    replier: { reply: async (token, text) => { calls.replies.push({ token, text }); if (overrides.replyError) throw new AssistantError('line_reply_failed'); } },
    log: (...args) => calls.logs.push(args), ...overrides.worker });
  return { worker, job, calls };
}

test('worker publishes one bounded summary; basic commands never call AI and logs omit content/identities/credentials', async () => {
  const f = workerFixture(); await f.worker.process(f.job);
  assert.equal(f.calls.ai, 1); assert.equal(f.calls.replies.length, 1);
  assert.match(f.calls.replies[0].text, /合成角色甲/); assert.match(f.calls.replies[0].text, /M1/);
  assert.equal(f.calls.finished[0][1], 'sent');
  const logs = JSON.stringify(f.calls.logs);
  for (const value of [secret, group, owner, 'synthetic-reply-token', result.todos[0].task]) assert.equal(logs.includes(value), false);
  for (const kind of ['help','status','unsupported','rate_limited']) {
    const basic = workerFixture(kind); await basic.worker.process(basic.job);
    assert.equal(basic.calls.ai, 0); assert.equal(basic.calls.replies.length, 1);
  }
  assert.ok(renderSummary(f.job, { ...snapshot, truncated: true }, result).includes('並非完整全日摘要'));
});

test('source changes before or during generation cancel publication; LINE failures do not cause duplicate replies', async () => {
  const changed = workerFixture('summary', { store: { unchanged: async () => false } });
  await changed.worker.process(changed.job);
  assert.equal(changed.calls.ai, 0); assert.equal(changed.calls.replies.length, 0); assert.equal(changed.calls.finished[0][1], 'canceled');
  let checks = 0;
  const during = workerFixture('summary', { store: { unchanged: async () => ++checks < 2 } });
  await during.worker.process(during.job);
  assert.equal(during.calls.ai, 1); assert.equal(during.calls.replies.length, 0); assert.equal(during.calls.finished[0][1], 'canceled');
  const failed = workerFixture('summary', { replyError: true }); await failed.worker.process(failed.job);
  assert.equal(failed.calls.ai, 1); assert.equal(failed.calls.replies.length, 1); assert.equal(failed.calls.finished[0][1], 'failed');
  const expired = workerFixture(); expired.job.expires_at = new Date(Date.now() - 1).toISOString();
  await expired.worker.process(expired.job); assert.equal(expired.calls.ai, 0); assert.equal(expired.calls.replies.length, 0);
});
