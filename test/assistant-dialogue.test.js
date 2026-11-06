import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantConfig, ConfigError } from '../src/config.js';
import { assistantJobForEvent, encryptReplyToken, helpText, parseCommand } from '../src/assistant-command.js';
import { OpenAIDialogue, validatePlan, validateAnswer, UNSUPPORTED_TASK } from '../src/assistant-dialogue.js';
import { AssistantWorker, renderDialogue } from '../src/assistant-worker.js';

const group = `C${'1'.repeat(32)}`, owner = `U${'2'.repeat(32)}`, secret = 'synthetic-freeform-secret';
const env = { ASSISTANT_ENABLED: 'true', ASSISTANT_FREEFORM_ENABLED: 'true', OPERATOR_USER_ID: owner,
  OPENAI_API_KEY: 'synthetic-freeform-api-key', LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-freeform-line-token' };
const config = { mode: 'record', secret, allowedGroupId: group, assistant: assistantConfig(env, 'record') };
const planFor = (mode = 'answer', extra = {}) => ({ mode, keyword: null, clarification: null, inputTokens: 10, outputTokens: 3, ...extra });
const answer = { title: '合成回覆', blocks: [{ text: '合成第一段\n合成第二段', refs: [] }], inputTokens: 20, outputTokens: 7 };
const snapshot = { messages: [{ ref: 'M1', at: new Date().toISOString(), text: '合成 OSCE：測試角色甲週五前整理教材。' }],
  ids: ['synthetic-source'], versions: ['synthetic-version'], total: 1, truncated: false, readAt: new Date().toISOString() };
function event(text = '@🧪KIKI 請把下面改成公告：合成課程明天下午兩點開始。') {
  return { type: 'message', timestamp: Date.now(), replyToken: 'synthetic-reply-token',
    source: { type: 'group', groupId: group, userId: owner }, message: { id: 'synthetic-freeform-command', type: 'text', text,
      mention: { mentionees: [{ index: 0, length: '@🧪KIKI'.length, type: 'user', isSelf: true }] } } };
}

test('natural requests require a separate valid flag, preserve fixed shortcuts and genuine owner mention boundaries', () => {
  assert.equal(assistantConfig({ ...env, ASSISTANT_FREEFORM_ENABLED: 'false' }, 'record').freeformEnabled, false);
  assert.throws(() => assistantConfig({ ...env, ASSISTANT_FREEFORM_ENABLED: 'yes' }, 'record'), ConfigError);
  assert.throws(() => assistantConfig({ ...env, ASSISTANT_ENABLED: 'false' }, 'record'), ConfigError);
  assert.equal(parseCommand('什麼是 SMART 目標').kind, 'unsupported');
  assert.equal(parseCommand('什麼是 SMART 目標', config.assistant).kind, 'assist');
  assert.equal(parseCommand('今日摘要 OSCE', config.assistant).kind, 'summary');
  assert.equal(parseCommand('今日摘要 請用條列式', config.assistant).kind, 'assist');
  assert.equal(parseCommand('', config.assistant).kind, 'help');
  const job = assistantJobForEvent(event(), config);
  assert.equal(job.kind, 'assist'); assert.equal(job.requestOffset, '@🧪KIKI'.length);
  for (const change of [e => { e.source.userId = `U${'3'.repeat(32)}`; }, e => { delete e.message.mention; },
    e => { e.source.groupId = `C${'4'.repeat(32)}`; }, e => { e.type = 'messageEdited'; }]) {
    const e = event(); change(e); assert.equal(assistantJobForEvent(e, config), null);
  }
  assert.equal(assistantJobForEvent(event('@🧪KIKI '+ '合'.repeat(8001)), config).kind, 'unsupported');
  assert.match(helpText(config), /直接交辦/);
});

test('the planner cannot invent a keyword, query period, tool mode or unbounded clarification', () => {
  const request = '請找出今天 OSCE 討論未定事項';
  assert.equal(validatePlan({ mode: 'group_today', keyword: 'OSCE', clarification: null }, request).keyword, 'OSCE');
  for (const value of [
    { mode: 'group_today', keyword: '不存在的主題', clarification: null },
    { mode: 'answer', keyword: 'OSCE', clarification: null },
    { mode: 'execute_sql', keyword: null, clarification: null },
    { mode: 'draft', keyword: null, clarification: '執行別的指令' },
    { mode: 'clarify', keyword: null, clarification: '' },
    { mode: 'answer', keyword: null, clarification: null, group_id: group },
  ]) assert.throws(() => validatePlan(value, request), /invalid_ai_output/);
});

test('planning sees only the owner request; stand-alone answers never send group context and both calls have no tools', async () => {
  const calls = [];
  const client = new OpenAIDialogue(config.assistant, { fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    const value = body.text.format.name === 'kiki_request_plan'
      ? { mode: 'draft', keyword: null, clarification: null } : { title: answer.title, blocks: answer.blocks };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 10, output_tokens: 20 } }));
  } });
  const request = '請把以下合成文字改成公告：課程明天下午兩點開始。';
  const plan = await client.plan(request, new Date().toISOString());
  const result = await client.answer(request, plan, snapshot);
  assert.match(result.blocks[0].text, /\n/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.openai.com/v1/responses');
    assert.equal(call.body.store, false); assert.deepEqual(call.body.tools, []); assert.equal(call.body.tool_choice, 'none');
    assert.equal(call.body.text.format.strict, true);
    const serialized = JSON.stringify(call.body);
    for (const value of [group, owner, env.OPENAI_API_KEY, env.LINE_CHANNEL_ACCESS_TOKEN, snapshot.messages[0].text]) {
      assert.equal(serialized.includes(value), false);
    }
  }
  const input = JSON.parse(calls[1].body.input[0].content[0].text);
  assert.deepEqual(input.messages, []); assert.equal(input.savedMessageCount, 0);
  assert.ok(calls[0].body.max_output_tokens + calls[1].body.max_output_tokens <= 3000);
});

