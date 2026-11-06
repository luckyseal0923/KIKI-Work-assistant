import { createHash } from 'node:crypto';
import { taipeiDay } from './assistant-command.js';
import { eventDatePattern } from './assistant-scope.js';
import {speakerLabel,selectThreadRows} from './assistant-threads.js';

export const budgetKey=event=>event.assistantJob.quotaScope==='shared'?'shared-budget':event.groupId;
export async function lockAssistantBudget(client,key){
  await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kiki_assistant_v1'),pg_catalog.hashtext($1))",[key]);
}
export async function enqueueAssistantJob(client, event) {
  const job = event.assistantJob;
  // persistEvents acquires budget locks before message locks for the entire batch.
  const shared=job.quotaScope==='shared';
  await lockAssistantBudget(client,budgetKey(event));
  let kind = job.kind, reason = null;
  if (['summary', 'todos', 'assist'].includes(kind)) {
    const { rows: [budget] } = await client.query(`SELECT count(*)::integer AS used,
        coalesce(bool_or(created_at > $4::timestamptz - ($5::integer * interval '1 second')),false) AS cooling
      FROM linebot.assistant_jobs WHERE ($1::text IS NULL OR group_id=$1) AND created_at >= $2 AND created_at < $3
        AND kind IN ('summary','todos','assist')`,
    [shared?null:event.groupId, job.quotaStart, job.quotaEnd, job.createdAt, job.cooldownSeconds]);
    if (budget.used >= job.dailyLimit) { kind = 'rate_limited'; reason = 'daily_limit'; }
    else if (budget.cooling) { kind = 'rate_limited'; reason = 'cooldown'; }
  }
  // Keep fixed commands deployable against migration 003 while freeform is off.
  const extended = ['assist','workspace'].includes(kind);
  const action=job.sourceKind==='action';
  await client.query(`INSERT INTO linebot.assistant_jobs
    (event_id,source_message_id,group_id,operator_user_id,source_digest,kind,keyword,notice_reason,
     range_start,range_end,created_at,expires_at,encrypted_reply_token${extended ? ',request_offset' : ''}${action?',source_kind,source_action_id':''})
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${extended ? ',$14' : ''}${action?",'action',$15":''}) ON CONFLICT DO NOTHING`,
  [event.eventId, action?null:event.messageId, event.groupId, job.operatorUserId, job.sourceDigest,
    kind, job.keyword, reason, job.rangeStart, job.rangeEnd, job.createdAt, job.expiresAt, job.encryptedReplyToken,
    ...(extended ? [job.requestOffset] : []),...(action?[event.eventId]:[])]);
}

export async function cancelAssistantJobs(client, messageId, groupId) {
  await client.query(`UPDATE linebot.assistant_jobs SET status='canceled',encrypted_reply_token=NULL,
      finished_at=clock_timestamp(),error_code='source_changed'
    WHERE source_message_id=$1 AND group_id=$2 AND status IN ('queued','processing')`, [messageId, groupId]);
}

function sourceVersion(row) {
  return `${row.message_id}:${row.digest}:${new Date(row.effective_at).toISOString()}`;
}

export class AssistantStore {
  constructor(pool, config) { this.pool = pool; this.config = config; }

  async expire() {
    await this.pool.query(`UPDATE linebot.assistant_jobs SET status='expired',encrypted_reply_token=NULL,
        finished_at=clock_timestamp(),error_code='expired'
      WHERE status IN ('queued','processing') AND expires_at <= clock_timestamp()`);
  }

  async claim() {
    const { rows } = await this.pool.query(`WITH next_job AS (
      SELECT event_id FROM linebot.assistant_jobs WHERE status='queued'
        AND expires_at > clock_timestamp() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE linebot.assistant_jobs j SET status='processing',attempt_count=1,started_at=clock_timestamp()
      FROM next_job n WHERE j.event_id=n.event_id AND j.status='queued' RETURNING j.*`);
    return rows[0] || null;
  }

