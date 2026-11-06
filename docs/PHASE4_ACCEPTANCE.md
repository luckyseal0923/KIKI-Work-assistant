# 第四階段驗證：對話、工作與用量控制

2026-11-07。狀態：本機實作與合成測試完成，正式部署、005 COMMIT、新旗標稽核及啟用均已完成；本版核心真實 LINE 合成流程已通過：明確交辦、連續追問、確認／清單、完成／歷程與跨日較早查找。應用程式實測版本為 5ac6b8204828a428dddd5ab0958687e2ea38f961；之後只補較早結果的文字澄清及本驗收文件。真實多帳號、跨月大量資料與處理中收回等仍是合成測試邊界，未宣稱全數真實重演。

## 已驗證的正式部署

- 程式版本 `9b78eb683b8ea0c981464a203eed9c023bbdad56`。
- 關閉新旗標部署 `ipu6iah7u33uykbjbakk8upg` 成功，15 秒；容器 `kiki-ziytzw1ubnlt3yqkmxuunykt-20261106T170710`。設定 workspace=false，舊表路徑 db:check 通過。
- 005 由既有 supabase_admin 以 ON_ERROR_STOP 執行完整 SQL，畫面確認 COMMIT，返回 shell，無未結束交易。沒有更改其他共享物件。
- 新容器暫設 workspace=true 的設定檢查顯示 Luna、20 則／12,000 字元、每日 20；db:check 的 issues、externalTables、externalDefiners、memberships、writableSchemas 皆空，ok=true。
- Production workspace 旗標設 true、Literal／Runtime，Buildtime 關閉後，啟用部署 `hqbzrleajy2wreo1wwt4y6kk` 成功，17 秒；容器 `kiki-ziytzw1ubnlt3yqkmxuunykt-20261106T171103`。
- 啟動日誌 `2026-11-06T17:11:09.987Z` database_audit_passed；`17:11:09.994Z` record、assistant=true、freeform=true、workspace=true。UTC 日期與本地 11/07 不同。
- HTTPS /healthz 與 /readyz 皆 200、ok=true。這只證明健康與就緒，不代表真實問答與工作確認已驗收。

本機證據：outputs/phase4-disabled-config-audit-20261107.png、phase4-migration-005-commit-20261107.png、phase4-workspace-config-audit-20261107.png、phase4-workspace-enabled-20261107.png、phase4-enabled-health-20261107.json。

## 本機證據

完整 `npm test`：87 項通過、0 失敗，使用合成資料、PGlite 與模擬外部 API；結果另存 `outputs/phase4-workspace-synthetic-tests-20261107.log`。新測試檔 `test/workspace.test.js` 含 25 項測試。第一次受限沙箱執行有 10 項無法連本機測試 HTTP，允許 loopback 後整套通過；不是正式 LINE 或 OpenAI 測試。最新涵蓋：

- 旗標預設關閉、須依賴既有旗標；來源與提案共用文字量上限；嚴格 JSON、相關詞及非法範圍拒絕。
- 005 重複套用、RLS／權限、無刪除、歷程只可新增，以及其他角色拒絕。
- 未確認不建立正式工作、明確確認一次、不同管理者拒絕、到期／取消／收回拒絕、版本衝突與完全重複紀錄阻擋。
- 狀態更新保留原相對期限、缺依據不發明負責人、預覽過長不存提案。
- 合成不同真實 User ID 與兩層引用回覆串接，API payload 不含原始 ID／金鑰。
- 60 天前較相關內容排序優先、精選數量與長度上限、更早查找沿用主題與嚴格時間截止點。
- 快取過期、重置、來源收回與工作版本變更；清記憶不刪 archive。
- 模擬完整工作流程：新提案 2 次 API → 確認 0 次 → 單筆完成追問 1 次 → 再確認 0 次；每次確認前正式狀態不變。
- 提案修訂取代舊代碼、第二次 API 失敗不重試且不假記零費用。
- 正規化日期可找正式行程，已取消狀態優先，收回確認訊息不再曝光歷程正文。

語法檢查與 `git diff --check` 另執行；測試結果不含真實 OpenAI 生成品質、真實 LINE 傳送或正式共享資料庫占鎖表現。

正式套用前唯讀核對：四個新表當時皆不存在，workspace 旗標當時尚未啟用，linebot schema 擁有者為 supabase_admin。隨後依明確授權完成上述正式變更。

