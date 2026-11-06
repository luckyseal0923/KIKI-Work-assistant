import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {createHash} from 'node:crypto';
import {assistantConfig,ConfigError} from '../src/config.js';
import {assistantJobForEvent} from '../src/assistant-command.js';
import {PgStore} from '../src/store.js';
import {selectEvents} from '../src/webhook.js';
import {AssistantStore} from '../src/assistant-store.js';
import {WorkStore} from '../src/work-store.js';
import {AssistantWorker} from '../src/assistant-worker.js';
import {OpenAIDialogue,validatePlan} from '../src/assistant-dialogue.js';
import {auditDatabase} from '../src/database-audit.js';
import {normalizeWorkDate,validateWorkActions,workspaceControl,fastFollowup,renderProposal,workQueryDate} from '../src/work-actions.js';
import {estimateModelCost,summarizeUsage} from '../src/assistant-cost.js';

const owner='U'+'1'.repeat(32),other='U'+'2'.repeat(32),third='U'+'3'.repeat(32),secret='synthetic-workspace-secret';
const env={ASSISTANT_ENABLED:'true',ASSISTANT_FREEFORM_ENABLED:'true',ASSISTANT_WORKSPACE_ENABLED:'true',OPERATOR_USER_ID:owner,OPENAI_API_KEY:'synthetic-ai-key',LINE_CHANNEL_ACCESS_TOKEN:'synthetic-line-token'};
const plan=(mode,extra={})=>({mode,keyword:null,clarification:null,source_scope:'none',search_terms:[],...extra});
const rawAction=(extra={})=>({operation:'create',target:null,kind:'task',topic:'合成課程',title:'整理教材',owner:'測試角色甲',due_text:'明天中午',status:'active',refs:[],...extra});
const hash=v=>createHash('sha256').update(v).digest('hex');

test('workspace flag, controls, date grounding, immutable update dates and preview bounds',()=>{
  const a=assistantConfig(env,'record');assert.equal(a.workspaceEnabled,true);assert.equal(a.contextMessages,20);
  assert.throws(()=>assistantConfig({...env,ASSISTANT_FREEFORM_ENABLED:'false'},'record'),ConfigError);
  assert.throws(()=>assistantConfig({...env,ASSISTANT_WORKSPACE_ENABLED:'yes'},'record'),ConfigError);
  assert.equal(workspaceControl('有哪些工作未完成？').action,'list');assert.equal(workspaceControl('確認 P1234ABCD').action,'confirm');
  assert.equal(workspaceControl('確認其他人的提案'),null);
  const date=normalizeWorkDate('明天中午','2026-11-06T16:10:00Z');assert.equal(date.due_at,'2026-11-08T04:00:00.000Z');
  assert.equal(normalizeWorkDate('2026/11/10 下午3點','2026-11-07').due_at,'2026-11-10T07:00:00.000Z');
  assert.equal(normalizeWorkDate('週五前','2026-11-07').due_at,null);
  assert.equal(normalizeWorkDate('2026/02/31','2026-11-07').due_on,null);
  assert.equal(workQueryDate('明天有哪些待辦','2026-11-07T02:00:00Z'),'2026-11-08');
  const previous={code:'W1234ABCD',version:2,body:{...rawAction(),due_on:'2026-11-08',due_at:'2026-11-08T04:00:00.000Z',date_note:'合成來源'}};
  const action=validateWorkActions({actions:[rawAction({operation:'update',target:previous.code,status:'done'})]},
    {records:[previous],request:'完成 W1234ABCD',createdAt:'2026-12-01T00:00:00Z'})[0];
  assert.equal(action.body.due_at,previous.body.due_at);assert.equal(action.expected_version,2);
  assert.match(renderProposal({code:'P1234ABCD',actions:[action]}),/變更前/);
  assert.throws(()=>validateWorkActions({actions:[rawAction({owner:'沒有來源的人'})]}, {request:'新增待辦整理教材，明天中午',createdAt:new Date()}));
  assert.throws(()=>validateWorkActions({actions:[rawAction({owner:'管理者'})]}, {request:'幫我記：明天中午整理教材',createdAt:new Date()}));
  assert.equal(validateWorkActions({actions:[rawAction({owner:'管理者'})]}, {request:'由我負責明天中午整理教材',createdAt:new Date()})[0].body.owner,'管理者');
  assert.throws(()=>renderProposal({code:'P1234ABCD',actions:Array.from({length:3},()=>({...action,body:{...action.body,title:'字'.repeat(1500)}}))}));
  assert.equal(estimateModelCost('gpt-6-luna',1764,285),0.0003189);
  assert.equal(estimateModelCost('unknown',1,1),null);
  const usage=summarizeUsage([{period:'today',model_name:'gpt-6-luna',requests:1,incomplete:0,input_tokens:1764,output_tokens:285}]);
  assert.equal(usage.today.usd,0.0003189);
});

