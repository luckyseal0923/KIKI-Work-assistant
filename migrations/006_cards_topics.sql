-- KIKI only: authenticated card events and owner-confirmed topic aliases.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TABLE IF NOT EXISTS linebot.assistant_actions (
  event_id text PRIMARY KEY REFERENCES linebot.webhook_events(webhook_event_id),
  group_id text NOT NULL,
  operator_user_id text NOT NULL,
  command text NOT NULL CHECK(char_length(command) BETWEEN 1 AND 400),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS linebot.topics (
  code text PRIMARY KEY CHECK(code ~ '^T[0-9A-F]{8}$'),
  group_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND definition ? 'name' AND definition ? 'aliases'
    AND char_length(definition->>'name') BETWEEN 2 AND 60
    AND jsonb_typeof(definition->'aliases')='array' AND jsonb_array_length(definition->'aliases')<=4),
  sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=101),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS topics_group_name_idx ON linebot.topics(group_id,lower(definition->>'name'));
CREATE TABLE IF NOT EXISTS linebot.topic_events (
  proposal_code text PRIMARY KEY REFERENCES linebot.work_proposals(code),
  topic_code text NOT NULL REFERENCES linebot.topics(code),
  group_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  previous_definition jsonb,
  next_definition jsonb NOT NULL,
  confirmed_event_id text NOT NULL REFERENCES linebot.assistant_jobs(event_id),
  created_at timestamptz NOT NULL,
  UNIQUE(topic_code,version)
);
CREATE TABLE IF NOT EXISTS linebot.group_settings (
  code text PRIMARY KEY CHECK(code ~ '^G[0-9A-F]{8}$'),
  group_id text NOT NULL UNIQUE,
  label text NOT NULL CHECK(char_length(label) BETWEEN 2 AND 60),
  operator_user_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  enabled boolean NOT NULL,
  sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources)<=101),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS linebot.group_events (
  proposal_code text PRIMARY KEY REFERENCES linebot.work_proposals(code),
  group_code text NOT NULL REFERENCES linebot.group_settings(code),
  group_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  previous_settings jsonb,
  next_settings jsonb NOT NULL,
  confirmed_event_id text NOT NULL REFERENCES linebot.assistant_jobs(event_id),
  created_at timestamptz NOT NULL,
  UNIQUE(group_code,version)
);
ALTER TABLE linebot.assistant_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE linebot.topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE linebot.topic_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE linebot.group_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE linebot.group_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE linebot.assistant_actions,linebot.topics,linebot.topic_events,linebot.group_settings,linebot.group_events FROM PUBLIC,anon,authenticated,service_role,linebot_app;
GRANT SELECT,INSERT ON TABLE linebot.assistant_actions,linebot.topic_events,linebot.group_events TO linebot_app;
GRANT SELECT,INSERT,UPDATE ON TABLE linebot.topics,linebot.group_settings TO linebot_app;
DROP POLICY IF EXISTS linebot_app_access ON linebot.assistant_actions;
CREATE POLICY linebot_app_access ON linebot.assistant_actions FOR ALL TO linebot_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS linebot_app_access ON linebot.topics;
CREATE POLICY linebot_app_access ON linebot.topics FOR ALL TO linebot_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS linebot_app_access ON linebot.topic_events;
CREATE POLICY linebot_app_access ON linebot.topic_events FOR ALL TO linebot_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS linebot_app_access ON linebot.group_settings;
CREATE POLICY linebot_app_access ON linebot.group_settings FOR ALL TO linebot_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS linebot_app_access ON linebot.group_events;
CREATE POLICY linebot_app_access ON linebot.group_events FOR ALL TO linebot_app USING(true) WITH CHECK(true);
ALTER TABLE linebot.assistant_jobs ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'message';
ALTER TABLE linebot.assistant_jobs ADD COLUMN IF NOT EXISTS source_action_id text REFERENCES linebot.assistant_actions(event_id);
ALTER TABLE linebot.assistant_jobs ALTER COLUMN source_message_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assistant_jobs_action_source_idx ON linebot.assistant_jobs(source_action_id) WHERE source_action_id IS NOT NULL;
ALTER TABLE linebot.assistant_jobs DROP CONSTRAINT IF EXISTS assistant_jobs_source_check;
ALTER TABLE linebot.assistant_jobs ADD CONSTRAINT assistant_jobs_source_check CHECK(
  (source_kind='message' AND source_message_id IS NOT NULL AND source_action_id IS NULL)
  OR (source_kind='action' AND source_message_id IS NULL AND source_action_id IS NOT NULL AND source_action_id=event_id AND kind='workspace'));
ALTER TABLE linebot.assistant_jobs DROP CONSTRAINT IF EXISTS assistant_jobs_request_offset_check;
ALTER TABLE linebot.assistant_jobs ADD CONSTRAINT assistant_jobs_request_offset_check CHECK(
  (source_kind='action' AND kind='workspace' AND request_offset IS NOT NULL AND request_offset=0)
  OR (source_kind='message' AND ((kind IN ('assist','workspace') AND request_offset IS NOT NULL AND request_offset BETWEEN 1 AND 8000)
    OR (kind NOT IN ('assist','workspace') AND request_offset IS NULL))));
ALTER TABLE linebot.work_items ADD COLUMN IF NOT EXISTS topic_code text REFERENCES linebot.topics(code);
CREATE INDEX IF NOT EXISTS work_items_topic_idx ON linebot.work_items(group_id,topic_code,updated_at DESC) WHERE topic_code IS NOT NULL;
COMMIT;