test('answer validation keeps paragraphs and enforces source references and total output bounds', () => {
  assert.match(validateAnswer({ title: answer.title, blocks: answer.blocks }).blocks[0].text, /\n/);
  assert.throws(() => validateAnswer({ title: '合成', blocks: [{ text: '合成', refs: ['M1'] }] }), /invalid_ai_output/);
  assert.throws(() => validateAnswer({ title: '合成', blocks: [{ text: '合成', refs: [] }] }, snapshot.messages), /invalid_ai_output/);
  assert.throws(() => validateAnswer({ title: '合成', blocks: [{ text: '合成', refs: ['M999'] }] }, snapshot.messages), /invalid_ai_output/);
  assert.throws(() => validateAnswer({ title: '合成', blocks: Array.from({ length: 4 }, () => ({ text: '合'.repeat(1000), refs: [] })) }), /invalid_ai_output/);
  const result = validateAnswer({ title: '合成群組整理', blocks: [{ text: '整理教材。', refs: ['M1'] }] }, snapshot.messages);
  const text = renderDialogue({ range_start: new Date().toISOString() }, planFor('group_today'), { ...snapshot, truncated: true }, result);
  assert.match(text, /M1/); assert.match(text, /並非完整全日內容/); assert.ok(text.length <= 4500);
});

