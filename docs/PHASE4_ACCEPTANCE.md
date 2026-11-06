# 第四階段驗證：對話、工作與用量控制

2026-11-07。狀態：本機實作與合成測試完成，正式部署、005 COMMIT、新旗標稽核及啟用均已完成；真實 LINE 合成流程驗收中。先前階段已驗收能力不代表本階段的每個情境也已端到端通過。

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

完整 `npm test`：85 項通過、0 失敗，使用合成資料、PGlite 與模擬外部 API；結果另存 `outputs/phase4-workspace-synthetic-tests-20261107.log`。新測試檔 `test/workspace.test.js` 含 23 項測試。第一次受限沙箱執行有 10 項無法連本機測試 HTTP，允許 loopback 後整套通過；不是正式 LINE 或 OpenAI 測試。最新涵蓋：

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

## 真實 LINE 驗收待辦

1. 已完成：旗標關閉部署、核對版本與健康，執行經核對的 005 並記錄 COMMIT。
2. 已完成：容器設定檢查與新旗標 `db:check` 通過後啟用，核對新容器日誌與就緒。
3. 原測試群真標記：合成主題整理 → 再短一點，核對連續來源與實際 API 次數／tokens。
4. 新合成待辦 → 完整提案 → 確認 → 工作清單 → 這件事完成了 → 新提案 → 再確認；核對 DB 版本、歷程與未確認前無變更。
5. 合成歷史主題 → 再找更早的，核對主題沿用與來源時間。沒有早於加入時間的實際 archive，不能宣稱查回加入前內容。
6. 狀態顯示用量估算、原文收回不沿用快取；真實不同帳號與跨月份大量資料仍另安排，不以合成角色代替。

完整操作見 [工作秘書說明](WORKSPACE_ASSISTANT.md)，權限與復原見 [005 變更說明](WORKSPACE_DATABASE_CHANGE.md)。

## 省略主詞與多輪追問修正

使用者截圖顯示「是由誰負責」被要求重新指定工作，未通過接續驗收。原因包括省略主詞問法沒有載入上下文，及每次快取只保留上一個要求而可能丟失起始交辦／待確認提案關聯。

修正辨識負責人、期限等短問句；保留本段起始交辦與最多八輪要求的來源指標、待確認提案關聯，模型僅收到有限起始交辦／最近要求／上一答與精選來源。來源收回時整段上下文失效，發布前重新核對；後續工作提案也保留這些來源依據。多筆工作不猜目標。整套 85 項合成測試通過，其中工作秘書相關 23 項；新增多輪問答、識別值不外送、來源處理中收回不發布、八輪界線及修訂提案來源依據驗證。尚須部署並重做真實追問。
