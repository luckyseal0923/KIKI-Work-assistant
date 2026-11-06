-- 先將 ASSISTANT_WORKSPACE_ENABLED=false 並部署，再視需要由擁有者執行。
-- 保留四個新表、已確認工作與變更歷史；不動共享物件或舊表 ACL。
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
REVOKE SELECT,INSERT,UPDATE ON TABLE linebot.assistant_context,linebot.work_items,linebot.work_proposals FROM linebot_app;
REVOKE SELECT,INSERT ON TABLE linebot.work_events FROM linebot_app;
COMMIT;
