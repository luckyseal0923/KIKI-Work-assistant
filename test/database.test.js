import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { PgStore } from '../src/store.js';
import { auditDatabase } from '../src/database-audit.js';

const group = `C${'1'.repeat(32)}`;
let sequence = 0;
function event(kind, messageId, milliseconds = 0, text = '合成文字', extra = {}) {
  return { kind, messageId, eventId: `synthetic-event-${++sequence}`, groupId: group,
    at: new Date(Date.UTC(2026, 10, 5, 0, 0, 0, milliseconds)).toISOString(),
    text, userId: null, quotedMessageId: null, ...extra };
}

test('PostgreSQL engine integration: migration, RLS, deduplication, edits, unsend, rollback and audit', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  // Reproduce only in the isolated in-memory test database the objects already
  // created by the user. This fixture is NEVER a production migration.
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE ROLE linebot_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA linebot;
    REVOKE ALL ON SCHEMA linebot FROM PUBLIC, anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA linebot TO linebot_app;
    CREATE TABLE linebot.messages (
      message_id text PRIMARY KEY, webhook_event_id text UNIQUE,
      group_id text NOT NULL, user_id text, message_text text NOT NULL,
      quoted_message_id text, sent_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX messages_group_time_idx ON linebot.messages (group_id, sent_at DESC);
    ALTER TABLE linebot.messages ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE linebot.messages FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE linebot.messages TO linebot_app;
    CREATE POLICY linebot_app_access ON linebot.messages FOR ALL TO linebot_app USING (true) WITH CHECK (true);
    CREATE SCHEMA other_app;
    CREATE TABLE other_app.protected (sample text);
    INSERT INTO other_app.protected VALUES ('合成的其他系統資料');
  `);
  const migration = await readFile(new URL('../migrations/001_event_safety.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(await readFile(new URL('../migrations/002_role_login.sql', import.meta.url), 'utf8'));
  await db.exec('SET ROLE linebot_app');
  const pool = { connect: async () => Object.assign(new EventEmitter(), {
    query: (...args) => db.query(...args), release: () => {},
  }) };
  const store = new PgStore(pool);
  const rows = async messageId => (await db.query('SELECT * FROM linebot.messages WHERE message_id = $1', [messageId])).rows;

  await t.test('restricted role passes preflight and cannot read another app or create objects', async () => {
    const audit = await auditDatabase(db);
    assert.deepEqual(audit.issues, []);
    assert.equal(audit.ok, true);
    await assert.rejects(db.query('SELECT * FROM other_app.protected'), /permission denied/);
    await assert.rejects(db.query('CREATE TABLE linebot.forbidden (x text)'), /permission denied/);
  });

  await t.test('message and event IDs deduplicate redeliveries and preserve literal SQL-like text', async () => {
    const text = "合成字串：'); DROP TABLE linebot.messages; --\n🧪";
    const original = event('message', 'synthetic-message-a', 0, text, { quotedMessageId: 'synthetic-reference' });
    assert.equal(await store.save([original]), 1);
    assert.equal(await store.save([original]), 0);
    assert.equal(await store.save([{ ...original, eventId: 'synthetic-new-delivery-id' }]), 1);
    const [row] = await rows(original.messageId);
    assert.equal(row.message_text, text);
    assert.equal(row.user_id, null);
    assert.equal(row.quoted_message_id, 'synthetic-reference');
    assert.equal(row.sent_at.toISOString(), original.at);
    assert.equal((await rows(original.messageId)).length, 1);
  });

  await t.test('latest edit wins despite old edit/original redelivery', async () => {
    const original = event('message', 'synthetic-message-b', 0, '合成原文');
    const older = event('messageEdited', original.messageId, 100, '合成舊編輯');
    const newer = event('messageEdited', original.messageId, 200, '合成最新編輯');
    await store.save([original]);
    await store.save([newer]);
    await store.save([older, original]);
    const [row] = await rows(original.messageId);
    assert.equal(row.message_text, newer.text);
    assert.equal(row.sent_at.toISOString(), original.at);
    assert.equal(row.edited_at.toISOString(), newer.at);
  });

  await t.test('edit arriving first has unknown sent_at; late original fills metadata only', async () => {
    const original = event('message', 'synthetic-message-c', 0, '合成原始', { quotedMessageId: 'synthetic-quote' });
    const edit = event('messageEdited', original.messageId, 500, '合成修改後');
    await store.save([edit]);
    assert.equal((await rows(original.messageId))[0].sent_at, null);
    await store.save([original]);
    const [row] = await rows(original.messageId);
    assert.equal(row.message_text, edit.text);
    assert.equal(row.sent_at.toISOString(), original.at);
    assert.equal(row.webhook_event_id, original.eventId);
    assert.equal(row.quoted_message_id, 'synthetic-quote');
  });

  await t.test('equal edit timestamps converge deterministically by event ID', async () => {
    for (const [messageId, order] of [['synthetic-tie-a', [1, 0]], ['synthetic-tie-b', [0, 1]]]) {
      const edits = [event('messageEdited', messageId, 100, '合成甲', { eventId: `${messageId}-A` }),
        event('messageEdited', messageId, 100, '合成乙', { eventId: `${messageId}-B` })];
      for (const i of order) await store.save([edits[i]]);
      assert.equal((await rows(messageId))[0].message_text, '合成乙');
    }
  });

  await t.test('unsend deletes text and blocks original/edit resurrection, even if it arrives first', async () => {
    for (const unsendFirst of [false, true]) {
      const messageId = `synthetic-unsend-${unsendFirst}`;
      const original = event('message', messageId, 0, '合成待撤回');
      const unsend = event('unsend', messageId, 1000);
      const edit = event('messageEdited', messageId, 500, '合成撤回前編輯');
      if (!unsendFirst) await store.save([original]);
      await store.save([unsend]);
      await store.save([edit, original]);
      await store.save([unsend]);
      assert.deepEqual(await rows(messageId), []);
      const { rows: [state] } = await db.query('SELECT * FROM linebot.message_state WHERE message_id = $1', [messageId]);
      assert.equal(state.unsent_at.toISOString(), unsend.at);
      assert.deepEqual(Object.keys(state).sort(), ['group_id', 'message_id', 'unsent_at']);
    }
  });

  await t.test('entire mixed batch rolls back on failure; retry then commits without losing earlier events', async () => {
    const a = event('message', 'synthetic-rollback-a');
    const b = event('message', 'synthetic-rollback-b');
    let failing = true;
    const failingStore = new PgStore({ connect: async () => Object.assign(new EventEmitter(), { query: (sql, params) => {
      if (failing && sql.includes('INSERT INTO linebot.messages') && params[0] === b.messageId) throw new Error('synthetic-failure');
      return db.query(sql, params);
    }, release: () => {} }) });
    await assert.rejects(failingStore.save([a, b]));
    assert.deepEqual(await rows(a.messageId), []);
    assert.equal((await db.query('SELECT * FROM linebot.webhook_events WHERE webhook_event_id = ANY($1::text[])', [[a.eventId, b.eventId]])).rows.length, 0);
    failing = false;
    assert.equal(await failingStore.save([a, b]), 2);
    assert.equal((await rows(a.messageId)).length, 1);
    assert.equal((await rows(b.messageId)).length, 1);
  });

  await t.test('anon/authenticated/service_role cannot read the dedicated schema', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await assert.rejects(db.query('SELECT * FROM linebot.messages'), /permission denied/);
    }
    await db.exec('RESET ROLE; SET ROLE linebot_app');
  });

  await t.test('audit detects PUBLIC table and security-definer access in another schema', async () => {
    await db.exec(`RESET ROLE;
      GRANT USAGE ON SCHEMA other_app TO PUBLIC;
      GRANT SELECT ON other_app.protected TO PUBLIC;
      CREATE FUNCTION other_app.synthetic_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
      SET ROLE linebot_app;`);
    const audit = await auditDatabase(db);
    assert.equal(audit.ok, false);
    assert.ok(audit.issues.includes('external_table_privileges'));
    assert.ok(audit.issues.includes('external_security_definer'));
    assert.deepEqual(audit.externalTables, [{ schema: 'other_app', object: 'protected' }]);
  });
});
