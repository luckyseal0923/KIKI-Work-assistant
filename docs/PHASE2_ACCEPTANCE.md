# 第二階段實際驗收：管理者指令、摘要與待辦

日期：2026-11-06，Asia/Taipei。此紀錄區分本機測試、正式部署與使用者在 LINE 的實際結果，不含密碼、金鑰、群組 ID、成員 ID 或真實群組討論內容。

## 結果與版本

原允許測試群的「幫助、狀態、今日摘要、今日待辦」四項均實測通過。摘要與待辦只整理一則特別標記的合成討論；使用者貼回的結果與工作表、應用日誌相互符合。

- 實測應用版本：`1f08b921eca497f09e33dae751b12394508e3f85`，分支 `codex/kiki-phase1`。
- 正式設定：`APP_MODE=record`、`ASSISTANT_ENABLED=true`、`OPENAI_MODEL=gpt-6-luna`。
- 每日接受整理上限 20 次、間隔至少 30 秒、最多選入 100 則且受總文字長度限制。
- 啟用部署：`avscctq30hykjac8amfuqyez`，成功，耗時 16 秒；容器 `kiki-ziytzw1ubnlt3yqkmxuunykt-20261106T141444`。
- 22:14:50 啟動日誌同時顯示 `database_audit_passed`、`mode=record` 與 `assistant_enabled=true`。

以下是此版本的實際功能證據。後續僅更新文件的提交不改應用程式；文件提交後的部署與健康狀態另以當次交付紀錄核對，不把推送視為部署完成。

## 四個指令

| 指令 | LINE 成功回覆時間（臺北） | 核對結果 |
| --- | --- | --- |
| 幫助 | 22:17:16 | 使用者確認並提供畫面；顯示四個指令與範圍，不呼叫 AI |
| 今日摘要＋合成測試關鍵字 | 22:19:02 | 符合範圍及選入均為 1 則；重點、明確結論、待辦與 M1 時間引用正確 |
| 狀態 | 22:20:28 | 使用者貼回今日保存 4 則、當時已接受 1 次整理、上限 20；此時待辦指令尚未送出 |
| 今日待辦＋同一關鍵字 | 22:20:46 | 正確列出整理課程清單、明確指定的測試角色與原文期限，未自行換算日期 |

合成討論的已知條件為：決議先辦教學測試，測試角色甲負責整理課程清單，期限為「明天中午」。使用者貼回的摘要、待辦均符合這些條件，並引用合成原文的 22:18。

四項工作在 `linebot.assistant_jobs` 都為 `sent`、`attempt_count=1`、`encrypted_reply_token IS NULL=true`。這證明本次四項成功工作只各嘗試一次並清除短期 token；不代表已做真實 webhook 重送或所有故障情境測試。

| AI 工作 | 選入訊息 | input tokens | output tokens |
| --- | ---: | ---: | ---: |
| 今日摘要 | 1 | 579 | 106 |
| 今日待辦 | 1 | 579 | 72 |

以上為 API 回傳後保存的用量，不是帳務金額。幫助與狀態不走 AI 路徑。

## 設定與資料庫

使用者本人在 Coolify Production 填入 OpenAI 金鑰、KIKI 的 LINE access token 與自己的 User ID。三欄為 Literal、Runtime 開啟、Build time 關閉；助手未讀取或輸出其值。重新部署後，設定檢查只輸出齊全與否、模型及上限，結果通過。

已依明確授權執行 `migrations/003_assistant_jobs.sql` 並確認 COMMIT。新增物件只有 `linebot.assistant_jobs`、其三個工作索引與 RLS policy；未執行新的共享 `net` ACL 變更。

新表的實際表授權查詢只有兩個 grantee：

| 角色 | 新表權限 |
| --- | --- |
| `linebot_app` | INSERT、SELECT、UPDATE |
| `supabase_admin`（既有擁有者） | 擁有者的完整表權限 |

`relrowsecurity=true`，policy 為 `linebot_app_access`、角色僅 `linebot_app`、命令 ALL。專用應用角色不是新表擁有者。以真正應用帳號執行含新表的 `ASSISTANT_ENABLED=true npm run db:check`，結果 `ok=true`；issues、externalTables、externalDefiners、memberships、writableSchemas 均為空。

遷移中的復原紀錄：第一次逐字輸入中斷，清空尚未執行的 CREATE 緩衝區並 ROLLBACK；之後以 `postgres` 執行時，被 schema CREATE 權限拒絕，亦明確 ROLLBACK。唯讀核對擁有者為既有 `supabase_admin` 後，使用該既有角色套用完整原 SQL 並 COMMIT。沒有為此替 `postgres` 或 `linebot_app` 升權。

22:16:51 後的公開 HTTPS 檢查：`/healthz=200`、`/readyz=200`，未簽章的空 `/webhook` 請求為 401。這些檢查與真實 LINE 指令結果分別保存。

## 驗證邊界與使用限制

- 本機 `npm test` 共 44 項通過、0 失敗，使用 PGlite、合成事件與模擬外部 HTTP；之後才另做本文件的真實 API、LINE 與受限帳號驗收。
- 真實雲端已驗證設定的管理者可使用四個指令。其他成員、其他群組、純文字假標記、重送、處理期間編輯／收回、額度與跨日等情境，本階段以本機測試為證據，未宣稱都做過真實群組測試。
- 第一階段原文入庫與同一則收回已有獨立實測；本次沒有再測 AI 處理當下的收回競爭情境。
- 只有已收到、仍保存的當日文字可整理；超出上限會標示部分內容。`store:false` 不等於供應商零保留。
- 原文日後收回，不會自動刪除已發到 LINE 的摘要；未來整理會排除已收回原文。
- 目前只接受固定四個指令與摘要／待辦的可選關鍵字，不操作郵件、行事曆或其他系統，也不執行任意任務。
- 停用方式：Production `ASSISTANT_ENABLED=false` 並重新部署、核對健康與收訊；保留工作表供查核，毋須刪除資料或改共享權限。

## 本機證據位置

`outputs/` 不提交 GitHub，也不包含在來源 ZIP。原專案工作目錄內的檔案包括：

- `phase2-synthetic-tests-20261106.log`：44 項本機測試。
- `phase2-config-check-20261106.png`：設定齊全檢查，沒有秘密值。
- `phase2-migration-003-commit-20261106.png`、`phase2-assistant-jobs-acl-20261106.png`：COMMIT、RLS 與精確新表授權。
- `phase2-enabled-database-audit-20261106.png`：實際應用帳號含新表的稽核。
- `phase2-enabled-health-20261106.json`：啟用後 HTTPS 檢查。
- `phase2-four-command-jobs-20261106.png`、`phase2-four-command-logs-20261106.png`：四個工作成功、嘗試次數、用量與 token 清除。
- `phase2-activation-execution-20261106.json`：執行與驗收摘要，不含秘密或聊天識別值。
