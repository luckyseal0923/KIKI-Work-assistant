-- 以既有的 postgres 管理員在 SQL Editor 執行一次；可重跑。
-- 前提：linebot、linebot_app、linebot.messages 已由你建立。
-- 不重新建立它們，不改其他 schema，也不把 linebot 加入 exposed schemas。
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

ALTER TABLE linebot.messages
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_edit_event_id text;

-- 編輯事件可能早於原始訊息抵達；此時原發送時間未知，先留 NULL。
-- 若原始事件稍後抵達，補回 sent_at，絕不以舊文字覆蓋編輯版。
ALTER TABLE linebot.messages ALTER COLUMN sent_at DROP NOT NULL;

CREATE TABLE IF NOT EXISTS linebot.webhook_events (
  webhook_event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- 每一則訊息共用這個列鎖；撤回後只留下識別碼與撤回時間。
-- 刻意不設 FK：即使撤回先抵達、文字尚不存在，仍能留下 tombstone。
CREATE TABLE IF NOT EXISTS linebot.message_state (
  message_id text PRIMARY KEY,
  group_id text NOT NULL,
  unsent_at timestamptz
);

ALTER TABLE linebot.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE linebot.message_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE linebot.webhook_events, linebot.message_state
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE linebot.webhook_events TO linebot_app;
GRANT SELECT, INSERT, UPDATE ON TABLE linebot.message_state TO linebot_app;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'linebot'
      AND tablename = 'webhook_events' AND policyname = 'linebot_app_access') THEN
    CREATE POLICY linebot_app_access ON linebot.webhook_events
      FOR ALL TO linebot_app USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'linebot'
      AND tablename = 'message_state' AND policyname = 'linebot_app_access') THEN
    CREATE POLICY linebot_app_access ON linebot.message_state
      FOR ALL TO linebot_app USING (true) WITH CHECK (true);
  END IF;
END
$migration$;
COMMIT;
