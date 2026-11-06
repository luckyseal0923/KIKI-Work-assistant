-- 僅新增 KIKI 的 linebot 工作佇列；不改其他 schema 或共享角色。
-- Reply token 只保存經 Channel secret 衍生金鑰加密的短期密文。
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE IF NOT EXISTS linebot.assistant_jobs (
  event_id text PRIMARY KEY REFERENCES linebot.webhook_events(webhook_event_id),
  source_message_id text NOT NULL UNIQUE,
  group_id text NOT NULL,
  operator_user_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('help','status','summary','todos','unsupported','rate_limited')),
  keyword text CHECK (char_length(keyword) <= 60),
  notice_reason text CHECK (notice_reason IN ('daily_limit','cooldown')),
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','sent','failed','expired','canceled')),
  encrypted_reply_token text CHECK (char_length(encrypted_reply_token) <= 1024),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
  started_at timestamptz,
  finished_at timestamptz,
  error_code text CHECK (char_length(error_code) <= 64),
  message_count integer CHECK (message_count BETWEEN 0 AND 100),
  input_truncated boolean,
  input_tokens integer,
  output_tokens integer,
  CHECK (range_end > range_start),
  CHECK (expires_at > created_at),
  CHECK ((status IN ('queued','processing') AND encrypted_reply_token IS NOT NULL)
      OR (status NOT IN ('queued','processing') AND encrypted_reply_token IS NULL))
);

CREATE INDEX IF NOT EXISTS assistant_jobs_queue_idx ON linebot.assistant_jobs(created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS assistant_jobs_expiry_idx ON linebot.assistant_jobs(expires_at)
  WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS assistant_jobs_budget_idx ON linebot.assistant_jobs(group_id,created_at)
  WHERE kind IN ('summary','todos');

ALTER TABLE linebot.assistant_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE linebot.assistant_jobs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE linebot.assistant_jobs TO linebot_app;
DROP POLICY IF EXISTS linebot_app_access ON linebot.assistant_jobs;
CREATE POLICY linebot_app_access ON linebot.assistant_jobs FOR ALL TO linebot_app
  USING (true) WITH CHECK (true);
COMMIT;