  async current(job) {
    if (job.kind === 'assist' && !this.config.assistant.freeformEnabled) return false;
    if(job.kind==='workspace'&&!this.config.assistant.workspaceEnabled)return false;
    if (job.group_id !== this.config.allowedGroupId || job.operator_user_id !== this.config.assistant.operatorUserId) return false;
    if(job.source_kind==='action'){
      if(!this.config.assistant.organizerEnabled||job.kind!=='workspace')return false;
      const {rows}=await this.pool.query(`SELECT a.command FROM linebot.assistant_jobs j JOIN linebot.assistant_actions a
        ON a.event_id=j.source_action_id AND a.group_id=j.group_id AND a.operator_user_id=j.operator_user_id
        WHERE j.event_id=$1 AND j.status='processing' AND j.expires_at>clock_timestamp()`,[job.event_id]);
      return rows.length===1&&createHash('sha256').update(rows[0].command).digest('hex')===job.source_digest;
    }
    const { rows } = await this.pool.query(`SELECT m.message_text
      FROM linebot.assistant_jobs j JOIN linebot.messages m
        ON m.message_id=j.source_message_id AND m.group_id=j.group_id
      JOIN linebot.message_state s ON s.message_id=m.message_id AND s.group_id=m.group_id
      WHERE j.event_id=$1 AND j.status='processing' AND j.expires_at > clock_timestamp()
        AND s.unsent_at IS NULL`, [job.event_id]);
    return rows.length === 1 && createHash('sha256').update(rows[0].message_text).digest('hex') === job.source_digest;
  }

  async readRequest(job) {
    if(job.source_kind==='action'){
      if(!await this.current(job))return null;
      const {rows:[row]}=await this.pool.query('SELECT command FROM linebot.assistant_actions WHERE event_id=$1 AND group_id=$2 AND operator_user_id=$3',[job.source_action_id,job.group_id,job.operator_user_id]);
      return row?.command||null;
    }
    if (!['assist','workspace'].includes(job.kind) || !Number.isInteger(job.request_offset) || job.request_offset < 1 ||
        job.request_offset > 8000 || !await this.current(job)) return null;
    const { rows } = await this.pool.query(`SELECT m.message_text FROM linebot.messages m
      JOIN linebot.message_state s ON s.message_id=m.message_id AND s.group_id=m.group_id
      WHERE m.message_id=$1 AND m.group_id=$2 AND s.unsent_at IS NULL`, [job.source_message_id, job.group_id]);
    const text = rows[0]?.message_text;
    if (typeof text !== 'string' || text.length > 8000 || job.request_offset >= text.length ||
        createHash('sha256').update(text).digest('hex') !== job.source_digest) return null;
    return text.slice(job.request_offset).trim() || null;
  }

