# 綺綺 KIKI｜智慧秘書

Your Intelligent Work Assistant

本機驗證紀錄。

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

使用者指定目標為 [luckyseal0923/KIKI-Work-assistant](https://github.com/luckyseal0923/KIKI-Work-assistant)，交付分支為 `codex/kiki-phase1`。2026-11-05 推送前檢查：遠端儲存庫存在、現有帳號具備 push 權限，尚無任何分支提交，API 預設分支欄位為 `main`。這是推送前觀察；第一個分支推送後，以實際 GitHub 分支狀態為準，不另外修改預設分支或可見性。

此次只更新實際儲存庫／分支指引與封裝檔名，並檢查待提交清單、秘密排除、package／lockfile 一致性、新 ZIP 與檢查碼；沒有重跑整套功能測試。提交只包含 25 個原始碼、必要設定範例、lockfile、測試與文件檔案，不含 `outputs/`、`.env`、`node_modules/`、金鑰或日誌。只有 push 成功且遠端分支 commit 與檔案核對一致後，才算完成程式碼上傳；這不代表 Coolify 已部署或真實群組訊息已入庫。

## 尚未驗證

- 此機沒有可用的 Docker CLI；尚未實際建置或執行 Docker 映像，也未在 Node.js 24 容器內重跑測試。
- PGlite 是單程序記憶體引擎；未以原生 PostgreSQL 多個 TCP 連線壓測同時交易的列鎖、負載或網路斷線。鎖定順序與交易路徑已完成程式檢查。
- 尚未套用 SQL 到使用者的共用 Supabase，也未以實際 `linebot_app` 連線驗證現行資料與權限。
- GitHub 原始碼目標已指定；尚未確認該儲存庫與 Coolify 的連接、部署主機與容器網路、TLS／CA、收訊子網域與 DNS。
- 尚未輸入 Channel secret、資料庫專用密碼或其他正式秘密。
- 尚未部署、填寫 LINE Webhook URL、取得真實測試群 ID，或完成 LINE 到 Supabase 的端到端入庫／編輯／撤回驗收。

請依 `docs/DEPLOY.md` 完成這些雲端步驟後，再判定第一階段串接成功。單純 LINE Verify 或健康檢查成功，不等於資料已保存。