## 真實提案初測與修正

合成主題 KIKI-WORK-20261107-01：使用者要求由測試角色丁負責，但初版提案 P5C409C92 顯示未指定，因此內容驗收未通過、未要求確認。正式容器唯讀比對 requested_owner_found=true、proposed_owner=null、同主題正式工作 0 筆；工作 sent、attempt_count=1、api_call_count=2、input/output=1310/115、token 已清除。此證據只證明送達與尚未寫入，不能宣稱提案正確。

修正：單一新增動作、本次直接要求只有一個明確「由某人負責」且無條件／否定／歧義時，保留該逐字指定者；若模型給出衝突的對象則停止。條件式、多人多動作不套此補值，仍須人工核對。負責人修正版 94aa8a36c7322183113350eb2867b1f0588fb78f 已部署，部署 cframa1x8yzbmeyrwwvfigjo 成功 17 秒；容器 kiki-ziytzw1ubnlt3yqkmxuunykt-20261106T171627，17:16:34.262Z 稽核通過、17:16:34.268Z workspace=true。

## 真實 LINE 驗收範圍

1. 已完成：旗標關閉部署、核對版本與健康，執行經核對的 005 並記錄 COMMIT。
2. 已完成：容器設定檢查與新旗標 `db:check` 通過後啟用，核對新容器日誌與就緒。
3. 已完成：原群單筆提案後連續問負責人、期限，三輪同一提案、各一次 API。一般草稿「再短一點」仍以模擬 API 測試為證據。
4. 已完成：新合成待辦 → 提案 → 確認 → 清單 → 這件事完成了 → 新提案 → 再確認 → 歷程；DB 兩版、確認前不變更、負責人／期限保留。
5. 已完成：今日摘要「場地」→ 再找更早的，從 11/07 00:06 查到 11/06 23:37，各一則；沒有加入前的 archive，不能宣稱補讀加入前內容。
6. 邊界：新狀態用量估算、原文收回／衝突等主要以本機測試為證據；真實不同帳號與跨月份大量資料未重演，不以合成角色代替。

完整操作見 [工作秘書說明](WORKSPACE_ASSISTANT.md)，權限與復原見 [005 變更說明](WORKSPACE_DATABASE_CHANGE.md)。

## 省略主詞與多輪追問修正

使用者截圖顯示「是由誰負責」被要求重新指定工作，未通過接續驗收。原因包括省略主詞問法沒有載入上下文，及每次快取只保留上一個要求而可能丟失起始交辦／待確認提案關聯。

修正辨識負責人、期限等短問句；保留本段起始交辦與最多八輪要求的來源指標、待確認提案關聯，模型僅收到有限起始交辦／最近要求／上一答與精選來源。來源收回時整段上下文失效，發布前重新核對；後續工作提案也保留這些來源依據。多筆工作不猜目標。整套 87 項合成測試通過，其中工作秘書相關 25 項；新增多輪問答、識別值不外送、來源處理中收回不發布、八輪界線及修訂提案來源依據驗證。追問修正版 628192b50bc05197fd110f22829b55c0a5738cb7 已部署：qycqq5bffk0czekwaihhvlqi 成功 17 秒，啟動 2026-11-06T17:23:11.262Z 稽核通過、17:23:11.272Z workspace=true。該版當時等待下一輪，後續結果與修正版見下文。

## 編號要求與分類失敗修正

使用者重測 KIKI-WORK-20261107-02，實際第一則含「①」。17:26:32.361Z 工作 failed / invalid_ai_output / api_call_count=1，尚未進到提案，該主題提案與正式工作均 0。後續「② 是由誰負責」與「期限呢」因此沒有新提案可接。未保存模型原始輸出，無法追溯當時被拒絕的確切欄位；不能斷言第一則是編號直接造成。另確認既有短句判斷未去除②，須一起修正。

新增僅處理清楚本次新增工作的固定路徑，跳過分類、一次 API 產生提案；依群組來源或真正外部操作仍交由原分類／限制。清單編號在要求處理時正規化，保留原訊息、簽章及 owner 權限驗證，日期不被截去。實際三則編號文字加入模擬完整流程：各 1 次呼叫、產生 1 份待確認提案、正式工作 0。完整 87 項通過，工作秘書相關 25 項。