  async readMessages(job) {
    if(job.group_id!==this.config.allowedGroupId)throw new Error('group_scope_denied');
    const searchTerms=this.config.assistant.workspaceEnabled?(job.searchTerms||[]):[];
    if(!Array.isArray(searchTerms)||searchTerms.length>4||searchTerms.some(t=>typeof t!=='string'||t.length<2||t.length>30))throw new Error('invalid_search_terms');
    const rank=this.config.assistant.workspaceEnabled&&!job.chronological
      ?`(CASE WHEN $4::text IS NOT NULL AND strpos(lower(m.message_text),lower($4))>0 THEN 2 ELSE 0 END
        + (SELECT count(*)*2 FROM unnest($7::text[]) AS search(term) WHERE strpos(lower(m.message_text),lower(term))>0)) DESC,`:'';
    const { rows } = await this.pool.query(`SELECT m.message_id,m.user_id,m.quoted_message_id,left(m.message_text,2000) AS text,
        char_length(m.message_text)>2000 AS text_truncated,
        encode(sha256(convert_to(m.message_text,'UTF8')),'hex') AS digest,
        coalesce(m.sent_at,m.received_at) AS effective_at${job.history ? '' : ',count(*) OVER()::integer AS total_count'}
      FROM linebot.messages m JOIN linebot.message_state s
        ON s.message_id=m.message_id AND s.group_id=m.group_id
      WHERE m.group_id=$1 AND coalesce(m.sent_at,m.received_at) >= $2
        AND coalesce(m.sent_at,m.received_at) < $3 AND s.unsent_at IS NULL
        AND (($4::text IS NULL AND cardinality($7::text[])=0) OR ($4::text IS NOT NULL AND strpos(lower(m.message_text),lower($4))>0)
          OR EXISTS(SELECT 1 FROM unnest($7::text[]) AS search(term) WHERE strpos(lower(m.message_text),lower(term))>0))
        AND ($6::text IS NULL OR m.message_text ~ $6)
        AND NOT EXISTS (SELECT 1 FROM linebot.assistant_jobs j
          WHERE j.source_message_id=m.message_id AND j.group_id=m.group_id)
      ORDER BY ${rank}coalesce(m.sent_at,m.received_at) DESC,m.message_id DESC LIMIT $5`,
    [job.group_id, job.range_start, job.range_end, job.keyword,
      this.config.assistant.maxMessages + (job.history ? 1 : 0), eventDatePattern(job.eventDate),searchTerms]);
    const sendMaximum=this.config.assistant.workspaceEnabled?(this.config.assistant.contextMessages||20):this.config.assistant.maxMessages;
    let candidates=rows.slice(0,this.config.assistant.maxMessages),threadLimited=false,relatedTotal=0;
    if(this.config.assistant.workspaceEnabled&&candidates.length){
      let frontier=candidates,neighbors=[];
      for(let depth=0;depth<2;depth++){
        const parentIds=frontier.map(r=>r.quoted_message_id).filter(Boolean),ids=frontier.map(r=>r.message_id);
        const {rows:related}=await this.pool.query(`SELECT m.message_id,m.user_id,m.quoted_message_id,left(m.message_text,2000) AS text,
          char_length(m.message_text)>2000 AS text_truncated,encode(sha256(convert_to(m.message_text,'UTF8')),'hex') AS digest,
          coalesce(m.sent_at,m.received_at) AS effective_at FROM linebot.messages m JOIN linebot.message_state s
          ON s.message_id=m.message_id AND s.group_id=m.group_id WHERE m.group_id=$1
          AND coalesce(m.sent_at,m.received_at)>=$2 AND coalesce(m.sent_at,m.received_at)<$3 AND s.unsent_at IS NULL
          AND (m.message_id=ANY($4::text[]) OR m.quoted_message_id=ANY($5::text[]))
          AND NOT EXISTS(SELECT 1 FROM linebot.assistant_jobs j WHERE j.source_message_id=m.message_id AND j.group_id=m.group_id)
          ORDER BY coalesce(m.sent_at,m.received_at) DESC,m.message_id DESC LIMIT 101`,[job.group_id,job.range_start,job.range_end,parentIds,ids]);
        neighbors.push(...related);frontier=related;
        if(related.length===101)threadLimited=true;
        if(!related.length)break;
      }
      const merged=new Map([...candidates,...neighbors].map(r=>[r.message_id,r]));
      relatedTotal=merged.size;
      candidates=selectThreadRows(candidates,neighbors,sendMaximum);
      threadLimited ||= candidates.length<merged.size;
    }
    const selected = [];
    let remaining = this.config.assistant.workspaceEnabled?(this.config.assistant.contextCharacters||12000):22000;
    for (const row of candidates) {
      if (remaining < 100) break;
      let text = row.text.slice(0, remaining);
      if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
      selected.push({ ...row, text, text_truncated: row.text_truncated || text.length < row.text.length });
      remaining -= text.length;
    }
    selected.sort((a,b)=>new Date(a.effective_at)-new Date(b.effective_at)||a.message_id.localeCompare(b.message_id));
    const refById=new Map(selected.map((r,i)=>[r.message_id,`M${i+1}`]));
    return {
      messages: selected.map((row, i) => ({ ref: `M${i + 1}`, at: new Date(row.effective_at).toISOString(), text: row.text,
        ...(this.config.assistant.workspaceEnabled?{speaker:speakerLabel(row.user_id,this.config),replyTo:refById.get(row.quoted_message_id)||null}: {}) })),
      versions: selected.map(sourceVersion), ids: selected.map(row => row.message_id),
      sourceRefs:selected.map((r,i)=>({id:r.message_id,digest:r.digest,at:new Date(r.effective_at).toISOString(),ref:`M${i+1}`})),
      total: this.config.assistant.workspaceEnabled?Math.max(selected.length,relatedTotal,job.history?rows.length:rows[0]?.total_count||0):job.history ? rows.length : rows[0]?.total_count || 0,
      totalIsLowerBound: Boolean(threadLimited||job.history && rows.length > this.config.assistant.maxMessages),
      history: Boolean(job.history),
      scopeLabel: job.scopeLabel,
      query:{keyword:job.keyword||null,searchTerms,history:Boolean(job.history),eventDate:job.eventDate||null,
        range_start:job.range_start,range_end:job.range_end,scopeLabel:job.scopeLabel||null},
      truncated: threadLimited||selected.length < (job.history ? rows.length : rows[0]?.total_count || 0) || selected.some(row => row.text_truncated),
      readAt: new Date().toISOString(),
    };
  }

