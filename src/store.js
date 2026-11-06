import { enqueueAssistantJob, cancelAssistantJobs } from './assistant-store.js';

// Every query that includes webhook values uses PostgreSQL parameters.
// message_state is both a per-message row lock and a permanent unsend tombstone.
export const SQL = {
  receipt: `INSERT INTO linebot.webhook_events (webhook_event_id)
    VALUES ($1) ON CONFLICT DO NOTHING RETURNING webhook_event_id`,
  state: `INSERT INTO linebot.message_state AS s (message_id, group_id, unsent_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (message_id) DO UPDATE SET unsent_at = COALESCE(s.unsent_at, EXCLUDED.unsent_at)
    WHERE s.group_id = EXCLUDED.group_id RETURNING unsent_at`,
  remove: `DELETE FROM linebot.messages WHERE message_id = $1 AND group_id = $2`,
  original: `INSERT INTO linebot.messages AS m
      (message_id, webhook_event_id, group_id, user_id, message_text, quoted_message_id, sent_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (message_id) DO UPDATE SET
      sent_at = COALESCE(m.sent_at, EXCLUDED.sent_at),
      webhook_event_id = COALESCE(m.webhook_event_id, EXCLUDED.webhook_event_id),
      user_id = COALESCE(m.user_id, EXCLUDED.user_id),
      quoted_message_id = COALESCE(m.quoted_message_id, EXCLUDED.quoted_message_id)
    WHERE m.group_id = EXCLUDED.group_id`,
  edit: `INSERT INTO linebot.messages AS m
      (message_id, group_id, user_id, message_text, quoted_message_id, sent_at, edited_at, last_edit_event_id)
    VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)
    ON CONFLICT (message_id) DO UPDATE SET
      message_text = EXCLUDED.message_text,
      user_id = COALESCE(EXCLUDED.user_id, m.user_id),
      quoted_message_id = COALESCE(EXCLUDED.quoted_message_id, m.quoted_message_id),
      edited_at = EXCLUDED.edited_at,
      last_edit_event_id = EXCLUDED.last_edit_event_id
    WHERE m.group_id = EXCLUDED.group_id AND
      (m.edited_at IS NULL OR m.edited_at < EXCLUDED.edited_at OR
       (m.edited_at = EXCLUDED.edited_at AND
        m.last_edit_event_id COLLATE "C" < EXCLUDED.last_edit_event_id COLLATE "C"))`,
};

export async function persistEvents(client, events, { assistantEnabled = false } = {}) {
  // Consistent lock order prevents deadlocks between multi-event deliveries.
  const freshIds = new Set();
  for (const eventId of [...new Set(events.map(e => e.eventId))].sort()) {
    if ((await client.query(SQL.receipt, [eventId])).rows.length) freshIds.add(eventId);
  }
  let processed = 0;
  const ordered = [...events].sort((a, b) =>
    a.messageId.localeCompare(b.messageId, 'en') || a.eventId.localeCompare(b.eventId, 'en'));
  for (const event of ordered) {
    if (!freshIds.delete(event.eventId)) continue;
    const state = await client.query(SQL.state, [
      event.messageId, event.groupId, event.kind === 'unsend' ? event.at : null,
    ]);
    if (!state.rows.length) throw new Error('Message group conflict');
    if (state.rows[0].unsent_at != null) {
      await client.query(SQL.remove, [event.messageId, event.groupId]);
      if (assistantEnabled) await cancelAssistantJobs(client, event.messageId, event.groupId);
    } else if (event.kind === 'message') {
      await client.query(SQL.original, [event.messageId, event.eventId, event.groupId,
        event.userId, event.text, event.quotedMessageId, event.at]);
      if (assistantEnabled && event.assistantJob) await enqueueAssistantJob(client, event);
    } else {
      await client.query(SQL.edit, [event.messageId, event.groupId, event.userId,
        event.text, event.quotedMessageId, event.at, event.eventId]);
      if (assistantEnabled) await cancelAssistantJobs(client, event.messageId, event.groupId);
    }
    processed++;
  }
  return processed;
}

export class PgStore {
  constructor(pool, { assistantEnabled = false } = {}) { this.pool = pool; this.assistantEnabled = assistantEnabled; }

  async save(events) {
    if (!events.length) return 0;
    const started = Date.now();
    const client = await this.pool.connect();
    let broken = false;
    let released = false;
    // pg.Pool's idle error listener is removed while a client is checked out.
    // Handle transport errors here so a database disconnect cannot crash Node.
    const onClientError = () => { broken = true; };
    client.on('error', onClientError);
    // Also bounds a large batch; closing a live connection rolls its transaction back.
    const timer = setTimeout(() => {
      broken = true;
      released = true;
      client.release(true);
    }, Math.max(1, 1600 - (Date.now() - started)));
    timer.unref();
    try {
      await client.query('BEGIN');
      const count = await persistEvents(client, events, { assistantEnabled: this.assistantEnabled });
      await client.query('COMMIT');
      return count;
    } catch (error) {
      if (!released) {
        try { await client.query('ROLLBACK'); } catch { broken = true; }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (!released) client.release(broken);
      client.removeListener('error', onClientError);
    }
  }

  async ready() { await this.pool.query('SELECT 1'); }
  async close() { await this.pool.end(); }
}
