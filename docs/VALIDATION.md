# 綺綺 KIKI｜智慧秘書

Your Intelligent Work Assistant

本機驗證紀錄。

## 2026-11-06 第二階段本機驗證

管理者真正標記 KIKI 後的今日摘要／待辦：`npm test` 共 44 項通過、0 失敗。測試使用合成資料、PGlite、模擬 OpenAI Responses 與 LINE reply；沒有正式金鑰或雲端發訊。涵蓋權限與指定管理者、原子排程、額度、去重、收回／編輯取消、文字上限、背景工作及快速 webhook 回應。測試日誌位於本機 `outputs/phase2-synthetic-tests-20261106.log`。

新功能在原始碼中預設關閉。以上是本機測試範圍；當日晚間另經明確授權執行遷移 003、COMMIT、受限帳號稽核與正式啟用，並完成四個 LINE 指令實際驗收，詳見 [PHASE2_ACCEPTANCE.md](PHASE2_ACCEPTANCE.md)。設定與重新部署順序見 [ASSISTANT_SETUP.md](ASSISTANT_SETUP.md)。

驗證日期：2026-11-05（臺灣）。僅使用合成資料，沒有讀取正式 LINE 內容、連上你的 Supabase，或取得正式秘密。

## 已執行

環境：Windows、Node.js `20.20.0`、npm `10.8.2`。正式 Dockerfile 使用 `node:24-alpine`，正式依賴鎖定於 `package-lock.json`。

```text
npm test
tests 25
pass 25
fail 0
cancelled 0
skipped 0
```

測試包括 16 個頂層案例與其中 9 個資料庫子案例。HTTP 測試使用本機 `127.0.0.1` 暫時連接埠；資料庫測試使用 PGlite `0.5.15` 的 PostgreSQL `18.6` 引擎執行實際 SQL、交易、角色權限與 RLS，沒有連外寫入。

| 驗證 | 結果 |
| --- | --- |
| 原始 bytes HMAC-SHA256、Unicode／換行、缺漏／錯誤簽章與重新序列化 | 通過 |
| 驗簽先於 JSON 解析，未驗簽不能取得群組 ID | 通過 |
| 單一允許群組、略過私訊／多人聊天室／非文字 | 通過 |
| 已入群情境以新訊息識別群組；只記 ID、不寫文字 | 通過 |
| 空事件驗證、錯誤格式、本文大小與壓縮限制 | 通過 |
| 時間、引用 ID、可缺少的 user ID | 通過 |
| 一批提交前不回成功，資料庫失敗回 503，日誌不含錯誤原文 | 通過 |
| 最多 4 批處理中，超載回 503；健康檢查不洩漏資訊且合併探測 | 通過 |
| 增量 migration 重跑、專用角色登入設定與 RLS | 通過 |
| 事件 ID／訊息 ID 去重、參數化保留 SQL 形狀的合成文字 | 通過 |
| 最新編輯、編輯亂序、原始訊息晚到、相同時間固定平手規則 | 通過 |
| 撤回刪除文字、撤回先到、舊訊息／編輯重送不復活 | 通過 |
| 整批失敗回滾含去重紀錄、重新投遞可完整提交 | 通過 |
| 取得連線失敗、回滾失敗丟棄連線、借出連線中斷不造成未處理 error | 通過 |
| 專用角色不能讀隔離測試 schema、不能建表；其他三種角色不能讀 linebot | 通過 |
| 偵測其他 schema 的 PUBLIC 表授權及 SECURITY DEFINER 可執行權 | 通過 |
| 不接受高權限 DB_USER、未確認的無 TLS 連線，預設驗證 TLS | 通過 |

安裝鎖定依賴時 npm audit 回報 `0 vulnerabilities`。這只代表當時套件庫的已知弱點檢查結果，並非完整安全稽核。