test('workspace schemas bound expanded search terms and reject forged query capabilities',()=>{
  assert.deepEqual(validatePlan(plan('group_history',{keyword:'OSCE',search_terms:['臨床技能']}),'找過去 OSCE',{workspaceEnabled:true}).search_terms,['臨床技能']);
  for(const value of [plan('answer',{search_terms:['OSCE']}),plan('group_history',{search_terms:['工作']}),plan('work_query',{source_scope:'history'})]){
    assert.throws(()=>validatePlan(value,'合成問題',{workspaceEnabled:true}));
  }
});

test('proposal input shares one source budget between complete work records and archive excerpts',()=>{
  const store=new WorkStore(null,{assistant:{contextMessages:5,contextCharacters:2000}});
  const records=Array.from({length:20},(_,i)=>({code:'W'+i.toString(16).padStart(8,'0'),version:1,
    body:{title:'合成'.repeat(250),status:'active'},available:true}));
  const messages=Array.from({length:20},(_,i)=>({ref:'M'+(i+1),text:'資料'.repeat(500),replyTo:i?'M'+i:null}));
  const sourceRefs=messages.map((m,i)=>({id:'source-'+i,ref:m.ref,digest:hash(m.text),at:'2026-11-07T00:00:00.000Z'}));
  const result=store.proposalInput({messages,sourceRefs,total:20,recordRefs:[]},records);
  const size=result.records.reduce((sum,r)=>sum+JSON.stringify({code:r.code,version:r.version,body:r.body}).length,0)
    +result.snapshot.messages.reduce((sum,m)=>sum+m.text.length,0);
  assert.ok(size<=2000);assert.ok(result.records.length+result.snapshot.messages.length<=5);
  assert.equal(result.records[0],records[0]);assert.equal(result.snapshot.truncated,true);
  const refs=new Set(result.snapshot.messages.map(m=>m.ref));
  assert.ok(result.snapshot.messages.every(m=>!m.replyTo||refs.has(m.replyTo)));
});

