import {randomBytes} from 'node:crypto';
import {GROUP_ID} from './config.js';
import {HttpError} from './webhook.js';
import {AssistantError} from './assistant-clients.js';

export class GroupStore {
  constructor(pool,config){this.pool=pool;this.config=config;}
  async bootstrap(){
    await this.pool.query(`INSERT INTO linebot.group_settings(code,group_id,label,operator_user_id,version,enabled,sources,created_at,updated_at)
      VALUES($1,$2,'原測試群',$3,1,true,'[]'::jsonb,clock_timestamp(),clock_timestamp()) ON CONFLICT(group_id) DO NOTHING`,
      ['G'+randomBytes(4).toString('hex').toUpperCase(),this.config.allowedGroupId,this.config.assistant.operatorUserId]);
  }
  scoped(groupId,row,{groupControl=false}={}){
    return {...this.config,allowedGroupId:groupId,enrollmentOnly:!row?.enabled,groupVersion:row?.version||null,groupControl,
      assistant:{...this.config.assistant,operatorUserId:this.config.assistant.operatorUserId}};
  }
  async forWebhook(raw){
    let body;try{body=JSON.parse(raw.toString('utf8'));}catch{throw new HttpError(400);}
    if(!Array.isArray(body?.events)||body.events.length>100)throw new HttpError(400);
    const ids=[...new Set(body.events.map(e=>e?.source?.groupId).filter(id=>typeof id==='string'&&GROUP_ID.test(id)))];
    if(!ids.length)return {...this.config,groupContexts:new Map()};
    const privacyIds=[...new Set(body.events.map(e=>e?.type==='unsend'?e.unsend?.messageId:e?.type==='messageEdited'?e.message?.id:null)
      .filter(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(id)))];
    const [settings,proposals,enrollments]=await Promise.all([
      this.pool.query('SELECT * FROM linebot.group_settings WHERE group_id=ANY($1::text[]) AND operator_user_id=$2',[ids,this.config.assistant.operatorUserId]),
      this.pool.query("SELECT code,group_id FROM linebot.work_proposals WHERE group_id=ANY($1::text[]) AND operator_user_id=$2 AND actions->0->>'operation'='group_config' AND created_at>clock_timestamp()-interval '1 day'",[ids,this.config.assistant.operatorUserId]),
      // A disabled group still accepts signed privacy events for previously archived IDs.
      // Read only state metadata for this delivery, never the full archive or other groups.
      this.pool.query('SELECT group_id,message_id AS source_message_id FROM linebot.message_state WHERE group_id=ANY($1::text[]) AND message_id=ANY($2::text[])',[ids,privacyIds])
    ]);
    const groupContexts=new Map(ids.map(id=>{
      const scoped=this.scoped(id,settings.rows.find(r=>r.group_id===id));
      scoped.enrollmentProposalCodes=new Set(proposals.rows.filter(r=>r.group_id===id).map(r=>r.code));
      scoped.enrollmentMessageIds=new Set(enrollments.rows.filter(r=>r.group_id===id).map(r=>r.source_message_id));
      return [id,scoped];
    }));
    return {...this.config,groupContexts};
  }
  async forJob(job){
    if(job.operator_user_id!==this.config.assistant.operatorUserId)return null;
    const {rows:[row]}=await this.pool.query('SELECT * FROM linebot.group_settings WHERE group_id=$1 AND operator_user_id=$2',[job.group_id,job.operator_user_id]);
    const control=['group_enroll','group_control'].includes(job.keyword)&&job.kind==='workspace';
    if(!row?.enabled&&!control)return null;
    return this.scoped(job.group_id,row,{groupControl:control});
  }
  async stillAllowed(job,config){
    if(config.groupControl)return true;
    const {rows}=await this.pool.query('SELECT 1 FROM linebot.group_settings WHERE group_id=$1 AND operator_user_id=$2 AND enabled AND version=$3',[job.group_id,job.operator_user_id,config.groupVersion]);
    return rows.length===1;
  }
  async guard(db,job,config){
    const {rows:[row]}=await db.query(`SELECT version,enabled FROM linebot.group_settings WHERE group_id=$1 AND operator_user_id=$2 ${config.groupControl?'FOR UPDATE':'FOR SHARE'}`,[job.group_id,job.operator_user_id]);
    if(!config.groupControl&&(!row?.enabled||row.version!==config.groupVersion))throw new AssistantError('group_disabled');
  }
  async prepare(job,config,control){
    if(!config.assistant.multiGroupEnabled||job.operator_user_id!==this.config.assistant.operatorUserId)throw new AssistantError('group_disabled');
    const {rows:[old]}=await this.pool.query('SELECT * FROM linebot.group_settings WHERE group_id=$1 AND operator_user_id=$2',[job.group_id,job.operator_user_id]);
    if(control.action==='group_disable'&&!old)throw new AssistantError('group_missing');
    const body={label:control.label||old.label,enabled:control.action==='group_enroll'};
    return [{operation:'group_config',target:old?.code||null,expected_version:old?.version||null,body,
      previous_body:old?{label:old.label,enabled:old.enabled}:null,refs:[]}];
  }
  async apply(db,job,proposal,sources){
    if(job.operator_user_id!==this.config.assistant.operatorUserId||proposal.actions.length!==1)return {status:'invalid'};
    const a=proposal.actions[0],b=a.body;
    if(typeof b.label!=='string'||b.label.trim().length<2||b.label.length>60||/[\x00-\x1f\x7f]/u.test(b.label)||typeof b.enabled!=='boolean')return {status:'invalid'};
    await db.query("SELECT pg_advisory_xact_lock(hashtext('kiki_group_limit_v1'),0)");
    const {rows:[old]}=await db.query('SELECT * FROM linebot.group_settings WHERE group_id=$1 FOR UPDATE',[job.group_id]);
    if(old?(old.code!==a.target||old.version!==a.expected_version||old.operator_user_id!==job.operator_user_id):a.target!==null||a.expected_version!==null)return {status:'conflict'};
    if(b.enabled&&!old?.enabled){const {rows:[n]}=await db.query('SELECT count(*)::integer AS total FROM linebot.group_settings WHERE enabled');if(n.total>=this.config.assistant.maxGroups)return {status:'group_limit'};}
    const code=old?.code||'G'+randomBytes(4).toString('hex').toUpperCase(),version=(old?.version||0)+1;
    if(old)await db.query('UPDATE linebot.group_settings SET label=$3,enabled=$4,version=$5,sources=$6,updated_at=clock_timestamp() WHERE group_id=$1 AND operator_user_id=$2',[job.group_id,job.operator_user_id,b.label,b.enabled,version,JSON.stringify(sources)]);
    else await db.query('INSERT INTO linebot.group_settings(code,group_id,label,operator_user_id,version,enabled,sources,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),clock_timestamp())',[code,job.group_id,b.label,job.operator_user_id,version,b.enabled,JSON.stringify(sources)]);
    await db.query('INSERT INTO linebot.group_events(proposal_code,group_code,group_id,version,previous_settings,next_settings,confirmed_event_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())',
      [proposal.code,code,job.group_id,version,old?JSON.stringify({label:old.label,enabled:old.enabled}):null,JSON.stringify(b),job.event_id]);
    return {status:'applied',groups:[{code,label:b.label,enabled:b.enabled,version}]};
  }
  async list(job){
    if(job.operator_user_id!==this.config.assistant.operatorUserId)throw new AssistantError('group_disabled');
    if(job.group_id!==this.config.allowedGroupId)throw new AssistantError('group_list_primary_only');
    return (await this.pool.query('SELECT code,label,enabled,version FROM linebot.group_settings WHERE operator_user_id=$1 ORDER BY created_at LIMIT 20',[job.operator_user_id])).rows;
  }
  async current(job){
    if(job.operator_user_id!==this.config.assistant.operatorUserId)throw new AssistantError('group_disabled');
    return (await this.pool.query('SELECT code,label,enabled,version FROM linebot.group_settings WHERE group_id=$1 AND operator_user_id=$2',[job.group_id,job.operator_user_id])).rows[0]||null;
  }
}
