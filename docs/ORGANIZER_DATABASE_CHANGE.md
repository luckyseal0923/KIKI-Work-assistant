# 006 精確資料庫影響與停用

2026-11-07：尚未在正式資料庫執行。唯讀核對確認五表皆不存在，執行者與 linebot schema 擁有者均為 supabase_admin，已 ROLLBACK 結束唯讀交易。完整 SQL：[006_cards_topics.sql](../migrations/006_cards_topics.sql)。現有正式版基準為 efd91ec；新旗標皆預設關閉。

| 物件 | 變更 | linebot_app 權限 |
| --- | --- | --- |
| linebot.assistant_actions | 新表、RLS、按鈕操作來源 | SELECT / INSERT |
| linebot.topics | 新表、RLS、主題定義與群內名稱唯一索引 | SELECT / INSERT / UPDATE |
| linebot.topic_events | 新表、RLS、主題不可改寫歷程 | SELECT / INSERT |
| linebot.group_settings | 新表、RLS、啟用設定與版本 | SELECT / INSERT / UPDATE |
| linebot.group_events | 新表、RLS、群組設定不可改寫歷程 | SELECT / INSERT |
| linebot.assistant_jobs | source_kind/source_action_id、按鈕來源唯一索引、source_message_id 改 nullable、來源及 request_offset CHECK | 既有 ACL 不變 |
| linebot.work_items | nullable topic_code 外鍵與群內主題排序索引 | 既有 ACL 不變 |

只在五個新表移除 PUBLIC、anon、authenticated、service_role、linebot_app 的預設權限，再授予表中列出的最小權限。五表皆無 DELETE，三個操作／歷程表無 UPDATE。不改其他既有表 ACL、共享 net 物件、角色成員、登入、密碼、網路、序列或擴充套件。

RLS 沿用現有應用受限角色模式（linebot_app policy true）；每群隔離由驗簽、固定管理者、群組設定與所有資料查詢的群組條件實施，不宣稱每群使用各自資料庫帳號或資料庫層的列隔離。共用額度只在 KIKI 工作佇列跨群計數；群組清單僅在原管理群顯示名稱與設定，不提供別群文字或工作。

## 上線順序

1. 核對五個新表尚未存在、既有 schema 擁有者及部署基準；存在來源不明的同名物件時停止評估。
2. 更新程式碼但保持 `ASSISTANT_ORGANIZER_ENABLED=false`、`ASSISTANT_MULTI_GROUP_ENABLED=false`。
3. 由既有擁有者 supabase_admin 套用 006 並 COMMIT；交易設 lock_timeout 1 秒、statement_timeout 5 秒。失敗回滾，不能移除短逾時硬套。
4. 以應用帳號及新旗標跑 `db:check`、設定檢查及 LINE 合成 Flex schema 驗證。
5. 啟用 organizer 與 multi-group，`ASSISTANT_MAX_GROUPS=3`；沿用原管理者、原管理群、20 次／30 秒、既有 OpenAI 模型與金鑰。啟動時僅補入原本已允許群的設定，不自動啟用其他群。
6. 原群先測卡片、提案確認、來源及主題，再由管理者在新群申請、預覽、確認，核對實際入庫與隔離。

006 本機重複執行已測，欄位預設與 CHECK 相容舊版文字工作。建立索引與更換 CHECK 會短暫占鎖；未驗證正式大量資料下的耗時、其他共享服務併發與未盤點的同名物件依賴。沒有查讀其他服務資料。

## 停用與復原

優先關閉 multi-group 與 organizer 重新部署，保留新表、紀錄、欄位、索引及歷程，恢復原管理群的既有功能；其他群停止新一般收錄與操作。關閉多群旗標是整體功能停用；個別群日常停用請使用「停用本群」提案，才能繼續接收該群舊訊息的隱私事件。

若需撤銷新應用權限，在兩旗標已關閉並確認部署後，執行 [006_cards_topics_disable_acl.sql](../migrations/006_cards_topics_disable_acl.sql)。只撤銷五個新表新增的 app 權限，不刪資料、不改舊 ACL。含按鈕來源的工作在 organizer 關閉時會顯示來源待確認，重新套用經核對的 006、稽核通過並啟用後才恢復驗證。

不將 source_message_id 改回 NOT NULL，也不移除新欄位或刪除操作紀錄，因為已確認工作可能引用按鈕來源。若要永久移除資料或跨群搬遷，需另列精確範圍。
