import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createHmac} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {assistantConfig,ConfigError} from '../src/config.js';
import {cardData,readCardAction,flexReply} from '../src/assistant-cards.js';
import {selectEvents} from '../src/webhook.js';
import {PgStore} from '../src/store.js';
import {AssistantStore} from '../src/assistant-store.js';
import {WorkStore,mergeSources} from '../src/work-store.js';
import {TopicStore} from '../src/topic-store.js';
import {GroupStore} from '../src/group-store.js';
import {AssistantWorker} from '../src/assistant-worker.js';
import {AssistantError,LineReplier} from '../src/assistant-clients.js';
import {auditDatabase} from '../src/database-audit.js';
import {validateWorkActions,workspaceControl} from '../src/work-actions.js';
import {failureMessage} from '../src/assistant-errors.js';
import {createServer} from '../src/server.js';

const owner='U'+'1'.repeat(32),other='U'+'2'.repeat(32),secret='synthetic-organizer-secret';
const env={ASSISTANT_ENABLED:'true',ASSISTANT_FREEFORM_ENABLED:'true',ASSISTANT_WORKSPACE_ENABLED:'true',ASSISTANT_ORGANIZER_ENABLED:'true',
  OPERATOR_USER_ID:owner,OPENAI_API_KEY:'synthetic-ai-key',LINE_CHANNEL_ACCESS_TOKEN:'synthetic-line-token'};
const group=n=>'C'+n.toString(16).padStart(32,'0');
const hash=v=>createHash('sha256').update(v).digest('hex');
const textOf=v=>typeof v==='string'?v:v.contents.body.contents[0].text;
const specsOf=v=>v.contents.footer.contents.map(b=>b.action.data);

test('cards authenticate scope, exact bytes, expiry and versions without exposing identifiers',()=>{
  const config={secret,allowedGroupId:group(1),assistant:assistantConfig(env,'record')};
  const now=Date.now(),data=cardData(config,'finish','W1234ABCD',2,now+10000);
  assert.equal(readCardAction(data,config,now).command,'完成工作 W1234ABCD 2');
  assert.ok(data.length<300);assert.ok(!data.includes(owner)&&!data.includes(config.allowedGroupId)&&!data.includes(secret));
  for(const forged of [data.replace('ABCD','ABCE'),data.replace('.2.','.3.'),data+'x'])assert.equal(readCardAction(forged,config,now),null);
  assert.equal(readCardAction(data,{...config,allowedGroupId:group(2)},now),null);
  assert.equal(readCardAction(data,{...config,assistant:{...config.assistant,operatorUserId:other}},now),null);
  assert.equal(readCardAction(data,config,now+10001),null);
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',last=data.at(-1);
  const equivalent=alphabet[alphabet.indexOf(last)+1];
  assert.equal(readCardAction(data.slice(0,-1)+equivalent,config,now),null);
  assert.throws(()=>assistantConfig({...env,ASSISTANT_MULTI_GROUP_ENABLED:'true',ASSISTANT_ORGANIZER_ENABLED:'false'},'record'),ConfigError);
});

test('LINE Flex delivery retains full preview and sends one message without leaking credentials in errors',async()=>{
  const config={secret,allowedGroupId:group(1),assistant:assistantConfig(env,'record')};
  const preview='完整變更前後\n'+'合成內容'.repeat(300),message=flexReply(config,preview,[{action:'confirm',code:'P1234ABCD'}]);
  let captured;
  const line=new LineReplier('synthetic-token',{fetchImpl:async(url,options)=>{captured={url,options};return {ok:true};}});
  await line.reply('synthetic-reply',message);
  const body=JSON.parse(captured.options.body);
  assert.equal(body.messages.length,1);assert.equal(textOf(body.messages[0]),preview);
  assert.equal(body.messages[0].contents.footer.contents[0].action.type,'postback');
  assert.match(failureMessage('invalid_ai_output',{stage:'plan'}),/尚未建立提案/);
  assert.match(failureMessage('ai_request_failed'),/手動重送/);
  assert.match(failureMessage('line_reply_failed',{applied:true}),/可能已更新/);
});