function fixture(plan = planFor(), overrides = {}) {
  const calls = { plans: 0, answers: 0, reads: 0, replies: [], finished: [], timeouts: [], logs: [] };
  let clock = Date.now();
  const job = { kind: 'assist', source_message_id: 'synthetic-command', group_id: group, operator_user_id: owner,
    request_offset: 5, range_start: new Date(clock).toISOString(), created_at: new Date(clock).toISOString(),
    expires_at: new Date(clock + 45000).toISOString(), encrypted_reply_token: encryptReplyToken('synthetic-reply-token',secret) };
  const store = { current: async () => true, unchanged: async () => true, readRequest: async () => '合成使用者要求',
    readMessages: async j => { calls.reads++; calls.keyword = j.keyword; return snapshot; },
    finish: async (...args) => calls.finished.push(args), ...overrides.store };
  const worker = new AssistantWorker({ config, store, summarizer: { summarize: async () => { throw new Error('wrong AI route'); } },
    dialogue: { plan: async (request, day, options) => { calls.plans++; calls.timeouts.push(options.timeout); clock += 5000; return plan; },
      answer: async (request, p, source, options) => { calls.answers++; calls.timeouts.push(options.timeout);
        if (overrides.answerFailure) throw new Error('synthetic-provider-failure');
        return p.mode === 'group_today' ? { ...answer, blocks: [{ text: '合成群組整理', refs: ['M1'] }] } : answer; } },
    replier: { reply: async (token,text) => calls.replies.push({ token,text }) }, now: () => clock,
    log: (...args) => calls.logs.push(args), ...overrides.worker });
  return { worker,job,calls };
}

test('stand-alone questions and drafts never query group text, share a single deadline and sum usage', async () => {
  for (const mode of ['answer','draft']) {
    const f = fixture(planFor(mode)); await f.worker.process(f.job);
    assert.equal(f.calls.reads, 0); assert.equal(f.calls.plans, 1); assert.equal(f.calls.answers, 1);
    assert.equal(f.calls.replies.length, 1); assert.equal(f.calls.finished[0][1], 'sent');
    assert.equal(f.calls.finished[0][3].inputTokens, 30); assert.equal(f.calls.finished[0][3].outputTokens, 10);
    assert.ok(f.calls.timeouts[0] <= 6000); assert.ok(f.calls.timeouts[1] <= 15000);
    const logs = JSON.stringify(f.calls.logs);
    for (const text of [group,owner,secret,'合成使用者要求','synthetic-reply-token']) assert.equal(logs.includes(text), false);
  }
});

test('group work uses the validated topic and references; missing data and unsupported or unclear tasks do not generate a second answer', async () => {
  const f = fixture(planFor('group_today',{keyword:'OSCE'})); await f.worker.process(f.job);
  assert.equal(f.calls.reads, 1); assert.equal(f.calls.keyword,'OSCE'); assert.match(f.calls.replies[0].text,/M1/);
  const empty = fixture(planFor('group_today'),{store:{readMessages:async()=>({...snapshot,messages:[],ids:[],versions:[],total:0})}});
  await empty.worker.process(empty.job); assert.equal(empty.calls.answers,0); assert.match(empty.calls.replies[0].text,/尚無符合範圍/);
  for (const mode of ['unsupported','clarify']) {
    const basic = fixture(planFor(mode,{clarification:mode==='clarify'?'請提供要改寫的原文。':null}));
    await basic.worker.process(basic.job);
    assert.equal(basic.calls.reads,0); assert.equal(basic.calls.answers,0);
    assert.equal(basic.calls.replies.length,1);
    if(mode==='unsupported') assert.equal(basic.calls.replies[0].text,UNSUPPORTED_TASK);
  }
});

test('edited or recalled instructions and sources prevent publication; a failed second call is not retried', async () => {
  for (const changedAfter of [0,1,2,3]) {
    let checks=0;
    const f=fixture(planFor('group_today'),{store:{unchanged:async()=>++checks<=changedAfter}});
    await f.worker.process(f.job);
    assert.equal(f.calls.replies.length,0); assert.equal(f.calls.finished[0][1],'canceled');
  }
  const disabled=fixture(planFor(),{worker:{config:{...config,assistant:{...config.assistant,freeformEnabled:false}}}});
  await disabled.worker.process(disabled.job); assert.equal(disabled.calls.plans,0); assert.equal(disabled.calls.replies.length,0);
  const failed=fixture(planFor(),{answerFailure:true}); await failed.worker.process(failed.job);
  assert.equal(failed.calls.plans,1); assert.equal(failed.calls.answers,1); assert.equal(failed.calls.replies.length,1);
  assert.equal(failed.calls.finished[0][1],'failed');
});
