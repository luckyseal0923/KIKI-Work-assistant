-- Disable ASSISTANT_MULTI_GROUP_ENABLED and ASSISTANT_ORGANIZER_ENABLED, deploy first.
-- Retain data and earlier ACLs. Action-backed work remains unavailable until re-enabled.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
REVOKE SELECT,INSERT ON TABLE linebot.assistant_actions,linebot.topic_events,linebot.group_events FROM linebot_app;
REVOKE SELECT,INSERT,UPDATE ON TABLE linebot.topics,linebot.group_settings FROM linebot_app;
COMMIT;