test('HTTP verifies the exact LINE signature before querying multi-group metadata',async t=>{
  let reads=0,writes=0;
  const server=createServer({config:{secret,mode:'record'},store:{save:async()=>{writes++;}},groups:{forWebhook:async()=>{reads++;return {mode:'record',allowedGroupId:group(1)};}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const raw=JSON.stringify({events:[]}),url=`http://127.0.0.1:${server.address().port}/webhook`;
  assert.equal((await fetch(url,{method:'POST',body:raw})).status,401);assert.equal(reads,0);
  const signature=createHmac('sha256',secret).update(raw).digest('base64');
  assert.equal((await fetch(url,{method:'POST',body:raw,headers:{'x-line-signature':signature}})).status,200);
  assert.equal(reads,1);assert.equal(writes,0);
});

test('organizer PostgreSQL state machines and multi-group isolation',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN;
    CREATE ROLE linebot_app NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA linebot;REVOKE ALL ON SCHEMA linebot FROM PUBLIC,anon,authenticated,service_role;GRANT USAGE ON SCHEMA linebot TO linebot_app;
    CREATE TABLE linebot.messages(message_id text PRIMARY KEY,webhook_event_id text UNIQUE,group_id text NOT NULL,user_id text,
      message_text text NOT NULL,quoted_message_id text,sent_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE linebot.messages ENABLE ROW LEVEL SECURITY;GRANT SELECT,INSERT,UPDATE,DELETE ON linebot.messages TO linebot_app;
    CREATE POLICY linebot_app_access ON linebot.messages FOR ALL TO linebot_app USING(true) WITH CHECK(true);`);
  for(const name of ['001_event_safety.sql','003_assistant_jobs.sql','004_freeform_assistant.sql','005_workspace.sql','006_cards_topics.sql','006_cards_topics.sql','002_role_login.sql']){
    await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  await db.exec('SET ROLE linebot_app;SET search_path=pg_catalog');
  const pool={query:(...args)=>db.query(...args),connect:async()=>Object.assign(new EventEmitter(),{query:(...args)=>db.query(...args),release(){}})};
  const archive=new PgStore(pool,{assistantEnabled:true});let sequence=0,groupSequence=10;
  function fixture({multi=false}={}){
    const config={mode:'record',secret,allowedGroupId:group(++groupSequence),assistant:assistantConfig({...env,ASSISTANT_MULTI_GROUP_ENABLED:String(multi)},'record')};
    config.assistant.cooldownSeconds=0;config.assistant.dailyLimit=100;
    const groups=multi?new GroupStore(pool,config):null;
    const services=scoped=>{
      const store=new AssistantStore(pool,scoped),workspace=new WorkStore(pool,scoped),topics=new TopicStore(pool,scoped,workspace);
      workspace.topics=topics;workspace.groups=groups;
      return {config:scoped,store,workspace,topics};
    };
    const base=services(config),replies=[],logs=[];
    const event=(text,{user=owner,gid=config.allowedGroupId,at=Date.now()-1000,command=false}={})=>({type:'message',timestamp:at,webhookEventId:'organizer-event-'+(++sequence),replyToken:'synthetic-reply-token',
      source:{type:'group',groupId:gid,userId:user},message:{type:'text',id:'organizer-message-'+(++sequence),text,
        ...(command?{mention:{mentionees:[{type:'user',isSelf:true,index:0,length:5}]}}:{})}});
    const save=async(...events)=>{const raw=Buffer.from(JSON.stringify({events})),routed=groups?await groups.forWebhook(raw):config;return archive.save(selectEvents(raw,routed).events);};
    const command=async(text,options={})=>{const raw=event('@KIKI '+text,{...options,command:true});await save(raw);const job=await base.store.claim();assert.ok(job,'expected queued owner control');return {raw,job};};
    const worker=(scoped,dialogue=null,replier=null)=>{const s=services(scoped);return new AssistantWorker({...s,groups,dialogue,
      summarizer:{summarize(){throw new Error('unexpected AI');}},replier:replier||{reply:async(token,value)=>{replies.push(value);}},log:(event,data)=>logs.push({event,...data})});};
    const run=async(text,options={},dialogue=null)=>{const c=await command(text,options),scoped=groups?await groups.forJob(c.job):config;assert.ok(scoped);await worker(scoped,dialogue).process(c.job);return {...c,reply:replies.at(-1),text:textOf(replies.at(-1))};};
    const click=async(data,{user=owner,gid=config.allowedGroupId}={})=>{
      const raw={type:'postback',timestamp:Date.now(),webhookEventId:'organizer-action-'+(++sequence),replyToken:'synthetic-action-reply',source:{type:'group',groupId:gid,userId:user},postback:{data}};
      const count=await save(raw);if(!count)return {raw,job:null};const job=await base.store.claim();assert.ok(job);
      const scoped=groups?await groups.forJob(job):config;assert.ok(scoped);await worker(scoped).process(job);return {raw,job,reply:replies.at(-1),text:textOf(replies.at(-1))};
    };
    const recall=async raw=>save({type:'unsend',timestamp:Date.now(),webhookEventId:'organizer-unsend-'+(++sequence),source:raw.source,unsend:{messageId:raw.message.id}});
    return {...base,groups,services,worker,event,save,command,run,click,recall,replies,logs};
  }
  const finish=(f,job)=>f.store.finish(job,'sent');
  const newWork=async(f,{topic='合成課程',gid}={})=>{
    const {raw,job}=await f.command('新增待辦：由測試角色甲負責整理教材，期限2026/11/10中午',{gid});
    const scoped=f.groups?await f.groups.forJob(job):f.config,s=f.services(scoped);
    const actions=validateWorkActions({actions:[{operation:'create',target:null,kind:'task',topic,title:'整理教材',owner:'測試角色甲',due_text:'2026/11/10中午',status:'active',refs:[]}]},
      {request:raw.message.text,createdAt:job.created_at});
    const decorated=await s.topics.decorateActions(job,actions);
    const proposal=await s.workspace.createProposal(job,decorated.actions,null,[],null,decorated.sources);await finish(f,job);return {raw,job,proposal,s};
  };

  await t.test('new migration is repeatable, audited, append-only and inaccessible to public roles',async()=>{
    const audit=await auditDatabase(db,{assistantEnabled:true,freeformEnabled:true,workspaceEnabled:true,organizerEnabled:true,multiGroupEnabled:true});assert.deepEqual(audit.issues,[]);
    for(const table of ['assistant_actions','topic_events','group_events'])await assert.rejects(db.query(`UPDATE linebot.${table} SET group_id='forged'`),/permission denied/);
    for(const table of ['assistant_actions','topics','topic_events','group_settings','group_events'])await assert.rejects(db.query(`DELETE FROM linebot.${table}`),/permission denied/);
    for(const role of ['anon','authenticated','service_role']){
      await db.exec('RESET ROLE;SET ROLE '+role);
      for(const table of ['assistant_actions','topics','group_settings'])await assert.rejects(db.query(`SELECT * FROM linebot.${table}`),/permission denied/);
    }
    await db.exec('RESET ROLE;SET ROLE linebot_app');
  });

  await t.test('authenticated buttons create immutable actions, never fake chat; repeated confirmation is idempotent',async()=>{
    const f=fixture(),created=await newWork(f),data=cardData(f.config,'confirm',created.proposal.code,0,new Date(created.proposal.expires_at).getTime());
    assert.equal((await f.click(data,{user:other})).job,null);
    const result=await f.click(data);assert.match(result.text,/工作已確認/);
    const code=result.text.match(/W[0-9A-F]{8}/u)[0];
    assert.equal((await db.query('SELECT 1 FROM linebot.messages WHERE message_id=$1',[result.raw.webhookEventId])).rows.length,0);
    assert.equal((await db.query('SELECT 1 FROM linebot.assistant_actions WHERE event_id=$1',[result.raw.webhookEventId])).rows.length,1);
    assert.equal(await f.save(result.raw),0);
    assert.match((await f.click(data)).text,/不會重複/);
    const finishData=specsOf(result.reply).find(s=>s.includes('.finish.'));
    const pending=await f.click(finishData);assert.match(pending.text,/待確認工作提案/);
    assert.equal((await db.query('SELECT version FROM linebot.work_items WHERE code=$1',[code])).rows[0].version,1);
    const confirmation=specsOf(pending.reply).find(s=>s.includes('.confirm.'));
    const done=await f.click(confirmation);assert.match(done.text,/已完成/);
    assert.equal((await db.query('SELECT version FROM linebot.work_items WHERE code=$1',[code])).rows[0].version,2);
    assert.match((await f.click(finishData)).text,/版本已改變/);
    const control=(await f.command('工作歷程 '+code)).job;assert.equal((await f.workspace.history(control,code)).length,2);await finish(f,control);
    const metrics=await db.query('SELECT api_call_count FROM linebot.assistant_jobs WHERE group_id=$1',[f.config.allowedGroupId]);assert.ok(metrics.rows.every(r=>r.api_call_count===0));
    await f.recall(created.raw);const history=(await f.command('工作歷程 '+code)).job;
    assert.ok((await f.workspace.history(history,code)).every(r=>!r.available));await finish(f,history);
  });

  await t.test('typed source IDs cannot collide across chat and button namespaces; SQL rejects malformed jobs',async()=>{
    const f=fixture(),message=f.event('同一ID的原始文字');await f.save(message);
    const data=cardData(f.config,'list'),action={type:'postback',timestamp:Date.now(),webhookEventId:message.message.id,replyToken:'synthetic-reply',source:message.source,postback:{data}};
    await f.save(action);const job=await f.store.claim();
    const refs=mergeSources([{id:message.message.id,digest:hash(message.message.text)}],[{type:'action',id:message.message.id,digest:hash('工作清單')}]);
    assert.equal(refs.length,2);assert.equal((await f.workspace.sourceRows(pool,refs)).length,2);
    await assert.rejects(db.query("UPDATE linebot.assistant_jobs SET source_kind='action',source_action_id=NULL WHERE event_id=$1",[job.event_id]),/check constraint/);
    await finish(f,job);
  });

  await t.test('topic aliases require owner confirmation, match old text, and associate work without rewriting archive',async()=>{
    const f=fixture(),old=f.event('教材準備：合成場地仍未定',{at:Date.now()-60*86400000});await f.save(old);
    const preview=await f.run('建立主題：合成課程；別名：課程籌備、教材準備');assert.match(preview.text,/尚未套用/);
    assert.equal((await db.query('SELECT 1 FROM linebot.topics WHERE group_id=$1',[f.config.allowedGroupId])).rows.length,0);
    const confirmed=await f.click(specsOf(preview.reply).find(d=>d.includes('.confirm.'))),topicCode=confirmed.text.match(/T[0-9A-F]{8}/u)[0];
    const {job}=await f.command('找過去合成課程的討論');
    const plan=await f.topics.searchPlan(job,'找過去合成課程的討論',{keyword:'合成課程',history:true});
    const snapshot=await f.store.readMessages({...job,keyword:plan.keyword,searchTerms:plan.search_terms,history:true,range_start:'1970-01-01',range_end:new Date().toISOString()});
    assert.equal(snapshot.messages.length,1);assert.match(snapshot.messages[0].text,/教材準備/);await finish(f,job);
    const created=await newWork(f,{topic:'教材準備'}),confirmation=await f.run('確認 '+created.proposal.code);
    assert.match(confirmation.text,/合成課程/);
    assert.equal((await db.query('SELECT topic_code FROM linebot.work_items WHERE group_id=$1',[f.config.allowedGroupId])).rows[0].topic_code,topicCode);
    assert.equal((await db.query('SELECT message_text FROM linebot.messages WHERE message_id=$1',[old.message.id])).rows[0].message_text,old.message.text);
    const request=(await f.command('主題 '+topicCode)).job,topic=await f.topics.find(request,'合成課程',{exact:true});
    assert.equal((await f.workspace.readItems(request,{topic})).items.length,1);await finish(f,request);
  });

  await t.test('ambiguous topics never silently merge; changed definitions invalidate context and old proposals',async()=>{
    const f=fixture();
    for(const name of ['合成主題甲','合成主題乙']){const p=await f.run(`建立主題：${name}；別名：共同別名`);await f.click(specsOf(p.reply).find(d=>d.includes('.confirm.')));}
    const {job}=await f.command('找共同別名');await assert.rejects(f.topics.find(job,'共同別名'),e=>e.code==='topic_ambiguous');await finish(f,job);
    const p1=await f.run('主題別名 合成主題甲：教材說法'),p2=await f.run('主題別名 合成主題甲：課程說法');
    await f.click(specsOf(p1.reply).find(d=>d.includes('.confirm.')));
    assert.match((await f.click(specsOf(p2.reply).find(d=>d.includes('.confirm.')))).text,/新版本/);
    const check=(await f.command('主題清單')).job,topic=await f.topics.find(check,'合成主題甲',{exact:true});
    assert.equal(await f.topics.unchanged(pool,check,[{code:topic.code,version:1}]),false);await finish(f,check);
  });

  await t.test('recalled topic definitions stop lookup; explicit fresh rebuild does not resurrect withdrawn text',async()=>{
    const f=fixture(),p=await f.run('建立主題：合成修復課程；別名：舊合成說法');
    const confirmed=await f.click(specsOf(p.reply).find(d=>d.includes('.confirm.'))),code=confirmed.text.match(/T[0-9A-F]{8}/u)[0];
    await f.recall(p.raw);let c=await f.command('主題 '+code);
    await assert.rejects(f.topics.find(c.job,code,{exact:true}),e=>e.code==='topic_source_changed');await finish(f,c.job);
    const rebuild=await f.run(`重建主題 ${code}：合成修復課程；別名：新合成說法`);
    assert.match(rebuild.text,/不再引用/);assert.ok(!rebuild.text.includes('舊合成說法'));
    assert.match((await f.click(specsOf(rebuild.reply).find(d=>d.includes('.confirm.')))).text,/主題已確認/);
    c=await f.command('主題 '+code);const topic=await f.topics.find(c.job,'新合成說法',{exact:true});
    assert.equal(topic.version,2);assert.equal(topic.sources.some(s=>s.id===p.raw.message.id),false);await finish(f,c.job);
  });

  await t.test('failure recovery differentiates model stages and never retries an applied change after failed LINE delivery',async()=>{
    const f=fixture(),c=await f.command('說明合成詞');
    await f.worker(f.config,{plan:async()=>{throw new AssistantError('invalid_ai_output');}}).process(c.job);
    assert.match(textOf(f.replies.at(-1)),/未能辨識/);assert.equal(f.logs.at(-1).stage,'plan');
    const created=await newWork(f),confirm=await f.command('確認 '+created.proposal.code);let replies=0;
    await f.worker(f.config,null,{reply:async()=>{replies++;throw new AssistantError('line_reply_failed');}}).process(confirm.job);
    assert.equal(replies,1);assert.equal(f.logs.at(-1).applied,true);
    assert.equal((await db.query('SELECT 1 FROM linebot.work_items WHERE group_id=$1',[f.config.allowedGroupId])).rows.length,1);
    assert.match((await f.run('確認 '+created.proposal.code)).text,/不會重複/);
    assert.ok(!JSON.stringify(f.logs).includes(secret)&&!JSON.stringify(f.logs).includes('synthetic-ai-key'));
  });

  await t.test('multi-group enrollment, separate archives and shared budget',async st=>{
    const f=fixture({multi:true}),g2=group(98),g3=group(97),g4=group(96);await f.groups.bootstrap();await f.groups.bootstrap();
    await st.test('unknown chat and non-owner enrollment are ignored, owner preview does not enable recording',async()=>{
      assert.equal(await f.save(f.event('未啟用一般文字',{gid:g2})),0);
      assert.equal(await f.save(f.event('@KIKI 申請啟用本群：合成第二群',{gid:g2,user:other,command:true})),0);
      const p=await f.run('申請啟用本群：合成第二群',{gid:g2});assert.match(p.text,/確認後才開始/);
      assert.equal(await f.save(f.event('確認前仍不收錄',{gid:g2})),0);
      assert.equal((await f.groups.current(p.job)),null);
      const enabled=await f.click(specsOf(p.reply).find(d=>d.includes('.confirm.')),{gid:g2});assert.match(enabled.text,/已啟用/);
      assert.equal(await f.save(f.event('第二群專屬合成文字',{gid:g2,user:other})),1);
    });
    await st.test('cards, work, topics, history and context cannot cross groups; group list stays in primary group',async()=>{
      const created=await newWork(f),confirmed=await f.run('確認 '+created.proposal.code),workCode=confirmed.text.match(/W[0-9A-F]{8}/u)[0];
      const foreign=specsOf(confirmed.reply).find(d=>d.includes('.finish.'));assert.equal((await f.click(foreign,{gid:g2})).job,null);
      const p=await f.run('建立主題：第一群主題；別名：第一群別名');const topic=await f.click(specsOf(p.reply).find(d=>d.includes('.confirm.'))),topicCode=topic.text.match(/T[0-9A-F]{8}/u)[0];
      const c=await f.command('工作清單',{gid:g2}),scoped=await f.groups.forJob(c.job),s=f.services(scoped);
      assert.equal((await s.workspace.readItems(c.job,{itemCode:workCode,status:null})).items.length,0);
      assert.equal((await s.workspace.history(c.job,workCode)).length,0);
      assert.equal(await s.topics.find(c.job,topicCode,{exact:true}),null);
      assert.equal(await s.workspace.readContext(c.job),null);await finish(f,c.job);
      const result=await f.run('群組清單',{gid:g2});assert.match(result.text,/原管理群/);assert.ok(!result.text.includes('合成第二群'));
      assert.match((await f.run('群組狀態',{gid:g2})).text,/合成第二群/);
      const archiveJob=(await f.command('查合成文字',{gid:g2})).job;
      const archive=f.services(await f.groups.forJob(archiveJob)).store;
      const snapshot=await archive.readMessages({...archiveJob,keyword:null,history:true,range_start:'1970-01-01',range_end:new Date().toISOString()});
      assert.ok(snapshot.messages.every(m=>!m.text.includes('第一群')));await finish(f,archiveJob);
    });
    await st.test('disable confirmation stops new intake, fences old snapshots, cancels queued AI and permits privacy recall',async()=>{
      const saved=f.event('停用前合成文字',{gid:g2});await f.save(saved);
      const raw=Buffer.from(JSON.stringify({events:[f.event('舊設定快照',{gid:g2})]}));
      const stale=selectEvents(raw,await f.groups.forWebhook(raw)).events;
      const queued=await f.command('說明合成問題',{gid:g2});await db.query("UPDATE linebot.assistant_jobs SET status='queued',attempt_count=0 WHERE event_id=$1",[queued.job.event_id]);
      // Keep this job from being claimed by the following controls while it is intentionally queued.
      await db.query("UPDATE linebot.assistant_jobs SET created_at=clock_timestamp()+interval '10 seconds' WHERE event_id=$1",[queued.job.event_id]);
      const p=await f.run('停用本群',{gid:g2}),disabled=await f.click(specsOf(p.reply).find(d=>d.includes('.confirm.')),{gid:g2});
      assert.match(disabled.text,/停止收錄/);assert.equal(await f.groups.forJob(queued.job),null);
      await assert.rejects(archive.save(stale),/Group settings changed/);
      assert.equal(await f.save(f.event('停用後一般文字',{gid:g2})),0);
      const dispatcher=f.worker(f.config);
      dispatcher.workerForJob=async job=>{const scoped=await f.groups.forJob(job);return scoped?f.worker(scoped):null;};
      await dispatcher.drain();
      assert.equal((await db.query('SELECT status,error_code FROM linebot.assistant_jobs WHERE event_id=$1',[queued.job.event_id])).rows[0].status,'canceled');
      await db.query("UPDATE linebot.assistant_jobs SET created_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",[queued.job.event_id]);
      // Archived messages still accept unsend even after a group is disabled.
      assert.equal(await f.recall(saved),1);
      assert.equal((await db.query('SELECT 1 FROM linebot.messages WHERE message_id=$1',[saved.message.id])).rows.length,0);
    });
    await st.test('activation limit and source withdrawal are checked before applying settings',async()=>{
      const canceled=await f.run('申請啟用本群：合成第三群',{gid:g3});await f.recall(canceled.raw);
      assert.match((await f.click(specsOf(canceled.reply).find(d=>d.includes('.confirm.')),{gid:g3})).text,/來源已修改或收回/);
      for(const [gid,label] of [[g2,'合成第二群'],[g3,'合成第三群']]){const p=await f.run('申請啟用本群：'+label,{gid});await f.click(specsOf(p.reply).find(d=>d.includes('.confirm.')),{gid});}
      const p=await f.run('申請啟用本群：合成第四群',{gid:g4});assert.match((await f.click(specsOf(p.reply).find(d=>d.includes('.confirm.')),{gid:g4})).text,/上限/);
    });
    await st.test('disabling during model planning prevents the second model call and publication',async()=>{
      const c=await f.command('合成問題：解釋工作流程',{gid:g2}),scoped=await f.groups.forJob(c.job);let answered=0;
      const initialReplies=f.replies.length,controlResults=[];
      await f.worker(scoped,{plan:async()=>{
        const p=await f.run('停用本群',{gid:g2});controlResults.push(p.text);
        const disabled=await f.click(specsOf(p.reply).find(d=>d.includes('.confirm.')),{gid:g2});controlResults.push(disabled.text);
        return {mode:'answer',keyword:null,clarification:null,source_scope:'none',search_terms:[],inputTokens:10,outputTokens:2};
      },answer:async()=>{answered++;throw new Error('must not answer after disable');}}).process(c.job);
      assert.equal(answered,0);assert.equal(f.replies.length,initialReplies+2,JSON.stringify({controlResults,logs:f.logs.slice(-5)}));
      const row=(await db.query('SELECT status,error_code,api_call_count FROM linebot.assistant_jobs WHERE event_id=$1',[c.job.event_id])).rows[0];
      assert.equal(row.status,'canceled');assert.equal(row.error_code,'group_disabled');assert.equal(row.api_call_count,1);
      const p=await f.run('申請啟用本群：合成第二群',{gid:g2});await f.click(specsOf(p.reply).find(d=>d.includes('.confirm.')),{gid:g2});
    });
    await st.test('AI limit and cooldown are shared across groups; fixed controls remain free',async()=>{
      await db.query("UPDATE linebot.assistant_jobs SET created_at=clock_timestamp()-interval '2 days' WHERE kind IN ('assist','summary','todos')");
      f.config.assistant.cooldownSeconds=30;f.config.assistant.dailyLimit=20;
      let c=await f.command('合成問題一');assert.equal(c.job.kind,'assist');await finish(f,c.job);
      c=await f.command('合成問題二',{gid:g2});assert.equal(c.job.kind,'rate_limited');assert.equal(c.job.notice_reason,'cooldown');await finish(f,c.job);
      f.config.assistant.cooldownSeconds=0;
      for(let i=1;i<20;i++){c=await f.command('合成問題'+i,{gid:i%2?g2:g3});assert.equal(c.job.kind,'assist');await finish(f,c.job);}
      c=await f.command('第二十一個合成要求',{gid:g2});assert.equal(c.job.notice_reason,'daily_limit');await finish(f,c.job);
      assert.match((await f.run('工作清單',{gid:g2})).text,/工作清單/);
      const status=await f.run('狀態',{gid:g3});assert.match(status.text,/所有群合計已接受 20 次/);
    });
    await st.test('expired caches and proposals in owned secondary groups are cleaned without deleting archives',async()=>{
      const c=await f.command('工作清單',{gid:g2}),s=f.services(await f.groups.forJob(c.job));
      await s.workspace.saveContext(c.job,'合成有限回覆',null,{mode:'answer'});await finish(f,c.job);
      await db.query("UPDATE linebot.assistant_context SET expires_at=clock_timestamp()-interval '1 second' WHERE group_id=$1",[g2]);
      const before=(await db.query('SELECT count(*)::integer AS n FROM linebot.messages WHERE group_id=$1',[g2])).rows[0].n;
      await f.workspace.expire();
      assert.deepEqual((await db.query('SELECT payload FROM linebot.assistant_context WHERE group_id=$1',[g2])).rows[0].payload,{});
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM linebot.messages WHERE group_id=$1',[g2])).rows[0].n,before);
    });
  });
});
