-- 由既有 linebot schema 擁有者執行；不增加角色、ACL 或外部系統權限。
-- request_offset 只記錄原始文字中真正標記結束的 UTF-16 位置，不複製使用者要求。
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
ALTER TABLE linebot.assistant_jobs ADD COLUMN IF NOT EXISTS request_offset integer;
ALTER TABLE linebot.assistant_jobs DROP CONSTRAINT IF EXISTS assistant_jobs_kind_check;
ALTER TABLE linebot.assistant_jobs ADD CONSTRAINT assistant_jobs_kind_check
  CHECK (kind IN ('help','status','summary','todos','assist','unsupported','rate_limited'));
ALTER TABLE linebot.assistant_jobs DROP CONSTRAINT IF EXISTS assistant_jobs_request_offset_check;
ALTER TABLE linebot.assistant_jobs ADD CONSTRAINT assistant_jobs_request_offset_check
  CHECK ((kind = 'assist' AND request_offset IS NOT NULL AND request_offset BETWEEN 1 AND 8000)
      OR (kind <> 'assist' AND request_offset IS NULL));
-- 保留舊索引，讓尚在切換的舊版本仍可使用；新請求共用同一每日預算。
CREATE INDEX IF NOT EXISTS assistant_jobs_ai_budget_idx
  ON linebot.assistant_jobs(group_id,created_at) WHERE kind IN ('summary','todos','assist');
COMMIT;
