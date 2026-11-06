import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { PgStore } from '../src/store.js';
import { AssistantStore } from '../src/assistant-store.js';
import { assistantConfig } from '../src/config.js';
import { selectEvents } from '../src/webhook.js';
import { auditDatabase } from '../src/database-audit.js';
import { decryptReplyToken } from '../src/assistant-command.js';
import { AssistantWorker } from '../src/assistant-worker.js';
import { OpenAISummarizer, LineReplier } from '../src/assistant-clients.js';
import { OpenAIDialogue } from '../src/assistant-dialogue.js';
import { resolveRequestPlan } from '../src/assistant-scope.js';

const owner = `U${'2'.repeat(32)}`, secret = 'synthetic-assistant-database-secret';
let seq = 0;
const configFor = digit => ({ mode: 'record', secret, allowedGroupId: `C${digit.repeat(32)}`,
  assistant: assistantConfig({ ASSISTANT_ENABLED: 'true', OPERATOR_USER_ID: owner,
    OPENAI_API_KEY: 'synthetic-api-key', LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-line-token' }, 'record') });
function textEvent(config, text, { command = false, at = Date.now(), messageId = `synthetic-msg-${++seq}`, eventId = `synthetic-event-${++seq}` } = {}) {
  return { type: 'message', timestamp: at, webhookEventId: eventId, replyToken: 'synthetic-reply-token',
    source: { type: 'group', groupId: config.allowedGroupId, userId: owner },
    message: { type: 'text', id: messageId, text, ...(command ? { mention: {
      mentionees: [{ type: 'user', isSelf: true, index: 0, length: 5 }] } } : {}) } };
}
const selected = (config, ...events) => selectEvents(Buffer.from(JSON.stringify({ events })), config).events;

test('assistant database integration: durable jobs, quota, retraction, source checks and RLS', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE ROLE linebot_app NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA linebot;
    REVOKE ALL ON SCHEMA linebot FROM PUBLIC,anon,authenticated,service_role;
    GRANT USAGE ON SCHEMA linebot TO linebot_app;
    CREATE TABLE linebot.messages (message_id text PRIMARY KEY,webhook_event_id text UNIQUE,
      group_id text NOT NULL,user_id text,message_text text NOT NULL,quoted_message_id text,
      sent_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE linebot.messages ENABLE ROW LEVEL SECURITY;
    GRANT SELECT,INSERT,UPDATE,DELETE ON linebot.messages TO linebot_app;
    CREATE POLICY linebot_app_access ON linebot.messages FOR ALL TO linebot_app USING(true) WITH CHECK(true);`);
  for (const name of ['001_event_safety.sql','003_assistant_jobs.sql','003_assistant_jobs.sql','002_role_login.sql']) {
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  await db.exec('SET ROLE linebot_app; SET search_path=pg_catalog');
  const pool = { query: (...args) => db.query(...args), connect: async () => Object.assign(new EventEmitter(), {
    query: (...args) => db.query(...args), release() {},
  }) };
  const archive = new PgStore(pool, { assistantEnabled: true });
  const config = configFor('1'), queue = new AssistantStore(pool, config);
  const jobRows = async messageId => (await db.query('SELECT * FROM linebot.assistant_jobs WHERE source_message_id=$1', [messageId])).rows;

  await t.test('assistant-enabled audit checks new table, RLS and dedicated role permissions', async () => {
    assert.equal((await auditDatabase(db, { assistantEnabled: true })).ok, true);
    await db.exec('RESET ROLE; ALTER TABLE linebot.assistant_jobs DISABLE ROW LEVEL SECURITY; SET ROLE linebot_app');
    assert.ok((await auditDatabase(db, { assistantEnabled: true })).issues.includes('table_permissions:assistant_jobs'));
    await db.exec('RESET ROLE; ALTER TABLE linebot.assistant_jobs ENABLE ROW LEVEL SECURITY; SET ROLE linebot_app');
  });

  await t.test('archive and encrypted job commit together, duplicates do not recreate or reclaim a job', async () => {
    const raw = textEvent(config, '@KIKI 今日摘要', { command: true });
    const events = selected(config, raw);
    assert.equal(await archive.save(events), 1);
    assert.equal(await archive.save(events), 0);
    const [stored] = await jobRows(raw.message.id);
    assert.equal(stored.kind, 'summary'); assert.equal(stored.status, 'queued');
    assert.equal(stored.encrypted_reply_token.includes('synthetic-reply-token'), false);
    assert.equal(decryptReplyToken(stored.encrypted_reply_token, secret), 'synthetic-reply-token');
    const claimed = await queue.claim(); assert.equal(claimed.event_id, raw.webhookEventId);
    assert.equal(claimed.attempt_count, 1); assert.equal(await queue.claim(), null);
    assert.equal(await queue.current(claimed), true);
    await queue.finish(claimed, 'sent');
    assert.equal((await jobRows(raw.message.id))[0].encrypted_reply_token, null);
    assert.equal(await archive.save(selected(config, { ...raw, webhookEventId: `synthetic-new-event-${++seq}` })), 1);
    assert.equal((await jobRows(raw.message.id)).length, 1); assert.equal(await queue.claim(), null);
  });

  await t.test('job insertion failure rolls back both message and receipt', async () => {
    const raw = textEvent(config, '@KIKI 幫助', { command: true });
    const [item] = selected(config, raw); item.assistantJob.encryptedReplyToken = null;
    await assert.rejects(archive.save([item]));
    assert.equal((await db.query('SELECT 1 FROM linebot.messages WHERE message_id=$1', [raw.message.id])).rows.length, 0);
    assert.equal((await db.query('SELECT 1 FROM linebot.webhook_events WHERE webhook_event_id=$1', [raw.webhookEventId])).rows.length, 0);
  });

  await t.test('snapshots stay in the allowed day/group/topic, exclude commands, and detect edited or unsent content', async () => {
    const c = configFor('4'), q = new AssistantStore(pool, c);
    const normal = textEvent(c, '合成 OSCE：合成角色甲週五前整理教材。');
    const previous = textEvent(c, '合成 OSCE：昨天內容', { at: Date.now() - 86400000 });
    await archive.save(selected(c, normal, previous));
    await archive.save(selected(config, textEvent(config, '合成 OSCE：其他群組內容')));
    const command = textEvent(c, '@KIKI 今日摘要 OSCE', { command: true });
    await archive.save(selected(c, command));
    const job = await q.claim(); const snapshot = await q.readMessages(job);
    assert.equal(snapshot.total, 1); assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.messages[0].text, normal.message.text);
    assert.equal(await q.unchanged(job, snapshot), true);
    await archive.save(selected(c, { ...normal, type: 'messageEdited', timestamp: Date.now() + 1,
      webhookEventId: `synthetic-edit-${++seq}`, message: { ...normal.message, text: '合成 OSCE：修改後內容' } }));
    assert.equal(await q.unchanged(job, snapshot), false);
    await archive.save(selected(c, { type: 'unsend', timestamp: Date.now(), webhookEventId: `synthetic-unsend-${++seq}`,
      source: normal.source, unsend: { messageId: normal.message.id } }));
    assert.equal((await q.readMessages(job)).messages.length, 0);
    await q.finish(job, 'canceled', 'source_changed');
  });

  await t.test('daily limit and cooldown are durable across separate store instances', async () => {
    for (const [digit, dailyLimit, expectedReason] of [['5',1,'daily_limit'],['6',20,'cooldown']]) {
      const c = configFor(digit); c.assistant.dailyLimit = dailyLimit;
      const first = textEvent(c, '@KIKI 今日摘要', { command: true });
      await archive.save(selected(c, first));
      const q = new AssistantStore(pool, c); await q.finish(await q.claim(), 'sent');
      const second = textEvent(c, '@KIKI 今日待辦', { command: true });
      await archive.save(selected(c, second));
      const job = await new AssistantStore(pool, c).claim();
      assert.equal(job.kind, 'rate_limited'); assert.equal(job.notice_reason, expectedReason);
      await q.finish(job, 'sent');
    }
  });

  await t.test('long histories are explicitly partial, bounded, and never split an emoji surrogate pair', async () => {
    const c = configFor('9'), q = new AssistantStore(pool, c);
    const longText = '🧪'.repeat(1500) + '合成X';
    await archive.save(selected(c, ...Array.from({ length: 30 }, () => textEvent(c, longText))));
    const command = textEvent(c, '@KIKI 今日摘要', { command: true });
    await archive.save(selected(c, command));
    const job = await q.claim(), snapshot = await q.readMessages(job);
    assert.equal(snapshot.total, 30); assert.equal(snapshot.truncated, true);
    assert.ok(snapshot.messages.length < 30);
    assert.ok(snapshot.messages.reduce((n,m) => n + m.text.length, 0) <= 22000);
    assert.ok(snapshot.messages.every(m => !/[\uD800-\uDBFF]$/u.test(m.text)));
    assert.equal(await q.unchanged(job, snapshot), true);
    await q.finish(job, 'sent');
  });

  await t.test('complete archive-to-worker-to-mocked-APIs flow executes once and clears the encrypted token', async () => {
    const c = configFor('a'), q = new AssistantStore(pool, c), requests = [];
    await archive.save(selected(c, textEvent(c, '合成角色甲負責整理教材，週五前完成。')));
    const command = textEvent(c, '@KIKI 今日摘要', { command: true });
    await archive.save(selected(c, command));
    const worker = new AssistantWorker({ config: c, store: q,
      summarizer: new OpenAISummarizer(c.assistant, { fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify({ summary: [{ text: '安排教材整理。', refs: ['M1'] }],
            decisions: [], todos: [{ task: '整理教材', owner: '合成角色甲', due: '週五前', refs: ['M1'] }] }) }] }],
          usage: { input_tokens: 30, output_tokens: 40 } }));
      } }), replier: new LineReplier('synthetic-line-token', { fetchImpl: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) }); return new Response('{}');
      } }) });
    await worker.drain();
    const [job] = await jobRows(command.message.id);
    assert.equal(job.status, 'sent'); assert.equal(job.encrypted_reply_token, null);
    assert.equal(job.attempt_count, 1); assert.equal(job.message_count, 1); assert.equal(job.input_tokens, 30);
    assert.equal(requests.length, 2); assert.match(requests[1].body.messages[0].text, /合成角色甲/);
    assert.equal(requests[1].body.replyToken, 'synthetic-reply-token');
    await archive.save(selected(c, command)); await worker.drain(); assert.equal(requests.length, 2);
  });

  await t.test('recalling or editing a queued command cancels it and clears the token; replay cannot resurrect it', async () => {
    const c = configFor('7'), q = new AssistantStore(pool, c);
    for (const kind of ['unsend','messageEdited']) {
      const raw = textEvent(c, '@KIKI 幫助', { command: true });
      await archive.save(selected(c, raw));
      const changed = kind === 'unsend'
        ? { type: kind, timestamp: Date.now(), source: raw.source, unsend: { messageId: raw.message.id } }
        : { ...raw, type: kind, timestamp: Date.now()+1, message: { ...raw.message, text: '合成：取消要求' } };
      changed.webhookEventId = `synthetic-change-${++seq}`;
      await archive.save(selected(c, changed));
      const [job] = await jobRows(raw.message.id);
      assert.equal(job.status, 'canceled'); assert.equal(job.encrypted_reply_token, null);
      if (kind === 'unsend') await archive.save(selected(c, { ...raw, webhookEventId: `synthetic-replay-${++seq}` }));
      assert.equal(await q.claim(), null);
    }
  });

  await t.test('expired work loses its token and cannot be claimed; other roles cannot read the ledger', async () => {
    const c = configFor('8'), q = new AssistantStore(pool, c), raw = textEvent(c, '@KIKI 幫助', { command: true });
    await archive.save(selected(c, raw));
    await db.query(`UPDATE linebot.assistant_jobs SET created_at=clock_timestamp()-interval '2 minutes',
      expires_at=clock_timestamp()-interval '1 minute' WHERE source_message_id=$1`, [raw.message.id]);
    await q.expire(); const [job] = await jobRows(raw.message.id);
    assert.equal(job.status, 'expired'); assert.equal(job.encrypted_reply_token, null); assert.equal(await q.claim(), null);
    for (const role of ['anon','authenticated','service_role']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT encrypted_reply_token FROM linebot.assistant_jobs'), /permission denied/);
    }
    await db.exec('RESET ROLE; SET ROLE linebot_app');
  });

  await t.test('freeform stays gated until migration 004; the upgrade is repeatable without new role privileges', async () => {
    await assert.rejects(auditDatabase(db,{assistantEnabled:true,freeformEnabled:true}),/request_offset|column/);
    await db.exec('RESET ROLE');
    const migration=await readFile(new URL('../migrations/004_freeform_assistant.sql',import.meta.url),'utf8');
    await db.exec(migration); await db.exec(migration);
    await db.exec('SET ROLE linebot_app; SET search_path=pg_catalog');
    const audit=await auditDatabase(db,{assistantEnabled:true,freeformEnabled:true});
    assert.equal(audit.ok,true); assert.deepEqual(audit.memberships,[]); assert.deepEqual(audit.writableSchemas,[]);
  });

  await t.test('freeform reads the authenticated request at its UTF-16 offset and editing cancels it', async () => {
    const c=configFor('b'); c.assistant.freeformEnabled=true;
    const q=new AssistantStore(pool,c), request='請把以下合成文字改成公告：合成課程明天下午兩點開始。';
    const mention='@🧪KIKI';
    const raw=textEvent(c,mention+' '+request,{command:true});
    raw.message.mention.mentionees[0].length=mention.length;
    await archive.save(selected(c,raw)); const job=await q.claim();
    assert.equal(job.kind,'assist'); assert.equal(job.request_offset,mention.length);
    assert.equal(await q.readRequest(job),request);
    assert.equal(Object.values(job).some(v=>typeof v==='string'&&v.includes(request)),false);
    await archive.save(selected(c,{...raw,type:'messageEdited',timestamp:Date.now()+1,
      webhookEventId:`synthetic-free-edit-${++seq}`,message:{...raw.message,text:'合成：取消改寫'}}));
    assert.equal(await q.readRequest(job),null);
    assert.equal((await jobRows(raw.message.id))[0].encrypted_reply_token,null);
    assert.equal((await jobRows(raw.message.id))[0].status,'canceled');
  });

  await t.test('freeform and fixed summaries share the same durable daily limit and status count', async () => {
    const c=configFor('c'); c.assistant.freeformEnabled=true; c.assistant.dailyLimit=1;
    const q=new AssistantStore(pool,c);
    await archive.save(selected(c,textEvent(c,'@KIKI 什麼是合成測試？',{command:true})));
    const first=await q.claim(); assert.equal(first.kind,'assist'); await q.finish(first,'sent');
    assert.equal((await q.status(first)).used,1);
    await archive.save(selected(c,textEvent(c,'@KIKI 今日摘要',{command:true})));
    const limited=await q.claim(); assert.equal(limited.kind,'rate_limited');
    assert.equal(limited.notice_reason,'daily_limit'); assert.equal(limited.request_offset,null);
    await q.finish(limited,'sent');
  });

  await t.test('history retrieval finds older saved event dates, excludes other groups, commands and recalled sources', async () => {
    const c=configFor('e'); c.assistant.freeformEnabled=true;
    const q=new AssistantStore(pool,c);
    const older=textEvent(c,'合成歷史：11/10 07:00 和測試角色聚餐。',{at:Date.now()-3*86400000});
    const chinese=textEvent(c,'合成歷史：11月10日 15:00 教學測試。',{at:Date.now()-2*86400000});
    await archive.save(selected(c,older,chinese,textEvent(c,'合成其他：11/06 23:00 測試。'),textEvent(c,'合成其他：11/100 不是真日期。')));
    await archive.save(selected(config,textEvent(config,'合成其他群：11/10 07:00。')));
    const raw=textEvent(c,'@KIKI 11/10 我有什麼行程',{command:true}); await archive.save(selected(c,raw));
    const job=await q.claim(), p=resolveRequestPlan({mode:'unsupported',keyword:null,clarification:null},'11/10 我有什麼行程',job);
    const query={...job,history:p.history,eventDate:p.eventDate,keyword:p.keyword,range_start:p.sourceStart,range_end:p.sourceEnd,scopeLabel:p.scopeLabel};
    const result=await q.readMessages(query);
    assert.equal(result.total,2); assert.equal(result.totalIsLowerBound,false); assert.equal(result.truncated,false);
    assert.equal(result.messages[0].text,older.message.text); assert.equal(result.messages[1].text,chinese.message.text);
    await archive.save(selected(c,{type:'unsend',timestamp:Date.now(),webhookEventId:`synthetic-history-unsend-${++seq}`,source:older.source,unsend:{messageId:older.message.id}}));
    assert.equal(await q.unchanged(job,result),false); assert.equal((await q.readMessages(query)).total,1);
    await q.finish(job,'sent');
  });

  await t.test('large historical searches return only the latest bounded subset and label the count as a lower bound', async () => {
    const c=configFor('f'); c.assistant.freeformEnabled=true; const q=new AssistantStore(pool,c);
    const records=Array.from({length:105},(_,i)=>textEvent(c,`合成歷史檢索 ${i}`,{at:Date.now()-86400000-i*1000}));
    for(let offset=0;offset<records.length;offset+=35) await archive.save(selected(c,...records.slice(offset,offset+35)));
    const raw=textEvent(c,'@KIKI 找出過去合成歷史檢索',{command:true}); await archive.save(selected(c,raw)); const job=await q.claim();
    const result=await q.readMessages({...job,history:true,keyword:'合成歷史檢索',range_start:'1970-01-01T00:00:00Z',range_end:job.created_at});
    assert.equal(result.messages.length,100); assert.equal(result.total,101); assert.equal(result.totalIsLowerBound,true); assert.equal(result.truncated,true);
    assert.equal(result.messages.some(m=>m.text==='合成歷史檢索 104'),false); await q.finish(job,'sent');
  });

  await t.test('real durable freeform pipeline uses two bounded mocked API calls, no history, one LINE reply and no replay', async () => {
    const c=configFor('d'); c.assistant.freeformEnabled=true;
    const q=new AssistantStore(pool,c), requests=[];
    q.readMessages=async()=>{throw new Error('stand-alone draft must not read group history');};
    const raw=textEvent(c,'@KIKI 請改寫這段合成公告：合成課程明天下午兩點開始。',{command:true});
    await archive.save(selected(c,raw));
    const worker=new AssistantWorker({config:c,store:q,dialogue:new OpenAIDialogue(c.assistant,{fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body); requests.push({url,body});
      const value=body.text.format.name==='kiki_request_plan'
        ?{mode:'draft',keyword:null,clarification:null}
        :{title:'合成公告草稿',blocks:[{text:'合成課程將於明日下午兩點開始，敬請準時參與。',refs:[]}]};
      return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',
        content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:10,output_tokens:5}}));
    }}),replier:new LineReplier('synthetic-line-token',{fetchImpl:async(url,options)=>{
      requests.push({url,body:JSON.parse(options.body)}); return new Response('{}');
    }})});
    await worker.drain(); const [job]=await jobRows(raw.message.id);
    assert.equal(job.status,'sent'); assert.equal(job.attempt_count,1); assert.equal(job.encrypted_reply_token,null);
    assert.equal(job.message_count,0); assert.equal(job.input_tokens,20); assert.equal(job.output_tokens,10);
    assert.equal(requests.length,3); assert.match(requests[2].body.messages[0].text,/公告草稿/);
    assert.deepEqual(JSON.parse(requests[1].body.input[0].content[0].text).messages,[]);
    await archive.save(selected(c,raw)); await worker.drain(); assert.equal(requests.length,3);
  });
});
