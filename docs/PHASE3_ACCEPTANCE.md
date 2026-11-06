# 第三階段驗收：自然語言交辦

日期：2026-11-06，Asia/Taipei。此紀錄只保存版本、設定與驗證結果，不含秘密、群組 ID、成員 ID 或真實群組討論內容。

## 已驗證的部署

- 應用版本：`418107ca724e689efda09356515e88df87226405`，分支 `codex/kiki-phase1`。
- 先以自然語言功能關閉的設定部署，再由既有 schema 擁有者執行 `004_freeform_assistant.sql`，已確認 COMMIT。
- 遷移只增加既有 `linebot.assistant_jobs` 的 `request_offset`、CHECK 與一個預算索引；未增加角色、ACL 或外部系統權限。
- 在正式容器使用 `ASSISTANT_FREEFORM_ENABLED=true` 分別執行設定檢查與 `npm run db:check`，皆為 `ok=true`；issues、externalTables、externalDefiners、memberships、writableSchemas 均為空。
- Production 設定 `ASSISTANT_FREEFORM_ENABLED=true`，Literal、Runtime 開啟，Build time 關閉。沿用既有 OpenAI 金鑰、LINE 權杖及管理者設定。
- 啟用部署 `vmo49xaiyzwalbjkv4zwoto3` 已建立新容器 `kiki-ziytzw1ubnlt3yqkmxuunykt-20261106T144920`。
- 22:49:27 啟動日誌：`database_audit_passed`、`mode=record`、`assistant_enabled=true`、`freeform_enabled=true`。
- 22:50:24 公開 HTTPS `/healthz` 與 `/readyz` 均為 200，本文檢查未繞過 TLS 驗證。

## 本機測試

初版完整 `npm test`：55 項通過。歷史擴充後完整測試：62 項通過、0 失敗；最新邊界修正另通過 28 項相關測試。皆使用合成資料、PGlite 與模擬外部 HTTP。除一般問答、改寫、額度、真正標記、取消、去重與權限外，另涵蓋歷史舊日來源、主題代碼強制篩選、日期格式與訊息期間，以及 100 則上限與總數下限標示。

本機測試不等於真實 OpenAI 與 LINE 驗收。

## 真實 LINE 驗收

初版一般問答與公告改寫已實測通過。主題整理的文字正確，但初版未精確限制主題來源，已修正；另依使用者要求新增歷史查找。修正版的主題、歷史及日期行程實測仍待完成。

| 類型 | 工作建立時間（臺北） | 使用者回報與後台核對 |
| --- | --- | --- |
| 一般問答：SMART 目標 | 23:34:34.037 | 使用者貼回一句話，正確涵蓋具體、可衡量、可達成、相關、有時限；工作為 sent、attempt_count=1、短期 token 已清除、message_count=0 |
| 附文公告改寫 | 23:36:20.951 | 使用者貼回正式公告草稿，保留合成代碼及明日下午 2 時；工作為 sent、attempt_count=1、短期 token 已清除、message_count=0；input/output tokens 1,192/102 |
| 主題會議紀錄初次測試 | 23:38:03.926 | 決議、待確認、角色及期限正確，但選入 4 則；唯讀比對確認同日非命令候選 4 則、精確主題僅 1 則，不能當成主題隔離通過；input/output tokens 1,416/130 |

此工作以原始要求內的 SMART 合成主題對應，查詢只輸出工作狀態與用量，不輸出訊息原文或識別值。API 合計 input tokens 1,138、output tokens 80；message_count=0 與本機獨立要求不讀群組歷史的測試相符。

修正：由程式從要求擷取明確主題代碼，固定限制來源，不再只依模型可省略的 keyword；日期行程查找採由程式驗證的月／日比對，不把行程日期當成貼出日期或外部行事曆要求。歷史查找沿用現有表與權限，無新增 SQL 遷移。

## 使用範圍

仍只有既定管理者在原允許群真正標記 KIKI 可啟動。每日最多 20 次 AI 要求、間隔至少 30 秒，與原摘要、待辦共用；自由要求通常包含用途判斷與產生回答兩次 API 請求。

每次要求獨立；改寫時請附原文。群組查找可讀本群開始收錄後仍保存的歷史文字，最多選入 100 則並受總長限制，不能補讀加入前的 LINE 歷史。沒有寄信、外部行事曆、其他系統操作或即時網路查詢；未增加這些權限。完整操作與停用方式見 [自然語言交辦說明](FREEFORM_ASSISTANT.md)。

## 本機證據

以下檔案位於不提交 GitHub 的 `outputs/`：

- `phase3-synthetic-tests-20261106.log`：55 項本機測試。
- `phase3-migration-004-commit-20261106.png`：遷移 COMMIT。
- `phase3-config-and-database-check-20261106.png`：正式設定與專用帳號資料庫檢查。
- `phase3-freeform-enabled-20261106.png`：啟用後的啟動日誌。
- `phase3-general-question-job-20261106.png`：依 SMART 主題對應的一般問題工作與用量。
- `phase3-enabled-health-20261106.json`：HTTPS 健康及就緒結果。
- `phase3-complete-before-after-20261106.md`：本次程式修改前後完整對照。
