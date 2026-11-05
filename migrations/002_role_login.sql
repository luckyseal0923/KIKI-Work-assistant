-- 僅變更已存在、專屬本專案的角色；不含密碼。
-- 以 postgres 執行，再依 docs/DEPLOY.md 於安全終端機使用 \password 設定密碼。
-- 不要把正式密碼寫進 SQL 檔、聊天或 SQL Editor 的查詢歷史。
BEGIN;
ALTER ROLE linebot_app LOGIN CONNECTION LIMIT 4;
ALTER ROLE linebot_app SET search_path = pg_catalog;
ALTER ROLE linebot_app SET statement_timeout = '1000ms';
ALTER ROLE linebot_app SET lock_timeout = '400ms';
ALTER ROLE linebot_app SET idle_in_transaction_session_timeout = '2s';
COMMIT;
