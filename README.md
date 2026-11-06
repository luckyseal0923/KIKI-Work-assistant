# 綺綺 KIKI｜智慧秘書

Your Intelligent Work Assistant

第一階段：LINE 單群文字收訊端。第二階段：管理者標記 KIKI 後的今日摘要與待辦（預設關閉）。

將一個明確允許的測試群文字，經 LINE 原始本文簽章驗證後，寫入你已建立的共用自架 Supabase `linebot` 區域。部署目標為 Coolify，使用受限的 PostgreSQL 帳號直接連線。

**2026-11-06 已通過原允許測試群的實際 LINE 入庫與收回驗收。** 使用者在 LINE 傳送合成文字後，Supabase 精確匹配 1 則；收回同一則後，文字列為 0、撤回紀錄為 1。KIKI 維持 `record`，私網、受限帳號、`db:check` 與 HTTPS 健康／就緒檢查皆已通過。共享 ACL 調整保留其他 26 個角色的有效權限；專用角色總連線上限 4。詳細證據與尚未驗證範圍見 [第一階段驗收紀錄](docs/PHASE1_ACCEPTANCE.md)。

**2026-11-06 第二階段已啟用，四個指令皆通過真實 LINE 測試。** 管理者真正標記 KIKI 後的「幫助、狀態、今日摘要、今日待辦」均已成功回覆；摘要與待辦使用 OpenAI 整理一則合成討論，決議、負責人、期限與引用時間均符合原文。四項工作各嘗試一次、短期回覆 token 均已清除。正式環境為 `ASSISTANT_ENABLED=true`，原始碼預設仍關閉。驗收版本、資料範圍與尚未實測項目見 [第二階段驗收紀錄](docs/PHASE2_ACCEPTANCE.md)。

