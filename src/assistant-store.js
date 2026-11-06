import { createHash } from 'node:crypto';
import { taipeiDay } from './assistant-command.js';

export async function enqueueAssistantJob(client, event) {
  const job = event.assistantJob;
  // Serialize only this application's group budget within the archive transaction.
  await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kiki_assistant_v1'),pg_catalog.hashtext($1))", [event.groupId]);
  let kind = job.kind, reason = null;
  if (['summary', 'todos'].includes(kind)) {
    const { rows: [budget] } = await client.query(`SELECT count(*)::integer AS used,
        coalesce(bool_or(created_at > $4::timestamptz - ($5::integer * interval '1 second')),false) AS cooling
      FROM linebot.assistant_jobs WHERE group_id=$1 AND created_at >= $2 AND created_at < $3
        AND kind IN ('summary','todos')`,
    [event.groupId, job.quotaStart, job.quotaEnd, job.createdAt, job.cooldownSeconds]);
    if (budget.used >= job.dailyLimit) { kind = 'rate_limited'; reason = 'daily_limit'; }
    else if (budget.cooling) { kind = 'rate_limited'; reason = 'cooldown'; }
  }
  await client.query(`INSERT INTO linebot.assistant_jobs
    (event_id,source_message_id,group_id,operator_user_id,source_digest,kind,keyword,notice_reason,
     range_start,range_end,created_at,expires_at,encrypted_reply_token)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
  [event.eventId, event.messageId, event.groupId, job.operatorUserId, job.sourceDigest,
    kind, job.keyword, reason, job.rangeStart, job.rangeEnd, job.createdAt, job.expiresAt, job.encryptedReplyToken]);
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
    if (job.group_id !== this.config.allowedGroupId || job.operator_user_id !== this.config.assistant.operatorUserId) return false;
    const { rows } = await this.pool.query(`SELECT m.message_text
      FROM linebot.assistant_jobs j JOIN linebot.messages m
        ON m.message_id=j.source_message_id AND m.group_id=j.group_id
      JOIN linebot.message_state s ON s.message_id=m.message_id AND s.group_id=m.group_id
      WHERE j.event_id=$1 AND j.status='processing' AND j.expires_at > clock_timestamp()
        AND s.unsent_at IS NULL`, [job.event_id]);
    return rows.length === 1 && createHash('sha256').update(rows[0].message_text).digest('hex') === job.source_digest;
  }

  async readMessages(job) {
    const { rows } = await this.pool.query(`SELECT m.message_id,left(m.message_text,2000) AS text,
        char_length(m.message_text)>2000 AS text_truncated,
        encode(sha256(convert_to(m.message_text,'UTF8')),'hex') AS digest,
        coalesce(m.sent_at,m.received_at) AS effective_at,count(*) OVER()::integer AS total_count
      FROM linebot.messages m JOIN linebot.message_state s
        ON s.message_id=m.message_id AND s.group_id=m.group_id
      WHERE m.group_id=$1 AND coalesce(m.sent_at,m.received_at) >= $2
        AND coalesce(m.sent_at,m.received_at) < $3 AND s.unsent_at IS NULL
        AND ($4::text IS NULL OR strpos(lower(m.message_text),lower($4))>0)
        AND NOT EXISTS (SELECT 1 FROM linebot.assistant_jobs j
          WHERE j.source_message_id=m.message_id AND j.group_id=m.group_id)
      ORDER BY coalesce(m.sent_at,m.received_at) DESC,m.message_id DESC LIMIT $5`,
    [job.group_id, job.range_start, job.range_end, job.keyword, this.config.assistant.maxMessages]);
    const selected = [];
    let remaining = 22000;
    for (const row of rows) {
      if (remaining < 100) break;
      let text = row.text.slice(0, remaining);
      if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
      selected.push({ ...row, text, text_truncated: row.text_truncated || text.length < row.text.length });
      remaining -= text.length;
    }
    selected.reverse();
    return {
      messages: selected.map((row, i) => ({ ref: `M${i + 1}`, at: new Date(row.effective_at).toISOString(), text: row.text })),
      versions: selected.map(sourceVersion), ids: selected.map(row => row.message_id),
      total: rows[0]?.total_count || 0,
      truncated: selected.length < (rows[0]?.total_count || 0) || selected.some(row => row.text_truncated),
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
      (SELECT count(*)::integer FROM linebot.assistant_jobs WHERE group_id=$1
        AND created_at >= $2 AND created_at < $3 AND kind IN ('summary','todos')) AS used`,
    [job.group_id, day.start, day.end]);
    return { ...row, day: day.day, dailyLimit: this.config.assistant.dailyLimit };
  }

  async finish(job, status, errorCode = null, metrics = {}) {
    if (!['sent','failed','expired','canceled'].includes(status)) throw new Error('Invalid job status');
    await this.pool.query(`UPDATE linebot.assistant_jobs SET status=$2,encrypted_reply_token=NULL,
        finished_at=clock_timestamp(),error_code=$3,message_count=$4,input_truncated=$5,
        input_tokens=$6,output_tokens=$7 WHERE event_id=$1 AND status='processing'`,
    [job.event_id, status, errorCode, metrics.messageCount ?? null, metrics.truncated ?? null,
      metrics.inputTokens ?? null, metrics.outputTokens ?? null]);
  }
}