部署前以原失敗合成要求做一次明確的人工 API 診斷，直接檢查 propose、不發 LINE、不建立工作／提案。先核對唯一合成原文、來源 digest 與 owner/group，再將原 failed 工作的 api_call_count 從 1 保留至 2，計入其第二次 API 使用，狀態仍 failed，不重送 LINE；原分類用量未知，因此總 input/output 保留 NULL，不假記免費。實際診斷成功：1 個動作、owner=測試角色丁、due_at=2026-11-10T04:00:00Z、主題相符、input/output=629/74。此為實際 API 驗證，不等於新版 LINE 完整流程通過。

編號／直接交辦修正版 5ac6b8204828a428dddd5ab0958687e2ea38f961 已部署，oxt6h1i2pyd7r69kuifnrwuh 成功 15 秒，啟動 2026-11-06T17:37:52.934Z 稽核通過、17:37:52.941Z workspace=true。公開 HTTPS 健康與就緒均通過。該部署後的單則交辦及後續工作驗收已通過，詳下文。

### 修正版真實單則提案

P101F1E78（KIKI-WORK-20261107-02）：使用者回報完整提案保留測試角色丁與 2026/11/10 中午。正式 DB 核對 owner 正確、due_at=2026-11-10T04:00:00Z，pending；同主題正式工作仍 0。工作 sent、attempt=1、api_call_count=1、input/output=629/74、短期 reply token 已清除。快取保留同一 proposalCode、起始交辦指標，當時 requestRefs=1。此項單則提案內容通過；後續追問與正式確認結果見下一節。

### 連續追問、確認與完成流程通過

使用者回報「② 是由誰負責」正確回答測試角色丁、「③ 期限呢」正確回答 2026/11/10 中午，兩者皆明示尚未正式確認。DB 核對三輪仍同一 P101F1E78、快取 requestRefs=3 且起始交辦指標存在，正式工作仍 0；三個工作皆 sent、attempt=1、API 各 1 次、reply token 已清除。分別 input/output=629/74、1308/47、1150/48。

管理者在 LINE 確認 P101F1E78 後，正式工作 WBD91AA07 第 1 版 active、歷程 1 筆；工作清單內容相同。這兩個控制工作 API=0。接續「這件事完成了」產生 P30D8EDAF，目標 WBD91AA07、expected_version=1、下一狀態 done、owner 與 due_at 不變；確認前 DB 仍 active / version 1。

管理者確認 P30D8EDAF 後，使用者收到已完成回覆，工作歷程顯示 01:43 未完成、01:45 已完成兩版。DB 核對正式工作恰 1 筆、version=2、done、歷程恰 2 筆、兩提案皆 applied；owner=測試角色丁、due_at=2026-11-10T04:00:00Z 保留。後半段確認／清單／完成提案／再確認／歷程工作皆 sent，API 次數依序 0 / 0 / 1 / 0 / 0，reply token 皆清除。證據：phase4-two-followups-live-20261107.png、phase4-initial-confirmation-live-20261107.png、phase4-completed-work-history-live-20261107.png。

### 跨日較早查找通過

原群「今日摘要 場地」選入 1 則 2026-11-07 00:06 來源；接著「再找更早的」沿用同一字面主題，選入 1 則 2026-11-06 23:37 來源，內容為場地尚未決定等先前合成討論。DB 核對當次 query.keyword=場地、range_start=1970-01-01、range_end=2026-11-06T16:06:50.686Z，選入來源 at=2026-11-06T15:37:44.100Z，確實早於截止點，快取保存兩輪要求指標。

兩工作 sent、attempt=1、message_count=1、input_truncated=false、api_call_count=1、reply token 清除；今日摘要 input/output=572/111，較早查找=1047/90。證據：phase4-earlier-history-live-20261107.png。這證明真實跨日精選查找，不代表已在真實環境驗證數月大資料或查遍所有同義說法。

最後補充結果文字：有較早來源時，由程式明示「已找到 N 則早於前次最早來源的已保存紀錄」，並提示模型不要把已找到的來源寫成「未包含更早內容」。此為文字澄清，沒有更改 SQL 範圍、權限、來源數或額度；發布前仍執行本機回歸，最終部署與健康證據另存本機交付紀錄。
