# 第二階段：管理者標記 KIKI，取得今日摘要與待辦

2026-11-06：程式已完成本機合成測試；本文件不是正式雲端啟用或真實 API 驗收證明。預設 `ASSISTANT_ENABLED=false`，原單群收訊繼續運作。

## 使用方式

管理者本人在原允許的 LINE 測試群輸入 `@`，從成員清單選取 KIKI，再加指令。只打字寫出「@KIKI」不算真正標記。

| 指令 | 行為 | 呼叫 AI |
| --- | --- | --- |
| `幫助` | 顯示指令與範圍 | 否 |
| `狀態` | 今日已保存訊息與已接受整理請求數 | 否 |
| `今日摘要` | 重點、明確結論、待辦 | 有可整理內容時 |
| `今日待辦` | 待辦、明確指定的負責人及期限 | 有可整理內容時 |
| `今日摘要 OSCE` | 僅整理含關鍵字的當日文字 | 有可整理內容時 |

其他成員與其他群組不能觸發回覆；日常文字仍依原規則保存。這一版不執行任意任務，不主動發通知、不新增行事曆、不寄信。回覆出現在群組中，所有群組成員可見。

## OpenAI 的使用方式

KIKI 的流程已由程式固定：驗證管理者 → 查本群當日文字 → 整理 → 回覆原群。直接呼叫 [Responses API](https://developers.openai.com/api/docs/guides/text) 即可，不必在平台 Agents 頁新增代理人、連 Gmail 或 MCP，也不會帶入截圖中的網路搜尋設定。

預設 [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)，`reasoning.effort=none` 與 [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。每次固定 `store:false`、不提供工具、最多 3,000 輸出 token。費用依 API 專案當時方案與使用量計算；每日請求上限不是帳務金額硬上限。

## 三個需要本人填入的欄位

在 Coolify → KIKI_workassistant → Environment Variables 的 **Production** 填入。不要貼入聊天、截圖、原始碼或終端指令。三欄皆設 Literal、Runtime 開啟、Build time 關閉，秘密欄位保持遮罩。

| 名稱 | 來源 |
| --- | --- |
| `OPENAI_API_KEY` | 使用者已有的 OpenAI 專案 API 金鑰 |
| `LINE_CHANNEL_ACCESS_TOKEN` | 同一個 KIKI Messaging API channel 的有效 access token；與 Channel secret 不同 |
| `OPERATOR_USER_ID` | 同一 LINE channel → Basic settings → Your user ID；本人 `U` 開頭的 User ID |

自己的 User ID 不是顯示名稱、可搜尋的 LINE ID，也不是機器人 User ID。[LINE 官方說明](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)。Access token 可使用現有有效 token；尚未建立時由本人於同一 channel 的 Messaging API 頁建立，[官方 token 說明](https://developers.line.biz/en/docs/basics/channel-access-token/)。不要撤銷其他服務正在使用的 token。

## 部署與驗收順序

1. 保持 `ASSISTANT_ENABLED=false` 部署新程式，確認 `/healthz`、`/readyz` 與受限帳號 `npm run db:check` 通過。此時不會呼叫 AI 或回覆 LINE。
2. 執行 [003_assistant_jobs.sql](../migrations/003_assistant_jobs.sql)。只新增 `linebot.assistant_jobs`、三個索引、RLS 與此表對 `linebot_app` 的 SELECT/INSERT/UPDATE；撤去此新表對 PUBLIC、anon、authenticated、service_role 的授權。不改既有共享 `net` ACL、登入或其他系統資料。
3. 本人填妥上述三欄。預設 `OPENAI_MODEL=gpt-6-luna`、`ASSISTANT_MAX_MESSAGES=100`、`ASSISTANT_DAILY_LIMIT=20`、`ASSISTANT_COOLDOWN_SECONDS=30`。
4. 於取得新 runtime 設定的容器執行以下檢查；只輸出是否齊全、模型、上限或缺少的欄位名稱，不顯示秘密：

   ```sh
   ASSISTANT_ENABLED=true node scripts/check-assistant-config.js
   ASSISTANT_ENABLED=true npm run db:check
   ```

5. 確認已取得本群文字送交 OpenAI 並回覆原群的授權後，Production `ASSISTANT_ENABLED=true` 並重新部署。啟動會再次稽核新表權限；不通過即拒絕啟動。
6. 本人先送真正標記的 `幫助`、`狀態`，再以合成討論測 `今日摘要`。核對原始訊息、引用時間、結論與待辦。其他成員、未真正標記、其他群組不得觸發。本機通過不等於雲端端到端驗收。

Coolify 重新讀 Compose 可能自動建立變數，填入秘密前先確認三欄 Build time 關閉。設定與新表尚未檢查時保持旗標關閉。

## 資料範圍與限制

- 依 Asia/Taipei 當天 00:00 到次日 00:00；以查詢時已收到、原允許群、目前仍保存的文字為限。沒有加入前歷史，沒有圖片或音訊。
- 最多最近 100 則，每則先節錄到 2,000 個字元，全批最多 22,000 個 UTF-16 單位。超出會標示部分訊息／長文節錄，不宣稱完整全日。關鍵字是文字包含比對。
- OpenAI 輸入只有本次 M 編號、時間、文字與範圍資訊；不另送群組 ID、發言者 ID 或秘密。文字本身仍可能包含人名或個資，試辦先用合成內容。
- 每項引用 M 編號及時間；只有明確決議列入結論。負責人與期限未明確寫出則「未指定」，不依發言者 ID 推論人名，不把提案當完成事項。
- 發送 AI 前與回覆 LINE 前重查來源；命令或選入來源修改／收回時取消發布。檢查與實際發送間仍有短暫時間差；已送出的摘要不能隨日後來源收回而自動消失。未來摘要排除已收回文字。
- `store:false` 不是 OpenAI 零保留保證，仍依專案實際政策。KIKI 不另存 AI 輸入快照或生成結果。[官方資料控制說明](https://developers.openai.com/api/docs/guides/your-data)。
- 工作表保存狀態、來源雜湊、群組與管理者識別、指令關鍵字、統計及短期加密 reply token；完成、取消或到期後清除 token。避免在關鍵字中放病人識別資料。
- 每群每日最多接受 20 次整理，間隔至少 30 秒；空內容、失敗與取消的已接受請求也計數，以保守控制次數。幫助、狀態不使用 AI，這不是每月費用硬上限。
- 工作有效期 45 秒，每項只嘗試一次 AI 與一次 LINE 回覆，不自動重試不確定是否計費或送達的請求。重送 webhook 不重複排程；當機或逾時可能沒有回覆，需本人重新送新指令。
- Webhook 在訊息與工作一起提交成功後回覆，不等待 AI。原簽章、指定群組、撤回防復活與儲存失敗回 503 等規則保留。

## 停用與本機驗證

Production `ASSISTANT_ENABLED=false` 並重新部署，再核對健康及收訊；不再排新工作或呼叫 AI／回覆 LINE。保留新表供查核，不刪原文字、撤回紀錄或共用權限。

2026-11-06 `npm test`：44 項通過、0 失敗。涵蓋原收訊、管理者真標記、臺北跨日、加密 token、權限、原子排程、持久化額度、去重、來源取消、文字上限與 webhook 不等待 AI。

測試使用合成資料、PGlite 與模擬 OpenAI／LINE HTTP，沒有正式金鑰或群組發訊。實際 API 模型權限、額度、LINE token 與端到端回覆仍待驗證。