  async unchanged(job, snapshot) {
    if (!await this.current(job)) return false;
    if (!snapshot?.ids.length) return true;
    const { rows } = await this.pool.query(`SELECT m.message_id,
        encode(sha256(convert_to(m.message_text,'UTF8')),'hex') AS digest,
        coalesce(m.sent_at,m.received_at) AS effective_at
      FROM linebot.messages m JOIN linebot.message_state s
        ON s.message_id=m.message_id AND s.group_id=m.group_id
      WHERE m.group_id=$1 AND m.message_id=ANY($2::text[]) AND s.unsent_at IS NULL`, [job.group_id, snapshot.ids]);
    const versions = new Set(rows.map(sourceVersion));
    return versions.size === snapshot.versions.length && snapshot.versions.every(version => versions.has(version));
  }

  async status(job) {
    const day = taipeiDay();
    const { rows: [row] } = await this.pool.query(`SELECT
      (SELECT count(*)::integer FROM linebot.messages WHERE group_id=$1
        AND coalesce(sent_at,received_at) >= $2 AND coalesce(sent_at,received_at) < $3) AS messages,
      (SELECT count(*)::integer FROM linebot.assistant_jobs WHERE ($4::boolean OR group_id=$1)
        AND created_at >= $2 AND created_at < $3 AND kind IN ('summary','todos','assist')) AS used`,
    [job.group_id, day.start, day.end,Boolean(this.config.assistant.multiGroupEnabled)]);
    return { ...row, day: day.day, dailyLimit: this.config.assistant.dailyLimit };
  }

  async finish(job, status, errorCode = null, metrics = {}) {
    if (!['sent','failed','expired','canceled'].includes(status)) throw new Error('Invalid job status');
    await this.pool.query(`UPDATE linebot.assistant_jobs SET status=$2,encrypted_reply_token=NULL,
        finished_at=clock_timestamp(),error_code=$3,message_count=$4,input_truncated=$5,
      input_tokens=$6,output_tokens=$7${this.config.assistant.workspaceEnabled?',model_name=$8,api_call_count=$9':''} WHERE event_id=$1 AND status='processing'`,
    [job.event_id, status, errorCode, metrics.messageCount ?? null, metrics.truncated ?? null,
      metrics.inputTokens ?? null, metrics.outputTokens ?? null,...(this.config.assistant.workspaceEnabled?
        [(metrics.apiCalls||0)>0?this.config.assistant.model:null,metrics.apiCalls||0]:[])]);
  }
}