test('workspace database, bounded conversation, quoted replies and confirmation state machine',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN;
    CREATE ROLE linebot_app NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE SCHEMA linebot;REVOKE ALL ON SCHEMA linebot FROM PUBLIC,anon,authenticated,service_role;GRANT USAGE ON SCHEMA linebot TO linebot_app;
    CREATE TABLE linebot.messages(message_id text PRIMARY KEY,webhook_event_id text UNIQUE,group_id text NOT NULL,user_id text,
      message_text text NOT NULL,quoted_message_id text,sent_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE linebot.messages ENABLE ROW LEVEL SECURITY;GRANT SELECT,INSERT,UPDATE,DELETE ON linebot.messages TO linebot_app;
    CREATE POLICY linebot_app_access ON linebot.messages FOR ALL TO linebot_app USING(true) WITH CHECK(true);`);
  for(const name of ['001_event_safety.sql','003_assistant_jobs.sql','004_freeform_assistant.sql','005_workspace.sql','005_workspace.sql','002_role_login.sql']){
    await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  await db.exec('SET ROLE linebot_app;SET search_path=pg_catalog');
  const pool={query:(...args)=>db.query(...args),connect:async()=>Object.assign(new EventEmitter(),{query:(...args)=>db.query(...args),release(){}})};
  const archive=new PgStore(pool,{assistantEnabled:true});let sequence=0,groupSequence=0;
  function fixture(){
    const config={mode:'record',secret,allowedGroupId:'C'+(++groupSequence).toString(16).padStart(32,'0'),assistant:assistantConfig(env,'record')};
    config.assistant.cooldownSeconds=0;config.assistant.dailyLimit=100;
    const store=new AssistantStore(pool,config),workspace=new WorkStore(pool,config);
    const event=(text,{user=owner,quote=null,at=Date.now()-1000,command=false}={})=>({type:'message',timestamp:at,webhookEventId:'synthetic-event-'+(++sequence),replyToken:'synthetic-reply-token',
      source:{type:'group',groupId:config.allowedGroupId,userId:user},message:{type:'text',id:'synthetic-message-'+(++sequence),text,...(quote?{quotedMessageId:quote}:{}),
        ...(command?{mention:{mentionees:[{type:'user',isSelf:true,index:0,length:5}]}}:{})}});
    const save=async(...events)=>archive.save(selectEvents(Buffer.from(JSON.stringify({events})),config).events);
    const command=async text=>{const raw=event('@KIKI '+text,{command:true});await save(raw);const job=await store.claim();assert.ok(job);return {raw,job};};
    const recall=async raw=>save({type:'unsend',timestamp:Date.now(),webhookEventId:'synthetic-unsend-'+(++sequence),source:raw.source,unsend:{messageId:raw.message.id}});
    return {config,store,workspace,event,save,command,recall};
  }
  const finish=async(f,job)=>f.store.finish(job,'sent');
  const create=async(f,request='新增待辦：測試角色甲明天中午整理教材')=>{
    const {job,raw}=await f.command(request);
    const actions=validateWorkActions({actions:[rawAction()]},{request,createdAt:job.created_at});
    const proposal=await f.workspace.createProposal(job,actions,null);await finish(f,job);return {job,raw,proposal};
  };

  await t.test('migration repeats safely; new ledger is append-only and unauthorized roles cannot read it',async()=>{
    const audit=await auditDatabase(db,{assistantEnabled:true,freeformEnabled:true,workspaceEnabled:true});assert.equal(audit.ok,true);
    await assert.rejects(db.query('UPDATE linebot.work_events SET version=99'),/permission denied/);
    await assert.rejects(db.query('DELETE FROM linebot.work_items'),/permission denied/);
    for(const role of ['anon','authenticated','service_role']){await db.exec('RESET ROLE;SET ROLE '+role);await assert.rejects(db.query('SELECT * FROM linebot.assistant_context'),/permission denied/);}
    await db.exec('RESET ROLE;SET ROLE linebot_app');
  });

  await t.test('proposal creates no official item; explicit owner confirmation applies once and records its history',async()=>{
    const f=fixture(),{proposal}=await create(f);
    assert.equal((await f.workspace.readItems({group_id:f.config.allowedGroupId,operator_user_id:owner})).items.length,0);
    const {job}=await f.command('確認 '+proposal.code);assert.equal(job.kind,'workspace');
    const applied=await f.workspace.apply(job,proposal.code);assert.equal(applied.status,'applied');assert.equal(applied.items.length,1);
    assert.equal((await f.workspace.apply(job,proposal.code)).status,'already_applied');
    assert.equal((await f.workspace.history(job,applied.items[0].code)).length,1);await finish(f,job);
    const wrong={...job,operator_user_id:other};await assert.rejects(f.workspace.apply(wrong,proposal.code));
  });

  await t.test('source recall prevents confirmation; expired and discarded proposals cannot be applied',async()=>{
    for(const reason of ['recalled','expired','discarded']){
      const f=fixture(),created=await create(f);const {job}=await f.command('確認 '+created.proposal.code);
      if(reason==='recalled')await f.recall(created.raw);
      if(reason==='expired')await db.query("UPDATE linebot.work_proposals SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '20 minutes' WHERE code=$1",[created.proposal.code]);
      if(reason==='discarded')await f.workspace.discard(job,created.proposal.code);
      const result=await f.workspace.apply(job,created.proposal.code);
      assert.notEqual(result.status,'applied');assert.equal((await f.workspace.readItems(job)).items.length,0);await finish(f,job);
    }
  });

  await t.test('updates preserve deadlines, increment versions and reject stale competing proposals atomically',async()=>{
    const f=fixture(),created=await create(f);const confirmation=await f.command('確認 '+created.proposal.code);
    const first=await f.workspace.apply(confirmation.job,created.proposal.code);await finish(f,confirmation.job);
    const item=(await f.workspace.readItems(confirmation.job)).items[0];
    const a=await f.command('把 '+item.code+' 標成完成'),bodies=validateWorkActions({actions:[rawAction({operation:'update',target:item.code,status:'done'})]}, {records:[item],request:'標成完成',createdAt:a.job.created_at});
    const p1=await f.workspace.createProposal(a.job,bodies,null,[item]);await finish(f,a.job);
    const b=await f.command('把 '+item.code+' 取消'),cancel=validateWorkActions({actions:[rawAction({operation:'update',target:item.code,status:'canceled'})]}, {records:[item],request:'取消',createdAt:b.job.created_at});
    const p2=await f.workspace.createProposal(b.job,cancel,null,[item]);await finish(f,b.job);
    const ca=await f.command('確認 '+p1.code);assert.equal((await f.workspace.apply(ca.job,p1.code)).status,'applied');await finish(f,ca.job);
    const cb=await f.command('確認 '+p2.code);assert.equal((await f.workspace.apply(cb.job,p2.code)).status,'conflict');await finish(f,cb.job);
    const current=(await f.workspace.readItems(cb.job,{itemCode:first.items[0].code,status:null})).items[0];
    assert.equal(current.version,2);assert.equal(current.body.status,'done');assert.equal(current.body.due_at,item.body.due_at);
  });

  await t.test('the same fully specified work body is not silently duplicated',async()=>{
    const f=fixture(),one=await create(f),confirm=await f.command('確認 '+one.proposal.code);
    assert.equal((await f.workspace.apply(confirm.job,one.proposal.code)).status,'applied');await finish(f,confirm.job);
    const two=await create(f),again=await f.command('確認 '+two.proposal.code);
    assert.equal((await f.workspace.apply(again.job,two.proposal.code)).status,'duplicate');await finish(f,again.job);
  });

  await t.test('quoted short replies retain separate real speakers without sending their identifiers',async()=>{
    const f=fixture(),a=f.event('合成 THREAD-01：下午2點可以',{user:other,at:Date.now()-5000});
    const b=f.event('我不行，3點可以',{user:third,quote:a.message.id,at:Date.now()-4000});
    const c=f.event('那我也改3點',{user:other,quote:b.message.id,at:Date.now()-3000});await f.save(a,b,c);
    const {job}=await f.command('找 THREAD-01 的意見');
    const snapshot=await f.store.readMessages({...job,keyword:'THREAD-01',history:true,range_start:'1970-01-01T00:00:00Z',range_end:job.created_at});
    assert.equal(snapshot.messages.length,3);assert.equal(snapshot.messages[1].replyTo,'M1');assert.equal(snapshot.messages[2].replyTo,'M2');
    assert.equal(snapshot.messages[0].speaker,snapshot.messages[2].speaker);assert.notEqual(snapshot.messages[0].speaker,snapshot.messages[1].speaker);
    for(const id of [owner,other,third])assert.equal(JSON.stringify(snapshot.messages).includes(id),false);
    await finish(f,job);
  });

  await t.test('older stronger matches outrank newer generic matches and only a small bounded selection reaches AI',async()=>{
    const f=fixture();f.config.assistant.contextMessages=5;f.config.assistant.contextCharacters=2000;
    const older=f.event('合成 OSCE 教學 評量 決議',{at:Date.now()-60*86400000});await f.save(older);
    for(let i=0;i<12;i++)await f.save(f.event('合成 OSCE 一般紀錄 '+i));
    const {job}=await f.command('找過去 OSCE 教學評量的決議');
    const snap=await f.store.readMessages({...job,history:true,keyword:'OSCE',searchTerms:['教學','評量'],range_start:'1970-01-01T00:00:00Z',range_end:job.created_at});
    assert.equal(snap.messages.length,5);assert.ok(snap.messages.some(m=>m.text===older.message.text));assert.equal(snap.truncated,true);
    assert.ok(snap.messages.reduce((sum,m)=>sum+m.text.length,0)<=2000);await finish(f,job);
  });

  await t.test('context expires and recalled sources invalidate it; reset leaves original archive and work intact',async()=>{
    const f=fixture(),raw=f.event('合成 CONTEXT-01：測試來源');await f.save(raw);
    const {job}=await f.command('找 CONTEXT-01');const snap=await f.store.readMessages({...job,keyword:'CONTEXT-01',history:true,range_start:'1970-01-01T00:00:00Z',range_end:job.created_at});
    await f.workspace.saveContext(job,'合成前一份回覆',snap,{mode:'group_history',query:snap.query});
    assert.ok(await f.workspace.readContext(job));await f.recall(raw);assert.equal(await f.workspace.readContext(job),null);
    await f.workspace.saveContext(job,'合成短期回覆',null,{mode:'answer'});
    await db.query("UPDATE linebot.assistant_context SET expires_at=clock_timestamp()-interval '1 second' WHERE group_id=$1",[job.group_id]);
    await f.workspace.expire();assert.equal(await f.workspace.readContext(job),null);
    await f.workspace.clearContext(job);assert.equal((await db.query('SELECT 1 FROM linebot.messages WHERE message_id=$1',[job.source_message_id])).rows.length,1);await finish(f,job);
  });

  await t.test('explicit earlier follow-up reuses the prior search window and finds older archived records',async()=>{
    const f=fixture();f.config.assistant.contextMessages=5;
    for(let i=0;i<9;i++)await f.save(f.event('合成 EARLIER-01 '+i,{at:Date.now()-i*86400000-5000}));
    const {job}=await f.command('找 EARLIER-01');const snap=await f.store.readMessages({...job,history:true,keyword:'EARLIER-01',range_start:'1970-01-01T00:00:00Z',range_end:job.created_at});
    await f.workspace.saveContext(job,'合成已選入內容',snap,{mode:'group_history',query:snap.query});const context=await f.workspace.readContext(job);
    const next=fastFollowup('再找更早的',context);assert.ok(next.inheritedQuery);
    const older=await f.store.readMessages({...job,...next.inheritedQuery});
    assert.equal(older.messages.length,4);assert.ok(older.messages.every(m=>new Date(m.at)<new Date(next.inheritedQuery.range_end)));await finish(f,job);
  });

  await t.test('a remembered rewrite uses one mock API call; confirmation and listing use none',async()=>{
    const f=fixture(),calls=[],replies=[];
    const dialogue=new OpenAIDialogue(f.config.assistant,{fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body);calls.push(body);
      const value=body.text.format.name==='kiki_request_plan'?plan('draft'):{title:'合成草稿',blocks:[{text:'合成精簡回覆',refs:[]}]};
      return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:20,output_tokens:10}}));
    }});
    const worker=new AssistantWorker({config:f.config,store:f.store,workspace:f.workspace,dialogue,replier:{reply:async(token,text)=>replies.push(text)}});
    const first=await f.command('把下面改成公告：合成課程');await worker.process(first.job);assert.equal(calls.length,2);
    const second=await f.command('再短一點');await worker.process(second.job);assert.equal(calls.length,3);
    const input=JSON.parse(calls[2].input[0].content[0].text);assert.ok(input.conversation.previousAnswer);assert.deepEqual(input.messages,[]);
    const list=await f.command('工作清單');await worker.process(list.job);assert.equal(calls.length,3);assert.match(replies.at(-1),/沒有已確認/);
    const {rows:[metrics]}=await db.query('SELECT model_name,api_call_count FROM linebot.assistant_jobs WHERE event_id=$1',[second.job.event_id]);
    assert.equal(metrics.model_name,'gpt-6-luna');assert.equal(metrics.api_call_count,1);
  });

  await t.test('worker creates only a proposal, then applies an actual confirmation without another model call',async()=>{
    const f=fixture(),calls=[],replies=[];
    const dialogue=new OpenAIDialogue(f.config.assistant,{fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body);calls.push(body);
      const input=JSON.parse(body.input[0].content[0].text);
      const value=body.text.format.name==='kiki_request_plan'?plan('work_propose'):
        input.existing_records?.length?{actions:[rawAction({operation:'update',target:input.existing_records[0].code,status:'done'})]}:{actions:[rawAction()]};
      return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:30,output_tokens:20}}));
    }});
    const worker=new AssistantWorker({config:f.config,store:f.store,workspace:f.workspace,dialogue,replier:{reply:async(token,text)=>replies.push(text)}});
    const initial=await f.command('新增待辦：測試角色甲明天中午整理教材');await worker.process(initial.job);
    assert.equal(calls.length,2);assert.match(replies.at(-1),/尚未寫入正式/);
    const {rows:[proposal]}=await db.query('SELECT code FROM linebot.work_proposals WHERE source_event_id=$1',[initial.job.event_id]);assert.ok(proposal);
    assert.equal((await f.workspace.readItems(initial.job)).items.length,0);
    const confirm=await f.command('確認 '+proposal.code);await worker.process(confirm.job);
    assert.equal(calls.length,2);assert.match(replies.at(-1),/工作已確認/);
    const item=(await f.workspace.readItems(confirm.job)).items[0];assert.equal(item.body.owner,'測試角色甲');
    const metrics=(await db.query('SELECT status,api_call_count,encrypted_reply_token FROM linebot.assistant_jobs WHERE event_id=$1',[confirm.job.event_id])).rows[0];
    assert.equal(metrics.status,'sent');assert.equal(metrics.api_call_count,0);assert.equal(metrics.encrypted_reply_token,null);
    const usage=await f.workspace.usage(confirm.job);assert.equal(usage.today.input,60);assert.equal(usage.today.output,40);assert.equal(usage.today.unpriced,0);
    const change=await f.command('這件事完成了');await worker.process(change.job);assert.equal(calls.length,3);
    assert.equal((await f.workspace.readItems(change.job,{itemCode:item.code,status:null})).items[0].body.status,'active');
    const pending=await f.workspace.pending(change.job);assert.equal(pending.length,1);
    const final=await f.command('確認 '+pending[0].code);await worker.process(final.job);assert.equal(calls.length,3);
    const updated=(await f.workspace.readItems(final.job,{itemCode:item.code,status:null})).items[0];
    assert.equal(updated.body.status,'done');assert.equal(updated.version,2);assert.equal(updated.body.due_at,item.body.due_at);
    for(const call of calls){const text=JSON.stringify(call);for(const value of [owner,other,f.config.allowedGroupId,secret,env.OPENAI_API_KEY])assert.equal(text.includes(value),false);}
  });

  await t.test('replacing a pending proposal invalidates the old confirmation code',async()=>{
    const f=fixture(),first=await create(f);
    await f.workspace.saveContext(first.job,'合成前次待確認提案',null,{mode:'work_propose',proposalCode:first.proposal.code});
    const change=await f.command('把剛才那件改成後天中午'),context=await f.workspace.readContext(change.job);assert.ok(context.previousProposal);
    const actions=validateWorkActions({actions:[rawAction({due_text:'後天中午'})]}, {request:'把剛才那件改成後天中午',createdAt:change.job.created_at,context});
    const next=await f.workspace.createProposal(change.job,actions,null,[],context.previousProposal);await finish(f,change.job);
    const confirm=await f.command('確認 '+first.proposal.code);assert.equal((await f.workspace.apply(confirm.job,first.proposal.code)).status,'discarded');await finish(f,confirm.job);
    const correct=await f.command('確認 '+next.code);assert.equal((await f.workspace.apply(correct.job,next.code)).status,'applied');await finish(f,correct.job);
    assert.equal((await f.workspace.readItems(correct.job)).items[0].body.due_text,'後天中午');
  });

  await t.test('a failed second model call is not retried or reported as complete metered usage',async()=>{
    const f=fixture();let calls=0;const replies=[];
    const dialogue=new OpenAIDialogue(f.config.assistant,{fetchImpl:async()=>{
      calls++;if(calls===2)return new Response('{}',{status:429});
      return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(plan('answer'))}]}],usage:{input_tokens:20,output_tokens:10}}));
    }});
    const worker=new AssistantWorker({config:f.config,store:f.store,workspace:f.workspace,dialogue,replier:{reply:async(token,text)=>replies.push(text)}});
    const {job}=await f.command('什麼是合成資料');await worker.process(job);assert.equal(calls,2);assert.equal(replies.length,1);
    const row=(await db.query('SELECT status,input_tokens,output_tokens,api_call_count FROM linebot.assistant_jobs WHERE event_id=$1',[job.event_id])).rows[0];
    assert.equal(row.status,'failed');assert.equal(row.input_tokens,null);assert.equal(row.output_tokens,null);assert.equal(row.api_call_count,2);
    assert.equal((await f.workspace.usage(job)).today.unpriced,1);
  });

  await t.test('date lookup finds normalized formal events, prioritizes cancellations and keeps context provenance',async()=>{
    const f=fixture();
    const original=await f.command('新增行程：明天下午3點合成課程');
    const actions=validateWorkActions({actions:[rawAction({kind:'event',title:'合成課程',owner:null,due_text:'明天下午3點'})]}, {request:'新增行程：明天下午3點合成課程',createdAt:original.job.created_at});
    const proposal=await f.workspace.createProposal(original.job,actions,null);await finish(f,original.job);
    const confirmed=await f.command('確認 '+proposal.code),applied=await f.workspace.apply(confirmed.job,proposal.code);await finish(f,confirmed.job);
    const date=actions[0].body.due_on,month=Number(date.slice(5,7)),day=Number(date.slice(8));
    const query=await f.command(`${month}/${day} 我有什麼行程`),calls=[],replies=[];
    const dialogue=new OpenAIDialogue(f.config.assistant,{fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body);calls.push(body);const value=body.text.format.name==='kiki_request_plan'?plan('group_history'):{title:'合成行程',blocks:[{text:'已確認的合成課程安排。',refs:['M1']}]};
      return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:20,output_tokens:10}}));
    }});
    const worker=new AssistantWorker({config:f.config,store:f.store,workspace:f.workspace,dialogue,replier:{reply:async(token,text)=>replies.push(text)}});
    await worker.process(query.job);assert.equal(calls.length,2);assert.match(replies[0],/合成行程/);
    const input=JSON.parse(calls[1].input[0].content[0].text);assert.equal(input.messages[0].speaker,'已確認工作紀錄');assert.match(input.messages[0].text,/合成課程/);
    const memory=await f.workspace.readContext(query.job);assert.equal(memory.snapshot.recordRefs[0].code,applied.items[0].code);
    const item=(await f.workspace.readItems(query.job,{itemCode:applied.items[0].code,status:null})).items[0];
    const cancellation=await f.command('取消 '+item.code),cancelActions=validateWorkActions({actions:[rawAction({operation:'update',target:item.code,kind:'event',title:'合成課程',owner:null,due_text:'明天下午3點',status:'canceled'})]}, {records:[item],request:'取消 '+item.code,createdAt:cancellation.job.created_at});
    const cancelProposal=await f.workspace.createProposal(cancellation.job,cancelActions,null,[item]);await finish(f,cancellation.job);
    const cancelConfirm=await f.command('確認 '+cancelProposal.code);await f.workspace.apply(cancelConfirm.job,cancelProposal.code);await finish(f,cancelConfirm.job);
    const canceled=(await f.workspace.readItems(cancelConfirm.job,{status:null,eventDate:{month,day},kind:'event'})).items;
    assert.equal(canceled[0].body.status,'canceled');
    const snapshot=f.workspace.appendRecords({messages:Array.from({length:20},(_,i)=>({ref:'M'+(i+1),text:'合成舊文字',at:new Date().toISOString()})),sourceRefs:[],ids:[],versions:[],total:20,scopeLabel:'本群歷史'},canceled);
    assert.match(snapshot.messages[0].text,/已取消/);assert.equal(snapshot.recordRefs[0].version,2);
    await f.recall(cancelConfirm.raw);
    const history=await f.workspace.history(cancelConfirm.job,item.code);assert.equal(history[0].available,false);
  });
});
