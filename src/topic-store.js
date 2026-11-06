import {randomBytes} from 'node:crypto';
import {validateTopicDefinition,TOPIC_CODE} from './topic-actions.js';
import {AssistantError} from './assistant-clients.js';

export class TopicStore {
  constructor(pool,config,workspace){this.pool=pool;this.config=config;this.workspace=workspace;}
  assert(job){this.workspace.assert(job);if(!this.config.assistant.organizerEnabled)throw new Error('organizer_disabled');}
  async available(topic,db=this.pool){if(!await this.workspace.sourceRows(db,topic.sources))throw new AssistantError('topic_source_changed');return topic;}
  async list(job){
    this.assert(job);const {rows}=await this.pool.query('SELECT * FROM linebot.topics WHERE group_id=$1 ORDER BY updated_at DESC,code LIMIT 21',[job.group_id]);
    for(const row of rows.slice(0,20))row.available=Boolean(await this.workspace.sourceRows(this.pool,row.sources));
    return {topics:rows.slice(0,20),partial:rows.length>20};
  }
  async find(job,value,{exact=false}={}){
    this.assert(job);const codes=exact?[]:[...new Set(value.match(/\bT[0-9A-F]{8}\b/giu)||[])];
    if(codes.length>1)throw new AssistantError('topic_ambiguous');
    const code=TOPIC_CODE.test(value.toUpperCase())?value.toUpperCase():codes[0]?.toUpperCase()||null;
    const {rows}=await this.pool.query(`SELECT * FROM linebot.topics WHERE group_id=$1 AND
      (($3::text IS NOT NULL AND code=$3) OR ($3::text IS NULL AND
       (CASE WHEN $4 THEN lower(definition->>'name')=lower($2) ELSE strpos(lower($2),lower(definition->>'name'))>0 END
        OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(definition->'aliases') a(alias)
          WHERE CASE WHEN $4 THEN lower(alias)=lower($2) ELSE strpos(lower($2),lower(alias))>0 END))))
      ORDER BY code LIMIT 3`,[job.group_id,value,code,exact]);
    if(rows.length>1)throw new AssistantError('topic_ambiguous');
    return rows.length?this.available(rows[0]):null;
  }
  async prepare(job,control){
    this.assert(job);let old=null,definition=control.definition;
    if(control.rebuild){
      const {rows:[row]}=await this.pool.query('SELECT * FROM linebot.topics WHERE code=$1 AND group_id=$2',[control.target,job.group_id]);
      if(!row)throw new AssistantError('topic_missing');
      if(await this.workspace.sourceRows(this.pool,row.sources))throw new AssistantError('topic_exists');
      old=row;
    }else if(control.target){old=await this.find(job,control.target,{exact:true});if(!old)throw new AssistantError('topic_missing');definition=validateTopicDefinition(old.definition.name,definition.aliases);}
    else if(await this.find(job,definition.name,{exact:true}))throw new AssistantError('topic_exists');
    return {actions:[{operation:'topic_define',target:old?.code||null,expected_version:old?.version||null,body:definition,
      previous_body:control.rebuild?null:old?.definition||null,...(control.rebuild?{rebuild:true}:{}),refs:[]}],sources:control.rebuild?[]:old?.sources||[]};
  }
  async apply(db,job,proposal,sources){
    this.assert(job);if(proposal.actions.length!==1)return {status:'invalid'};
    const action=proposal.actions[0];
    const definition=validateTopicDefinition(action.body.name,action.body.aliases);
    const code=action.target||'T'+randomBytes(4).toString('hex').toUpperCase();
    let old=null;
    if(action.target){
      const {rows:[row]}=await db.query('SELECT * FROM linebot.topics WHERE code=$1 AND group_id=$2 FOR UPDATE',[code,job.group_id]);
      if(!row||row.version!==action.expected_version||!action.rebuild&&row.definition.name!==definition.name)return {status:'conflict'};
      if(action.rebuild&&await this.workspace.sourceRows(db,row.sources))return {status:'conflict'};old=row;
    }
    const {rows:duplicates}=await db.query("SELECT code FROM linebot.topics WHERE group_id=$1 AND lower(definition->>'name')=lower($2) AND code<>$3",[job.group_id,definition.name,code]);
    if(duplicates.length)return {status:'duplicate'};
    const version=(old?.version||0)+1;
    if(old)await db.query('UPDATE linebot.topics SET version=$3,definition=$4,sources=$5,updated_at=clock_timestamp() WHERE code=$1 AND group_id=$2',[code,job.group_id,version,JSON.stringify(definition),JSON.stringify(sources)]);
    else await db.query('INSERT INTO linebot.topics(code,group_id,version,definition,sources,created_at,updated_at) VALUES($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp())',[code,job.group_id,version,JSON.stringify(definition),JSON.stringify(sources)]);
    await db.query('INSERT INTO linebot.topic_events(proposal_code,topic_code,group_id,version,previous_definition,next_definition,confirmed_event_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())',
      [proposal.code,code,job.group_id,version,old&&!action.rebuild?JSON.stringify(old.definition):null,JSON.stringify(definition),job.event_id]);
    return {status:'applied',topics:[{code,version,definition}]};
  }
  async searchPlan(job,request,plan){
    if(plan.inheritedQuery||plan.keyword&&/^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+$/iu.test(plan.keyword))return plan;
    const topic=await this.find(job,request);if(!topic)return plan;
    return {...plan,keyword:topic.definition.name,search_terms:topic.definition.aliases,topicRef:{code:topic.code,version:topic.version}};
  }
  async decorateActions(job,actions){
    const sources=[];const result=[];
    for(const action of actions){
      const topic=await this.find(job,action.body.topic,{exact:true});
      if(!topic){result.push(action);continue;}
      sources.push(...topic.sources);
      result.push({...action,body:{...action.body,topic:topic.definition.name},topic_ref:{code:topic.code,version:topic.version}});
    }
    return {actions:result,sources};
  }
  async unchanged(db,job,refs){
    this.assert(job);
    for(const ref of refs){
      const {rows:[topic]}=await db.query('SELECT * FROM linebot.topics WHERE code=$1 AND group_id=$2',[ref.code,job.group_id]);
      if(!topic||topic.version!==ref.version||!await this.workspace.sourceRows(db,topic.sources))return false;
    }
    return true;
  }
}
