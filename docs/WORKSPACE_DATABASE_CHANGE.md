# 005 資料庫變更與復原範圍

2026-11-07，本機已測試；正式執行另記錄。執行者為既有 `linebot` schema 擁有者 `supabase_admin`，應用仍是受限的 `linebot_app`。

## 精確影響

| 物件 | 變更 | 應用權限 |
| --- | --- | --- |
| linebot.assistant_context | 新增短期對話快取表與 RLS | SELECT / INSERT / UPDATE |
| linebot.work_items | 新增正式工作最新版本表與 RLS | SELECT / INSERT / UPDATE |
| linebot.work_proposals | 新增待確認提案表與 RLS | SELECT / INSERT / UPDATE |
| linebot.work_events | 新增正式變更歷程表與 RLS | SELECT / INSERT；無 UPDATE / DELETE |
| linebot.assistant_jobs | 新增 nullable model_name、api_call_count（0～2）及擴充 kind / request_offset CHECK | 不改既有 ACL |
| linebot.messages | 新增 messages_group_quote_idx、messages_group_effective_idx | 不改資料與 ACL |

新表另有工作群組排序、待確認提案索引與表內主鍵／唯一／外鍵限制。四個新表只授予上述精確權限；撤銷這四表可能由預設權限帶入的 PUBLIC、anon、authenticated、service_role 與 linebot_app 授權後再給最小權限。此 REVOKE 僅涵蓋四個新增表，沒有全域權限重設、沒有動既有 net 物件或任何其他應用表。RLS 使用既有受限角色模式；群組／管理者邊界仍由應用驗證，非每位 LINE 使用者各有資料庫登入。

不新增角色、登入、角色成員、sequence、extension、security definer、對外 API 工具或公網資料庫連接埠。不更改共享 stack、其他角色有效權限、既有網路或密碼。

## 套用與核對

完整可貼 SQL：[005_workspace.sql](../migrations/005_workspace.sql)。內含 BEGIN／COMMIT、lock_timeout 1 秒、statement_timeout 5 秒。索引建立及 CHECK 更換會短暫占鎖；大量歷史資料可能超時，交易失敗須確認 ROLLBACK 後停下評估，不移除逾時保護硬套。

套用前核對四個物件尚未存在；若已存在但來源不明，不能直接視為本版建立，先確認欄位、擁有者與 ACL。已確認為此遷移的相同物件可重複執行，本機已測兩次。

套用後用 `linebot_app` 執行 `ASSISTANT_WORKSPACE_ENABLED=true npm run db:check`，確認四表 RLS、精確寫入權限、不可刪除、歷程不可修改、欄位存在及既有跨 schema 隔離檢查，再啟用。

未驗證依賴：正式資料量下的索引耗時、其他共享服務的併發占鎖，以及是否有未盤點服務原本自行依賴同名未建立物件。只調整本應用 schema 並設定短逾時可限制影響，不能宣稱已排除所有外部依賴。

## 停用／復原

優先把 `ASSISTANT_WORKSPACE_ENABLED=false` 重新部署，恢復既有自由問答／歷史查找路徑。新欄位與擴充 CHECK 對舊程式相容，不必刪工作表或回寫聊天資料。

需撤銷新增應用存取時，確認新旗標已關閉，再由擁有者執行 [005_workspace_disable_acl.sql](../migrations/005_workspace_disable_acl.sql)。此完整 SQL 只撤銷四個新表的新增 app 權限，保留表、工作、快取結構與歷程；不影響舊表 ACL。這是保留資料的功能停用，並非把 schema 完全刪回 004。

重新啟用前，重新套用經核對的 005、通過新旗標稽核後再開旗標。若要刪除表、索引或已確認紀錄，另列精確影響評估，不以本版復原腳本代為刪除。
