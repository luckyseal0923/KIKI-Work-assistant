import {randomBytes} from 'node:crypto';
import {describeWork,renderProposal,normalizeRequest,PROPOSAL_CODE,WORK_CODE} from './work-actions.js';
import {speakerLabel} from './assistant-threads.js';
import {taipeiDay} from './assistant-command.js';
import {summarizeUsage} from './assistant-cost.js';

const code=prefix=>prefix+randomBytes(4).toString('hex').toUpperCase();
const instant=v=>new Date(v).toISOString();
export const sourceKey=r=>`${r.type||r.source_type||'message'}:${r.id||r.message_id}`;
export function mergeSources(...lists){
  const result=new Map();
  for(const row of lists.flat()){
    if(!row||typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(row.id)||!/^[0-9a-f]{64}$/u.test(row.digest)||row.type&&!['message','action'].includes(row.type))throw new Error('invalid_source_ref');
    const key=sourceKey(row);
    if(result.has(key)&&result.get(key).digest!==row.digest)throw new Error('conflicting_source_ref');
    result.set(key,{id:row.id,digest:row.digest,at:row.at?instant(row.at):null,ref:row.ref||null,...(row.type==='action'?{type:'action'}:{})});
  }
  if(result.size>101)throw new Error('too_many_source_refs');
  return [...result.values()];
}