另以合成設定啟動實際的 `src/main.js` 程序，完成後立即結束：`/healthz`、`/readyz`、驗簽成功的識別模式 webhook 均回 `200`；映像使用的 `scripts/healthcheck.js` 回傳結束代碼 `0`；日誌有群組識別事件且沒有合成訊息原文。這是本機程序驗證，並非 Docker 映像或雲端驗證。

所有 JavaScript 已通過 `node --check`。已確認 Git 忽略 `.env`、`.env.production`、`secrets/`、`node_modules/`；容器使用明確的檔案白名單。初次交付 ZIP 含 24 個原始碼／設定範例／文件檔案，已檢查不含秘密設定、Git 歷史、套件目錄、金鑰與日誌。

## 本次品牌命名與封裝檢查

2026-11-05 將正式名稱統一為「綺綺 KIKI｜智慧秘書」、英文副標統一為「Your Intelligent Work Assistant」，ASCII 名稱統一為 `kiki-work-assistant`。這次只調整文字與封裝，未重跑整套功能測試；上列 25 項通過是先前功能驗證紀錄。

本次檢查範圍：README 與部署說明的品牌與範例名稱；package 與 lockfile 的名稱、版本和依賴一致性；容器品牌標籤；新 ZIP 的完整來源內容、SHA-256 檢查碼及敏感路徑排除。新 ZIP 含 25 個檔案（新增命名調整紀錄），舊版 ZIP 與原檢查碼保留。收訊邏輯、測試、SQL、資料庫角色、環境變數與 Webhook 路徑未變；僅 PostgreSQL 連線的應用識別標籤 `application_name` 換成新技術名稱，帳號與權限不變。

本機原始碼封裝：[kiki-work-assistant-0.1.0-github-source.zip](../outputs/kiki-work-assistant-0.1.0-github-source.zip)；[SHA-256 檢查碼](../outputs/kiki-work-assistant-0.1.0-github-source.zip.sha256)。連結指向原專案交付目錄，不提交到 GitHub；ZIP 不含自己的封裝檔與檢查碼，先前的封裝版本仍保留。

## GitHub 交付範圍

2026-11-06 新增 KIKI 專用的 `compose.yaml`，供同時使用既有代理網路與已確認的 Supabase 私有網路。已完成 YAML 語法、單一服務、外部網路、無主機 port／敏感掛載、原應用環境介面與原 Dockerfile 未變等靜態核對；沒有因部署設定變更而重跑原功能測試。實際網路與權限的逐次驗證結果另存本機忽略版本控制的 `outputs/`，不將正式網路名稱、群組 ID 或秘密提交到儲存庫。