正式對外名稱為「綺綺 KIKI｜智慧秘書」，英文副標為「Your Intelligent Work Assistant」；套件、容器映像與其他需要 ASCII 的技術名稱統一使用 `kiki-work-assistant`。使用者指定的 GitHub 儲存庫為 [luckyseal0923/KIKI-Work-assistant](https://github.com/luckyseal0923/KIKI-Work-assistant)，儲存庫名稱維持原樣；本次交付分支為 [`codex/kiki-phase1`](https://github.com/luckyseal0923/KIKI-Work-assistant/tree/codex/kiki-phase1)。既有來源已完成 discover 部署；之後的每次推送仍須個別核對部署結果，不能把程式碼上傳當成新版本已部署。

## 開始方式

1. 依 [逐步部署說明](docs/DEPLOY.md) 建立 Coolify 應用，先用 `APP_MODE=discover`。
2. 在已加入 bot 的測試群送一句合成文字，從受保護日誌取得 `group_candidate` 的群組 ID；這一步不保存文字，也不需要移除再邀請 bot。
3. 套用 `migrations/001_event_safety.sql`，安全設定專用帳號密碼與登入。
4. 安全填入連線設定，改成 `APP_MODE=record`、設定唯一的 `ALLOWED_GROUP_ID`，重新部署。
5. 按部署說明完成群組訊息、編輯、撤回的雲端驗收。

單純收訊不需 Channel access token 或 AI 金鑰。第二階段另需 OpenAI API 金鑰、LINE Channel access token 與管理者自己的 LINE User ID；不使用 Supabase `service_role` 金鑰。部署與驗收順序見 [摘要與待辦設定說明](docs/ASSISTANT_SETUP.md)。`ASSISTANT_ENABLED=false` 時維持原收訊行為，不呼叫 AI 或向 LINE 回覆。

## 本機安裝與測試

建議 Node.js 24 LTS；程式與測試亦已在本機 Node.js 20.20.0 執行。正式容器使用 Node.js 24。

```powershell
npm ci
npm test
```

測試不需要任何正式連線設定；全部使用合成資料與本機記憶體 PostgreSQL 引擎 PGlite。詳見 [驗證紀錄](docs/VALIDATION.md)。

若要在本機手動執行，複製 `.env.example` 為 `.env`，在本機安全編輯，再執行：

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
npm run start:local
```

`.env` 已排除於 Git 與容器建置內容。不要將設定檔、管理員密碼、Channel secret、完整 webhook 或聊天截圖貼入聊天。

## 已實作的收訊行為

| 情況 | 行為 |
| --- | --- |
| 簽章錯誤或缺少簽章 | 回 `401`，不解析事件、不寫入資料 |
| LINE 空事件驗證 | 驗簽成功後回 `200`；不代表資料庫寫入已驗證 |
| discover 模式 | 只從驗簽成功的群組事件記錄群組 ID，不保存原文與發言者 |
| record 模式 | 只保存指定的一個群組；其他群組、私訊、多人聊天室與非文字訊息不保存 |
| 重送 | 以 `webhookEventId` 去重，並以 `message_id` 保持一則訊息一列 |
| 編輯 | 同一列更新成最新 `timestamp` 的文字，不留舊文字版本 |
| 編輯先到 | 原發送時間 `sent_at` 先留 `NULL`；原事件稍後抵達時只補原始時間等資料 |
| 撤回 | 刪除文字列，留下不含文字與發言者的 tombstone，阻止舊重送恢復內容 |
| 資料庫失敗或過載 | 回 `503`；不以成功回應掩蓋失敗 |

每一批事件在同一個資料庫交易中提交；任何一步失敗就整批回滾。撤回與寫入使用相同的訊息狀態列鎖，避免同時到達時讓文字復活。編輯事件時間完全相同時，以事件 ID 的固定字元順序決定結果，讓不同到達順序得到一致結果；這只是平手規則，不能證明使用者實際編輯先後。

## 檔案

| 位置 | 用途 |
| --- | --- |
| `src/` | HTTP 收訊、驗簽、資料庫儲存、設定與啟動檢查 |
| `Dockerfile`、`.dockerignore` | Coolify 容器，使用非管理員帳號，秘密不進映像檔 |
| `compose.yaml` | 只讓 KIKI 同時使用既有對外代理網路與既有 Supabase 私有網路 |
| `.env.example` | 只有欄位，沒有正式秘密 |
| `migrations/001_event_safety.sql` | 增加編輯欄位、去重表與撤回狀態表 |
| `migrations/002_role_login.sql` | 只為既有專用角色開啟登入並限制連線與逾時 |
| `migrations/003_assistant_jobs.sql` | 僅新增 `linebot` 工作佇列與對應受限權限 |
| `scripts/check-database.js` | 以實際應用帳號檢查權限，不讀其他系統內容 |
| `scripts/check-assistant-config.js` | 只回報設定是否齊全，不顯示秘密或管理者 ID |
| `test/` | 關鍵行為的自動測試 |
| `docs/DEPLOY.md` | Coolify、LINE、SQL 與實際驗收步驟 |

本次私有網路部署準備的完整原始碼：[kiki-work-assistant-0.1.0-compose-source.zip](outputs/kiki-work-assistant-0.1.0-compose-source.zip)；[SHA-256 檢查碼](outputs/kiki-work-assistant-0.1.0-compose-source.zip.sha256)。可使用 `scripts/package-source.ps1` 重新建立 ZIP 與檢查碼。壓縮檔僅收錄明確允許的原始碼、測試與文件，不包含秘密設定或 `node_modules`。封裝檔與 `outputs/` 不提交到 GitHub；從 GitHub 取得程式碼後，可在本機執行打包腳本產生上述檔案。

先前交付的 `outputs/line-group-receiver-0.1.0-source.zip`、`outputs/kiki-work-assistant-0.1.0-source.zip`、`outputs/kiki-work-assistant-0.1.0-github-source.zip` 及各自檢查碼仍保留，沒有覆寫。版本維持 `0.1.0`；命名與封裝修改前後段落見 [命名調整紀錄](docs/BRANDING_CHANGE.md) 與 [私有資料庫網路部署說明](docs/PRIVATE_DATABASE.md)。ZIP 解壓後不會包含 `outputs/`，請從原專案的交付位置取得封裝檔。

## 資料與限制

`linebot.messages` 保存目前有效的文字、群組／可缺少的使用者 ID、原發送與接收時間、引用訊息 ID，以及最新編輯時間。時間使用 `timestamptz`，查詢時再轉臺灣時間。原 `webhook_event_id` 不會被後來的編輯事件取代。

`linebot.webhook_events` 只保存已處理的事件 ID 與接收時間；`linebot.message_state` 保存訊息 ID、群組 ID 與撤回時間。為處理「撤回先到」的情況，即使尚未收到原文字，也會建立狀態列；非文字訊息的撤回也可能留下不含內容的狀態列。不要直接刪除 tombstone，否則很晚抵達的舊事件可能恢復內容。

應用程式日誌不記聊天原文、發言者、密碼、token、簽章或完整 webhook。只有識別模式會顯示設定所需的完整群組 ID；記錄模式只記處理數量與固定錯誤代碼。資料庫管理員仍可管理資料，權限檢查也不是應用間絕對隔離的保證。

撤回會清除目前應用資料表中的文字。LINE 重送並不保證每次送達，若撤回事件從未送達，程式無從得知；資料庫既有備份、WAL 與外部平台日誌也需要由管理員依保存政策管理。此階段僅以合成資料試辦。

啟用第二階段後，只有指定管理者在同一測試群真正標記 KIKI 的固定指令會觸發回覆；摘要與待辦會把限量當日文字交給 OpenAI，結果公開回到原群組。不是任意任務代理人，不會操作郵件、行事曆或其他系統。來源在處理期間被收回或修改時會取消發布；已送出的 LINE 摘要不會隨日後來源收回而自動消失。詳見第二階段設定說明。

## 官方依據

- [LINE 原始本文簽章驗證](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [LINE 重送、事件順序與撤回處理](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [LINE 編輯事件與最大 timestamp](https://line.github.io/line-bot-sdk-nodejs/apidocs/@line/namespaces/webhook/type-aliases/MessageEditedEvent.html)
- [Coolify Dockerfile 應用](https://coolify.io/docs/applications/builds/dockerfile)