export class WorkStore {
  constructor(pool,config){this.pool=pool;this.config=config;}
  authorized(job){return this.config.assistant.workspaceEnabled&&job.group_id===this.config.allowedGroupId&&job.operator_user_id===this.config.assistant.operatorUserId;}
  assert(job){if(!this.authorized(job))throw new Error('workspace_scope_denied');}
  jobSource(job){return job.source_kind==='action'?{type:'action',id:job.source_action_id,digest:job.source_digest,at:null}:{id:job.source_message_id,digest:job.source_digest,at:null};}
  async transaction(fn){
    const client=await this.pool.connect();let broken=false,released=false;
    const onError=()=>{broken=true;};client.on('error',onError);
    const timer=setTimeout(()=>{broken=true;released=true;client.release(true);},1800);timer.unref();
    try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
    catch(error){if(!released)try{await client.query('ROLLBACK');}catch{broken=true;}throw error;}
    finally{clearTimeout(timer);client.removeListener('error',onError);if(!released)client.release(broken);}
  }
  async sourceRows(db,sources,lock=false){
    const refs=mergeSources(sources);
    if(!refs.length)return [];
    const messageRefs=refs.filter(r=>r.type!=='action'),actionRefs=refs.filter(r=>r.type==='action');
    if(actionRefs.length&&!this.config.assistant.organizerEnabled)return null;
    const rows=[];
    if(messageRefs.length){const result=await db.query(`SELECT m.message_id,'message'::text AS source_type,left(m.message_text,2000) AS message_text,m.user_id,m.quoted_message_id,
      encode(sha256(convert_to(m.message_text,'UTF8')),'hex') AS current_digest,
      coalesce(m.sent_at,m.received_at) AS effective_at
      FROM linebot.messages m JOIN linebot.message_state s ON s.message_id=m.message_id AND s.group_id=m.group_id
      WHERE m.group_id=$1 AND m.message_id=ANY($2::text[]) AND s.unsent_at IS NULL
      ORDER BY m.message_id ${lock?'FOR UPDATE OF s':''}`,[this.config.allowedGroupId,messageRefs.map(r=>r.id)]);rows.push(...result.rows);}
    if(actionRefs.length){const result=await db.query(`SELECT event_id AS message_id,'action'::text AS source_type,command AS message_text,
      operator_user_id AS user_id,NULL::text AS quoted_message_id,received_at AS effective_at,
      encode(sha256(convert_to(command,'UTF8')),'hex') AS current_digest FROM linebot.assistant_actions
      WHERE group_id=$1 AND operator_user_id=$2 AND event_id=ANY($3::text[])`,[this.config.allowedGroupId,this.config.assistant.operatorUserId,actionRefs.map(r=>r.id)]);rows.push(...result.rows);}
    const byId=new Map(rows.map(r=>[sourceKey(r),r]));
    if(refs.some(r=>!byId.has(sourceKey(r))||byId.get(sourceKey(r)).current_digest!==r.digest||r.at&&instant(byId.get(sourceKey(r)).effective_at)!==r.at))return null;
    return rows;
  }
  async currentControl(db,job){
    const {rows}=await db.query(`SELECT 1 FROM linebot.assistant_jobs WHERE event_id=$1 AND group_id=$2
      AND operator_user_id=$3 AND status='processing' AND expires_at>clock_timestamp()`,[job.event_id,job.group_id,job.operator_user_id]);
    return rows.length===1;
  }
  async expire(){
    const scope='($3::boolean OR group_id=$1) AND operator_user_id=$2';
    // These tables belong only to KIKI; owner scope also expires pre-enrollment proposals.
    await this.pool.query(`UPDATE linebot.assistant_context SET payload='{}'::jsonb WHERE ${scope}
      AND expires_at<=clock_timestamp() AND payload<>'{}'::jsonb`,[this.config.allowedGroupId,this.config.assistant.operatorUserId,Boolean(this.config.assistant.multiGroupEnabled)]);
    await this.pool.query(`UPDATE linebot.work_proposals SET status='expired' WHERE ${scope}
      AND status='pending' AND expires_at<=clock_timestamp()`,[this.config.allowedGroupId,this.config.assistant.operatorUserId,Boolean(this.config.assistant.multiGroupEnabled)]);
  }
  async usage(job){
    this.assert(job);const today=taipeiDay(job.created_at),month=today.day.slice(0,7)+'-01T00:00:00+08:00';
    const {rows}=await this.pool.query(`SELECT CASE WHEN created_at >= $3::timestamptz THEN 'today' ELSE 'prior' END AS period,
      model_name,count(*) FILTER(WHERE input_tokens IS NOT NULL AND output_tokens IS NOT NULL)::integer AS requests,
      count(*) FILTER(WHERE input_tokens IS NULL OR output_tokens IS NULL)::integer AS incomplete,
      coalesce(sum(input_tokens),0)::bigint AS input_tokens,coalesce(sum(output_tokens),0)::bigint AS output_tokens
      FROM linebot.assistant_jobs WHERE ($5::boolean OR group_id=$1) AND operator_user_id=$2 AND created_at >= $4::timestamptz
      AND kind IN ('assist','summary','todos') AND (api_call_count IS NULL OR api_call_count>0)
      GROUP BY period,model_name`,[job.group_id,job.operator_user_id,today.start,month,Boolean(this.config.assistant.multiGroupEnabled)]);
    return summarizeUsage(rows);
  }
  async clearContext(job){this.assert(job);await this.pool.query(`UPDATE linebot.assistant_context SET payload='{}'::jsonb,expires_at=clock_timestamp()
    WHERE group_id=$1 AND operator_user_id=$2`,[job.group_id,job.operator_user_id]);}
  async saveContext(job,answer,snapshot,scope={},previousContext=null){
    this.assert(job);if(typeof answer!=='string'||answer.length>4500)return;
    const current=this.jobSource(job);
    const origin=previousContext?.origin||{...current,offset:job.request_offset};
    const requestRefs=mergeSources(previousContext?.requestRefs||[],[this.jobSource(job)]);
    if(requestRefs.length>8){await this.clearContext(job);return;}
    const payload={request_id:current.id,request_type:current.type||'message',request_digest:job.source_digest,request_offset:job.request_offset,
      answer,scope,origin,requestRefs,sourceRefs:snapshot?.sourceRefs||[],recordRefs:snapshot?.recordRefs||[],
      topicRefs:snapshot?.topicRefs||[],
      selection:{total:snapshot?.total||0,truncated:Boolean(snapshot?.truncated),totalIsLowerBound:Boolean(snapshot?.totalIsLowerBound)},
      messages:(snapshot?.messages||[]).map(m=>({ref:m.ref,length:m.text.length,id:snapshot.sourceRefs?.find(r=>r.ref===m.ref)?.id||null})),
      snapshotLabel:snapshot?.scopeLabel||null};
    if(JSON.stringify(payload).length>60000)return;
    await this.pool.query(`INSERT INTO linebot.assistant_context(group_id,operator_user_id,payload,updated_at,expires_at)
      VALUES($1,$2,$3,$4,clock_timestamp()+interval '30 minutes') ON CONFLICT(group_id,operator_user_id)
      DO UPDATE SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at
      WHERE linebot.assistant_context.updated_at<=EXCLUDED.updated_at`,[job.group_id,job.operator_user_id,JSON.stringify(payload),job.created_at]);
  }
  async readContext(job){
    this.assert(job);
    const {rows:[row]}=await this.pool.query(`SELECT payload,updated_at FROM linebot.assistant_context
      WHERE group_id=$1 AND operator_user_id=$2 AND expires_at>clock_timestamp()`,[job.group_id,job.operator_user_id]);
    if(!row?.payload?.request_id)return null;
    const p=row.payload;
    let previousProposal=null;
    if(p.scope?.proposalCode){
      const {rows:[proposal]}=await this.pool.query(`SELECT code,actions,sources FROM linebot.work_proposals WHERE code=$1 AND group_id=$2
        AND operator_user_id=$3 AND status='pending' AND expires_at>clock_timestamp()`,[p.scope.proposalCode,job.group_id,job.operator_user_id]);
      if(!proposal||!await this.sourceRows(this.pool,proposal.sources))return null;
      previousProposal=proposal;
    }
    const origin=p.origin||{id:p.request_id,digest:p.request_digest,offset:p.request_offset};
    const requestRefs=mergeSources(p.requestRefs||[],[{type:p.request_type||'message',id:p.request_id,digest:p.request_digest,at:null}],
      [{type:origin.type||'message',id:origin.id,digest:origin.digest,at:null}]);
    const rows=await this.sourceRows(this.pool,mergeSources(requestRefs,p.sourceRefs||[]));
    let valid=Boolean(rows);
    if(p.topicRefs?.length&&(!this.topics||!await this.topics.unchanged(this.pool,job,p.topicRefs)))valid=false;
    const records=[];
    for(const ref of p.recordRefs||[]){
      const {rows:[item]}=await this.pool.query('SELECT * FROM linebot.work_items WHERE code=$1 AND group_id=$2',[ref.code,job.group_id]);
      if(!item||item.version!==ref.version||!await this.sourceRows(this.pool,item.sources)){valid=false;break;}records.push(item);
    }
    if(!valid){await this.pool.query(`UPDATE linebot.assistant_context SET payload='{}'::jsonb WHERE group_id=$1 AND operator_user_id=$2 AND updated_at=$3`,[job.group_id,job.operator_user_id,row.updated_at]);return null;}
    const byId=new Map(rows.map(r=>[sourceKey(r),r]));
    const request=normalizeRequest(byId.get(sourceKey({type:p.request_type||'message',id:p.request_id})).message_text.slice(p.request_offset||0)).slice(0,2000);
    const originalRequest=normalizeRequest(byId.get(sourceKey(origin)).message_text.slice(origin.offset||0)).slice(0,2000);
    let snapshot=null;
    if(p.messages?.some(m=>m.id)){
      const selected=p.messages.filter(m=>byId.has(sourceKey(m)));const refById=new Map(selected.map(m=>[m.id,m.ref]));
      snapshot={messages:selected.map(m=>{const r=byId.get(sourceKey(m));return {ref:m.ref,at:instant(r.effective_at),text:r.message_text.slice(0,Math.min(m.length||0,4000)),speaker:speakerLabel(r.user_id,this.config),replyTo:refById.get(r.quoted_message_id)||null};}),
        sourceRefs:p.sourceRefs,ids:p.sourceRefs.map(r=>r.id),versions:p.sourceRefs.map(r=>`${r.id}:${r.digest}:${r.at}`),
        total:Math.max(selected.length,(p.selection?.total||0)-records.length),truncated:Boolean(p.selection?.truncated),totalIsLowerBound:Boolean(p.selection?.totalIsLowerBound),
        history:true,query:p.scope?.query||null,scopeLabel:p.snapshotLabel||'前次選入來源（仍保存且未變更）',readAt:new Date().toISOString()};
    }
    if(records.length)snapshot=this.appendRecords(snapshot,records);
    if(snapshot&&p.topicRefs?.length)snapshot.topicRefs=p.topicRefs;
    if(snapshot){snapshot.total=Math.max(snapshot.total,p.selection?.total||0);snapshot.truncated ||= Boolean(p.selection?.truncated);snapshot.totalIsLowerBound ||= Boolean(p.selection?.totalIsLowerBound);}
    return {originalRequest,origin,requestRefs,previousRequest:request,previousAnswer:p.answer,scope:p.scope||{},snapshot,records,previousProposal,topicRefs:p.topicRefs||[]};
  }
  async contextUnchanged(job,context){
    this.assert(job);if(!context)return true;
    if(context.topicRefs?.length&&(!this.topics||!await this.topics.unchanged(this.pool,job,context.topicRefs)))return false;
    if(!await this.sourceRows(this.pool,context.requestRefs||[]))return false;
    if(context.previousProposal){
      const {rows}=await this.pool.query(`SELECT code FROM linebot.work_proposals WHERE code=$1 AND group_id=$2 AND operator_user_id=$3
        AND status='pending' AND expires_at>clock_timestamp()`,[context.previousProposal.code,job.group_id,job.operator_user_id]);
      if(!rows.length||!await this.sourceRows(this.pool,context.previousProposal.sources))return false;
    }
    return true;
  }
  async readItems(job,{keyword=null,status='open',itemCode=null,dueOn=null,eventDate=null,kind=null,topic=null}={}){
    this.assert(job);
    if(dueOn&&!/^\d{4}-\d{2}-\d{2}$/u.test(dueOn))throw new Error('invalid_work_date');
    if(eventDate&&(!Number.isInteger(eventDate.month)||eventDate.month<1||eventDate.month>12||!Number.isInteger(eventDate.day)||eventDate.day<1||eventDate.day>31))throw new Error('invalid_work_date');
    const suffix=eventDate?`-${String(eventDate.month).padStart(2,'0')}-${String(eventDate.day).padStart(2,'0')}`:null;
    const {rows}=await this.pool.query(`SELECT * FROM linebot.work_items WHERE group_id=$1
      AND ($4::text IS NULL OR code=$4)
      AND ($4::text IS NOT NULL OR $2::text IS NULL OR ($2='open' AND body->>'status' IN ('active','in_progress')) OR body->>'status'=$2)
      AND ($4::text IS NOT NULL OR $3::text IS NULL OR strpos(lower(body::text),lower($3))>0)
      AND ($5::text IS NULL OR body->>'due_on'=$5) AND ($6::text IS NULL OR right(body->>'due_on',6)=$6)
      AND ($7::text IS NULL OR body->>'kind'=$7)
      ${this.config.assistant.organizerEnabled?"AND ($8::text IS NULL OR topic_code=$8 OR lower(body->>'topic')=ANY($9::text[]))":''}
      ORDER BY updated_at DESC,code LIMIT 21`,[job.group_id,status,keyword,itemCode,dueOn,suffix,kind,
        ...(this.config.assistant.organizerEnabled?[topic?.code||null,topic?[topic.definition.name,...topic.definition.aliases].map(v=>v.toLowerCase()):[]]:[])]);
    const selected=rows.slice(0,20);
    for(const item of selected)item.available=Boolean(await this.sourceRows(this.pool,item.sources));
    return {items:selected,total:rows.length,totalIsLowerBound:rows.length>20};
  }
  recordSnapshot(records){
    return this.appendRecords(null,records);
  }
  proposalInput(snapshot,records){
    const maximum=this.config.assistant.contextMessages||20;
    let remaining=this.config.assistant.contextCharacters||12000;
    const hasArchive=Boolean(snapshot?.sourceRefs?.length);
    const recordBudget=hasArchive?Math.floor(remaining/2):remaining;
    let recordSize=0;
    const selected=[];
    for(const record of records.filter(r=>r.available!==false)){
      const size=JSON.stringify({code:record.code,version:record.version,body:record.body}).length;
      if(selected.length>=(hasArchive?Math.max(1,Math.floor(maximum/2)):maximum)||recordSize+size>recordBudget)break;
      selected.push(record);remaining-=size;recordSize+=size;
    }
    if(!snapshot)return {records:selected,snapshot:null};
    const sources=new Map((snapshot.sourceRefs||[]).map(r=>[r.ref,r]));
    const messages=[];
    for(const message of [...snapshot.messages].reverse()){
      if(!sources.has(message.ref))continue;
      if(messages.length+selected.length>=maximum||remaining<100)break;
      let text=message.text.slice(0,remaining);if(/[\uD800-\uDBFF]$/u.test(text))text=text.slice(0,-1);
      messages.unshift({...message,text});remaining-=text.length;
    }
    const refs=new Set(messages.map(m=>m.ref));
    const sourceRefs=messages.map(m=>sources.get(m.ref));
    return {records:selected,snapshot:{...snapshot,
      messages:messages.map(m=>({...m,replyTo:refs.has(m.replyTo)?m.replyTo:null})),sourceRefs,
      ids:sourceRefs.map(r=>r.id),versions:sourceRefs.map(r=>`${r.id}:${r.digest}:${r.at}`),
      recordRefs:selected.map(r=>({code:r.code,version:r.version,available:true})),
      truncated:Boolean(snapshot.truncated)||messages.length<snapshot.messages.length||selected.length<records.length
        ||messages.some(m=>m.text.length<snapshot.messages.find(original=>original.ref===m.ref).text.length)}};
  }
  appendRecords(snapshot,records){
    const result={...(snapshot||{}),messages:[],ids:[],versions:[],sourceRefs:[],recordRefs:[],
      total:(snapshot?.total||0)+records.length,truncated:Boolean(snapshot?.truncated),history:true,
      scopeLabel:snapshot?.scopeLabel||'已確認工作紀錄',readAt:snapshot?.readAt||new Date().toISOString()};
    const maximum=this.config.assistant.contextMessages||20;
    let remaining=this.config.assistant.contextCharacters||12000,added=0;
    for(const r of records){
      if(result.messages.length>=maximum||remaining<100)break;
      const original=r.available===false?`${r.code}：來源已變更或收回，內容待重新確認。`:describeWork(r);
      let text=original.slice(0,remaining);if(/[\uD800-\uDBFF]$/u.test(text))text=text.slice(0,-1);
      result.messages.push({ref:`M${result.messages.length+1}`,at:instant(r.updated_at),speaker:'已確認工作紀錄',text});
      result.recordRefs.push({code:r.code,version:r.version,available:r.available!==false});remaining-=text.length;added++;
      result.truncated ||= text.length<original.length;
    }
    const originalRefs=new Map((snapshot?.sourceRefs||[]).map(r=>[r.ref,r]));
    const archived=(snapshot?.messages||[]).filter(m=>originalRefs.has(m.ref));
    const chosen=[];
    for(const message of [...archived].reverse()){
      if(result.messages.length+chosen.length>=maximum||remaining<100)break;
      let text=message.text.slice(0,remaining);if(/[\uD800-\uDBFF]$/u.test(text))text=text.slice(0,-1);
      chosen.push({...message,text});remaining-=text.length;result.truncated ||= text.length<message.text.length;
    }
    chosen.reverse();
    const remap=new Map(chosen.map((m,i)=>[m.ref,`M${result.messages.length+i+1}`]));
    for(const message of chosen){
      const ref=remap.get(message.ref),source={...originalRefs.get(message.ref),ref};
      result.messages.push({...message,ref,replyTo:remap.get(message.replyTo)||null});result.sourceRefs.push(source);
      result.ids.push(source.id);result.versions.push(`${source.id}:${source.digest}:${source.at}`);
    }
    result.truncated ||= added<records.length||chosen.length<archived.length;
    if(snapshot&&records.length)result.scopeLabel=(snapshot.scopeLabel||'本群已保存訊息')+'；含已確認工作紀錄';
    return result;
  }
  async unchanged(job,snapshot){
    this.assert(job);
    if(snapshot?.topicRefs?.length&&(!this.topics||!await this.topics.unchanged(this.pool,job,snapshot.topicRefs)))return false;
    if(snapshot?.workspaceSourceRefs&&!await this.sourceRows(this.pool,snapshot.workspaceSourceRefs))return false;
    for(const ref of snapshot?.recordRefs||[]){
      const {rows:[item]}=await this.pool.query('SELECT version,sources FROM linebot.work_items WHERE code=$1 AND group_id=$2',[ref.code,job.group_id]);
      if(!item||item.version!==ref.version||Boolean(await this.sourceRows(this.pool,item.sources))!==(ref.available!==false))return false;
    }
    return true;
  }
  async createProposal(job,actions,snapshot,records=[],previousProposal=null,contextSources=[]){
    this.assert(job);
    renderProposal({code:'P00000000',actions});
    const refs=new Set(actions.flatMap(a=>a.refs));
    const sources=mergeSources([this.jobSource(job)],(snapshot?.sourceRefs||[]).filter(r=>refs.has(r.ref)),
      records.filter(r=>actions.some(a=>a.target===r.code)).flatMap(r=>r.sources),previousProposal?.sources||[],contextSources);
    if(!await this.sourceRows(this.pool,sources))throw new Error('work_source_changed');
    const proposal={code:code('P'),actions};
    await this.transaction(async db=>{
      if(this.groups)await this.groups.guard(db,job,this.config);
      if(previousProposal){
        const {rows}=await db.query(`SELECT code FROM linebot.work_proposals WHERE code=$1 AND group_id=$2 AND operator_user_id=$3
          AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE`,[previousProposal.code,job.group_id,job.operator_user_id]);
        if(!rows.length)throw new Error('work_conflict');
      }
      const {rows:[saved]}=await db.query(`INSERT INTO linebot.work_proposals(code,group_id,operator_user_id,source_event_id,actions,sources,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp()+interval '10 minutes') RETURNING expires_at`,
        [proposal.code,job.group_id,job.operator_user_id,job.event_id,JSON.stringify(actions),JSON.stringify(sources)]);
      proposal.expires_at=saved.expires_at;
      if(previousProposal)await db.query("UPDATE linebot.work_proposals SET status='discarded' WHERE code=$1",[previousProposal.code]);
    });
    return {...proposal,sources};
  }
  async pending(job){this.assert(job);const {rows}=await this.pool.query(`SELECT code,actions,expires_at FROM linebot.work_proposals
    WHERE group_id=$1 AND operator_user_id=$2 AND status='pending' AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 5`,[job.group_id,job.operator_user_id]);return rows;}
  async discard(job,proposalCode){
    this.assert(job);if(!PROPOSAL_CODE.test(proposalCode))return '提案代碼格式不正確。';
    const {rows}=await this.pool.query(`UPDATE linebot.work_proposals SET status='discarded' WHERE code=$1 AND group_id=$2
      AND operator_user_id=$3 AND status='pending' RETURNING code`,[proposalCode,job.group_id,job.operator_user_id]);
    return rows.length?`已取消提案 ${proposalCode}，正式工作紀錄未變更。`:'找不到可取消的待確認提案。';
  }
  async apply(job,proposalCode){
    this.assert(job);if(!PROPOSAL_CODE.test(proposalCode))return {status:'missing'};
    return this.transaction(async db=>{
      if(this.groups)await this.groups.guard(db,job,this.config);
      const {rows:[proposal]}=await db.query(`SELECT * FROM linebot.work_proposals WHERE code=$1 AND group_id=$2 AND operator_user_id=$3 FOR UPDATE`,[proposalCode,job.group_id,job.operator_user_id]);
      if(!proposal)return {status:'missing'};
      if(proposal.status==='applied')return {status:'already_applied'};
      if(proposal.status!=='pending')return {status:proposal.status};
      if((!this.topics&&proposal.actions.some(a=>a.operation==='topic_define'||a.topic_ref))||(!this.groups&&proposal.actions.some(a=>a.operation==='group_config')))return {status:'feature_disabled'};
      if(new Date(proposal.expires_at)<=new Date()){await db.query("UPDATE linebot.work_proposals SET status='expired' WHERE code=$1",[proposalCode]);return {status:'expired'};}
      const refs=mergeSources(proposal.sources,[this.jobSource(job)]);
      if(!await this.sourceRows(db,refs,true)||!await this.currentControl(db,job)){
        await db.query("UPDATE linebot.work_proposals SET status='invalid' WHERE code=$1",[proposalCode]);return {status:'source_changed'};
      }
      await db.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kiki_work_v1'),pg_catalog.hashtext($1))",[job.group_id]);
      if(proposal.actions.some(a=>a.operation==='group_config')){
        if(!this.groups||proposal.actions.some(a=>a.operation!=='group_config'))return {status:'feature_disabled'};
        const result=await this.groups.apply(db,job,proposal,refs);
        if(result.status!=='applied'){await db.query("UPDATE linebot.work_proposals SET status='invalid' WHERE code=$1",[proposalCode]);return result;}
        await db.query("UPDATE linebot.work_proposals SET status='applied',applied_at=clock_timestamp(),confirmed_event_id=$2 WHERE code=$1",[proposalCode,job.event_id]);return result;
      }
      if(proposal.actions.some(a=>a.operation==='topic_define')){
        if(!this.topics||proposal.actions.some(a=>a.operation!=='topic_define'))return {status:'feature_disabled'};
        const result=await this.topics.apply(db,job,proposal,refs);
        if(result.status!=='applied'){await db.query("UPDATE linebot.work_proposals SET status='invalid' WHERE code=$1",[proposalCode]);return result;}
        await db.query("UPDATE linebot.work_proposals SET status='applied',applied_at=clock_timestamp(),confirmed_event_id=$2 WHERE code=$1",[proposalCode,job.event_id]);return result;
      }
      const topicRefs=proposal.actions.map(a=>a.topic_ref).filter(Boolean);
      if(topicRefs.length&&(!this.topics||!await this.topics.unchanged(db,job,topicRefs))){
        await db.query("UPDATE linebot.work_proposals SET status='invalid' WHERE code=$1",[proposalCode]);return {status:'conflict'};
      }
      const targets=proposal.actions.filter(a=>a.target).map(a=>a.target).sort();
      const {rows:existing}=await db.query('SELECT * FROM linebot.work_items WHERE group_id=$1 AND code=ANY($2::text[]) ORDER BY code FOR UPDATE',[job.group_id,targets]);
      if(proposal.actions.some(a=>a.operation==='update'&&!existing.some(r=>r.code===a.target&&r.version===a.expected_version))){
        await db.query("UPDATE linebot.work_proposals SET status='invalid' WHERE code=$1",[proposalCode]);return {status:'conflict'};
      }
      for(const action of proposal.actions.filter(a=>a.operation==='create')){
        const {rows}=await db.query('SELECT code FROM linebot.work_items WHERE group_id=$1 AND body=$2::jsonb LIMIT 1',[job.group_id,JSON.stringify(action.body)]);
        if(rows.length){await db.query("UPDATE linebot.work_proposals SET status='invalid' WHERE code=$1",[proposalCode]);return {status:'duplicate'};}
      }
      const changed=[];
      for(const [i,a] of proposal.actions.entries()){
        const old=existing.find(r=>r.code===a.target),itemCode=a.target||code('W'),version=(old?.version||0)+1;
        if(a.operation==='create')await db.query(`INSERT INTO linebot.work_items(code,group_id,version,body,sources,created_at,updated_at)
          VALUES($1,$2,1,$3,$4,clock_timestamp(),clock_timestamp())`,[itemCode,job.group_id,JSON.stringify(a.body),JSON.stringify(refs)]);
        else await db.query(`UPDATE linebot.work_items SET version=$3,body=$4,sources=$5,updated_at=clock_timestamp() WHERE code=$1 AND group_id=$2`,[itemCode,job.group_id,version,JSON.stringify(a.body),JSON.stringify(refs)]);
        if(this.config.assistant.organizerEnabled)await db.query('UPDATE linebot.work_items SET topic_code=$3 WHERE code=$1 AND group_id=$2',[itemCode,job.group_id,a.topic_ref?.code||null]);
        await db.query(`INSERT INTO linebot.work_events(proposal_code,ordinal,item_code,group_id,version,previous_body,next_body,confirmed_event_id,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,[proposalCode,i,itemCode,job.group_id,version,old?JSON.stringify(old.body):null,JSON.stringify(a.body),job.event_id]);
        changed.push({code:itemCode,version,body:a.body});
      }
      await db.query("UPDATE linebot.work_proposals SET status='applied',applied_at=clock_timestamp(),confirmed_event_id=$2 WHERE code=$1",[proposalCode,job.event_id]);
      return {status:'applied',items:changed};
    });
  }
  async history(job,itemCode){
    this.assert(job);if(!WORK_CODE.test(itemCode))return [];
    const {rows}=await this.pool.query(`SELECT e.version,e.next_body,e.created_at,p.sources,c.source_message_id,c.source_digest${this.config.assistant.organizerEnabled?',c.source_kind,c.source_action_id':''} FROM linebot.work_events e
      JOIN linebot.work_proposals p ON p.code=e.proposal_code JOIN linebot.assistant_jobs c ON c.event_id=e.confirmed_event_id
      WHERE e.group_id=$1 AND e.item_code=$2 ORDER BY e.version DESC LIMIT 10`,[job.group_id,itemCode]);
    for(const row of rows)row.available=Boolean((row.source_message_id||row.source_action_id)&&await this.sourceRows(this.pool,mergeSources(row.sources,[this.jobSource(row)])));return rows;
  }
}
