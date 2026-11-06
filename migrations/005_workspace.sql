-- KIKI 對話記憶與需確認的工作紀錄；由既有 linebot schema 擁有者執行。
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE IF NOT EXISTS linebot.assistant_context (
  group_id text NOT NULL,
  operator_user_id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND char_length(payload::text)<=60000),
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(group_id,operator_user_id)
);
CREATE TABLE IF NOT EXISTS linebot.work_items (
  code text PRIMARY KEY CHECK (code ~ '^W[0-9A-F]{8}$'),
  group_id text NOT NULL,
  version integer NOT NULL CHECK (version>0),
  body jsonb NOT NULL CHECK (jsonb_typeof(body)='object' AND char_length(body::text)<=6000
    AND body->>'kind' IN ('task','decision','event') AND body->>'status' IN ('active','in_progress','done','canceled')),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=101),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS linebot.work_proposals (
  code text PRIMARY KEY CHECK (code ~ '^P[0-9A-F]{8}$'),
  group_id text NOT NULL,
  operator_user_id text NOT NULL,
  source_event_id text NOT NULL UNIQUE REFERENCES linebot.assistant_jobs(event_id),
  actions jsonb NOT NULL CHECK (jsonb_typeof(actions)='array' AND jsonb_array_length(actions) BETWEEN 1 AND 3
    AND char_length(actions::text)<=30000),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=101),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','discarded','expired','invalid')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  confirmed_event_id text UNIQUE REFERENCES linebot.assistant_jobs(event_id),
  CHECK (expires_at>created_at)
);
CREATE TABLE IF NOT EXISTS linebot.work_events (
  proposal_code text NOT NULL REFERENCES linebot.work_proposals(code),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 2),
  item_code text NOT NULL REFERENCES linebot.work_items(code),
  group_id text NOT NULL,
  version integer NOT NULL CHECK (version>0),
  previous_body jsonb,
  next_body jsonb NOT NULL,
  confirmed_event_id text NOT NULL REFERENCES linebot.assistant_jobs(event_id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(proposal_code,ordinal),
  UNIQUE(item_code,version)
);
CREATE INDEX IF NOT EXISTS work_items_group_updated_idx ON linebot.work_items(group_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS work_proposals_pending_idx ON linebot.work_proposals(group_id,operator_user_id,expires_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS messages_group_quote_idx ON linebot.messages(group_id,quoted_message_id);
CREATE INDEX IF NOT EXISTS messages_group_effective_idx ON linebot.messages(group_id,(coalesce(sent_at,received_at)) DESC);

ALTER TABLE linebot.assistant_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE linebot.work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE linebot.work_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE linebot.work_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE linebot.assistant_context,linebot.work_items,linebot.work_proposals,linebot.work_events
  FROM PUBLIC,anon,authenticated,service_role,linebot_app;
GRANT SELECT,INSERT,UPDATE ON TABLE linebot.assistant_context,linebot.work_items,linebot.work_proposals TO linebot_app;
GRANT SELECT,INSERT ON TABLE linebot.work_events TO linebot_app;
DROP POLICY IF EXISTS linebot_app_access ON linebot.assistant_context;
CREATE POLICY linebot_app_access ON linebot.assistant_context FOR ALL TO linebot_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS linebot_app_access ON linebot.work_items;
CREATE POLICY linebot_app_access ON linebot.work_items FOR ALL TO linebot_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS linebot_app_access ON linebot.work_proposals;
CREATE POLICY linebot_app_access ON linebot.work_proposals FOR ALL TO linebot_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS linebot_app_access ON linebot.work_events;
CREATE POLICY linebot_app_access ON linebot.work_events FOR ALL TO linebot_app USING(true) WITH CHECK(true);
ALTER TABLE linebot.assistant_jobs DROP CONSTRAINT IF EXISTS assistant_jobs_kind_check;
ALTER TABLE linebot.assistant_jobs ADD COLUMN IF NOT EXISTS model_name text;
ALTER TABLE linebot.assistant_jobs ADD COLUMN IF NOT EXISTS api_call_count integer CHECK(api_call_count BETWEEN 0 AND 2);
ALTER TABLE linebot.assistant_jobs ADD CONSTRAINT assistant_jobs_kind_check
  CHECK (kind IN ('help','status','summary','todos','assist','workspace','unsupported','rate_limited'));
ALTER TABLE linebot.assistant_jobs DROP CONSTRAINT IF EXISTS assistant_jobs_request_offset_check;
ALTER TABLE linebot.assistant_jobs ADD CONSTRAINT assistant_jobs_request_offset_check
  CHECK ((kind IN ('assist','workspace') AND request_offset IS NOT NULL AND request_offset BETWEEN 1 AND 8000)
    OR (kind NOT IN ('assist','workspace') AND request_offset IS NULL));
COMMIT;