使用者指定目標為 [luckyseal0923/KIKI-Work-assistant](https://github.com/luckyseal0923/KIKI-Work-assistant)，交付分支為 `codex/kiki-phase1`。2026-11-05 推送前檢查：遠端儲存庫存在、現有帳號具備 push 權限，尚無任何分支提交，API 預設分支欄位為 `main`。這是推送前觀察；第一個分支推送後，以實際 GitHub 分支狀態為準，不另外修改預設分支或可見性。

此次只更新實際儲存庫／分支指引與封裝檔名，並檢查待提交清單、秘密排除、package／lockfile 一致性、新 ZIP 與檢查碼；沒有重跑整套功能測試。提交只包含 25 個原始碼、必要設定範例、lockfile、測試與文件檔案，不含 `outputs/`、`.env`、`node_modules/`、金鑰或日誌。只有 push 成功且遠端分支 commit 與檔案核對一致後，才算完成程式碼上傳；這不代表 Coolify 已部署或真實群組訊息已入庫。

## 尚未驗證

- 此機沒有可用的 Docker CLI；未在本機建置或執行 Docker 映像，也未在 Node.js 24 容器內重跑測試。既有 Coolify Dockerfile discover 部署與健康端點已另行驗證。
- PGlite 是單程序記憶體引擎；未以原生 PostgreSQL 多個 TCP 連線壓測同時交易的列鎖、負載或網路斷線。鎖定順序與交易路徑已完成程式檢查。
- `001`、三個 pg_net 物件的共享 ACL，以及 `002` 已實際套用。使用真正 `linebot_app` 的連線已通過應用 `db:check`；尚未進行正式負載與多 TCP 連線的壓力測試。
- GitHub 來源、Compose 雙網路部署、原收訊 HTTPS 與 DNS、私網 DNS／TCP 及資料庫認證已確認。資料庫 TLS 設定實際為 off，僅在確認的私有容器路徑使用既有 private 模式；未測試其他網路或公開資料庫連線。
- Channel secret 與專用資料庫密碼均由使用者填入，沒有讀取或輸出秘密；群組事件簽章及真實受限帳號認證皆已驗證。
- LINE Verify、群組事件識別，以及同一則合成文字的實際入庫／收回已完成；尚未實測 LINE 編輯事件、平台重送或中斷恢復。

此單群的基本入庫／收回已經實際驗收；上述負載、亂序、編輯與異常情境仍應依各自證據判斷。單純 LINE Verify 或健康檢查成功，不等於資料已保存。

## 2026-11-06 共享 ACL 的實際驗證

使用者明確批准後，僅調整 pg_net 的請求表、回應表與請求序列，不改其他物件 ACL、schema、函式、RLS 或角色成員關係。交易內及提交後新查詢共核對 27 角色的 459 組有效權限與 grant option；只有 `linebot_app` 的 17 組被移除，其他 26 個角色的 442 組保持一致。提交後確認 PUBLIC ACL、專用角色三物件權限、可存取外區物件、可執行外區 SECURITY DEFINER、可寫 schema 與角色成員關係皆為 0，角色仍 NOLOGIN。

首次交易因提案檢查遺漏 schema USAGE 而中止，已核對原 ACL 未被提交改動；修正交易檢查以符合應用原有的 schema／表／欄位權限語義後，才完成提交。應用程式與其安全檢查未修改，也沒有將 pg_net 加入例外。

另外使用既有 PGlite 與合成物件通過 9 項 ACL 套用、精確回復及失敗回滾測試；測試 fixture 的版本／extension 條件及系統角色名單與實際 PG15 不同。未讀取共享表、統計檢視或序列內容，未重跑無關的原收訊測試。這些結果不能取代既有 Database Webhook 的合成流程驗收、真正應用帳號的認證與 LINE→Supabase 驗收。

## 2026-11-06 私網與 record 部署驗證

已在 KIKI 新 Compose 容器確認：指定資料庫容器名稱正確、解析至私有 IPv4、TCP 5432 可達，未輸出內部 IP 或憑證。以使用者親自設定的專用密碼執行實際 `npm run db:check`，回報 `ok: true`；issues、externalTables、externalDefiners、memberships、writableSchemas 均為空。專用角色 LOGIN、連線上限 4、NOINHERIT 與所有高權限旗標關閉的狀態已另行核對。

持久化 private 模式與確認旗標後，部署 record，啟動紀錄確認 mode=record；正式 Runtime 設定檢查及以該設定連線的合成測試查詢均成功。apex `/healthz`、`/readyz` 與原 www `/healthz` 皆 HTTPS 200，未簽章空 `/webhook` 401，沒有略過 TLS 憑證驗證。此處 HTTPS 指對外收訊；資料庫傳輸使用已確認的同主機私網，兩者不能混為一談。

實際 LINE 入庫與收回已在 2026-11-06 完成：使用者送出的唯一合成訊息在臺灣時間 17:42:24 入庫，精確匹配 1 則；使用者於 LINE 收回同一則後，17:44:14 的撤回時間已入庫，該訊息文字列為 0、撤回紀錄為 1。以相同訊息的摘要及既定群組關聯核對，沒有用其他訊息的總量變化代替驗收；不讀取其他聊天內容、成員或完整群組 ID。完整界線見 [第一階段驗收紀錄](PHASE1_ACCEPTANCE.md)。
