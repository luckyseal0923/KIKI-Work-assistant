# 綺綺 KIKI｜智慧秘書

Your Intelligent Work Assistant

此部署設定只解決 KIKI 到既有 Supabase 私有網路的持久化連線，不改應用收訊邏輯、資料庫角色、RLS 或共享服務設定。

## 為何使用 Compose

單容器 Dockerfile 部署目前只使用 Coolify destination 的網路。要同時保留原本的 `coolify` 代理網路並附加另一個既有私有網路，使用本專案的 `compose.yaml`。不要把 `--network` 填進 Custom Docker Options，Coolify 不支援該選項；也不要只執行一次性的 `docker network connect` 當成完成。

Compose 只有 `kiki` 一個服務，仍由原 Dockerfile 建置，沿用原 Node 健康檢查。兩個網路都標為 `external: true`，只使用已存在的網路，不建立、重建或修改 Supabase stack。

## 在原本 KIKI 應用套用

1. 保留 `APP_MODE=discover`、真正的 Channel secret 及既有允許群組設定。
2. 在 KIKI 的受保護 Runtime 設定中填入 `SUPABASE_DOCKER_NETWORK`，值須取自目標 Supabase 的已產生 Compose `networks.*.name`，不可猜 UUID、暫時 IP 或把 `localhost` 當成別的容器。
3. 原應用的 General 選 Compose 作為 Build strategy，Base directory 保持 `/`，Compose location 為 `/compose.yaml`，儲存並載入 Git 中的定義。
4. 檢查產生的設定：服務只有 `kiki`、建置來源仍是 `Dockerfile`，並同時連接既有 `coolify` 與指定的 Supabase 私有網路。不得有資料庫服務、主機 `ports:`、Docker socket 掛載或擴大容器權限。
5. 在 Domains 將既有 KIKI HTTPS 網域對應至 `kiki` 服務的 `3000` port，保留原本的 www 網域與 TLS。不要新增或改動 Supabase 網域。
6. 部署後重新核對 HTTPS `/healthz`、`/readyz`，以及未簽章的 `/webhook` 仍回 `401`。
7. 從 KIKI 容器使用目標已確認的穩定 `container_name` 或網路別名測試 DNS 與 TCP port。僅有 DNS 成功或 TCP 成功不等於受限帳號已通過資料庫認證與權限檢查。

所有原應用 Runtime 變數仍由 `${變數}` 引用，不在 Compose 填入正式秘密。Compose 載入時會保留已存在的設定。新增的 `SUPABASE_DOCKER_NETWORK` 只供部署解析，不是應用程式的新資料介面；即使 Coolify 的 `env_file` 把它一併放入 Runtime，Node 收訊程式也不讀取這個欄位。

2026-11-06 已經使用者明確批准，完成 Compose 雙網路部署、原 HTTPS 網域對應及私有 DNS／TCP 驗證。既有資料庫未啟用 TLS；確認同主機私有路徑後，使用 `DB_TLS=private` 與 `DB_PRIVATE_NETWORK_CONFIRMED=true`，沒有開放公網資料庫 port 或改動共享 stack。

共享 ACL 僅調整 `net.http_request_queue`、`net._http_response`、`net.http_request_queue_id_seq`：原 PUBLIC 權限改為保留現有角色的明示授權，排除 `linebot_app`。提交後新查詢確認其他 26 角色的 442 組有效權限不變；專用角色在三物件無權限，且沒有可實際存取的外區物件。使用者在安全終端設定專用 SCRAM 密碼後，已套用 002 的 LOGIN、總連線上限 4 與短逾時設定，並由 KIKI 容器以真正受限帳號執行 `npm run db:check`，回報 `ok: true` 且所有問題清單為空。record 程序已啟動；原測試群的一則合成文字已驗證實際入庫，收回同一則後文字已移除，詳見 [第一階段驗收紀錄](PHASE1_ACCEPTANCE.md)。

外區存取須同時核對 schema `USAGE`、表級及欄位級權限。只有表的 ACL 不代表角色能實際使用該物件；本次交易檢查已與原應用 `database-audit.js` 的語義對齊，沒有修改應用檢查或增加物件白名單。完整前後快照、實際套用 SQL、回復 SQL 與提交後比對紀錄保存在本機忽略版本控制的 `outputs/`；未將正式網路名稱或秘密提交到儲存庫。

若伺服器 TLS 未啟用，只能在已確認的同主機私有網路路徑上，依既有 `DB_TLS=private` 與 `DB_PRIVATE_NETWORK_CONFIRMED=true` 流程設定；不能用略過憑證驗證或公開 `5432` 的方式處理。

## 保留安全檢查

先套用既有 `migrations/001_event_safety.sql`，再核對其物件與有效權限。不得重新建立初始化，或為使應用啟動而停用 `db:check`。

即使角色是 `NOINHERIT`，它仍可能透過 `PUBLIC` 存取其他區域。如果檢查回報 `external_table_privileges` 等問題，維持 discover 並請資料庫維護者審核既有授權，不得擅自撤銷共享權限或替其他應用重新授權。

專用帳號的密碼、LOGIN、連線限制依原部署說明處理。只有真實的 `linebot_app` 連線及完整權限檢查通過後，才切換 `record`，再由使用者在允許群組送合成文字驗收入庫與撤回。

## 回復方式

若 Compose 部署未通過健康與路由檢查，可將 KIKI 的 Build strategy 回復為 Dockerfile、Dockerfile location `/Dockerfile`，維持原 HTTPS 網域與 `APP_MODE=discover`，再部署先前成功版本。原 Dockerfile 與 Node 程式保持不變，既有受保護變數也不需清除。不要對共享 Supabase 執行 `down`、重建網路或移除 volumes。

## 本次打包腳本修改前後

`scripts/package-source.ps1` 檔名修改前：

```powershell
$archivePath = Join-Path $outputDirectory 'kiki-work-assistant-0.1.0-github-source.zip'
```

修改後：

```powershell
$archivePath = Join-Path $outputDirectory 'kiki-work-assistant-0.1.0-compose-source.zip'
```

封裝白名單的完整對應行，修改前：

```powershell
    'Dockerfile', 'README.md', 'src', 'scripts', 'migrations', 'test', 'docs'
```

修改後：

```powershell
    'Dockerfile', 'compose.yaml', 'README.md', 'src', 'scripts', 'migrations', 'test', 'docs'
```

`.env.example` 新增的完整部署設定段落：

```dotenv
# 僅供 compose.yaml 的部署設定；不是資料庫密碼，填實際已存在的 Supabase stack 網路名稱。
# 只用 Dockerfile 做 discover 時可留空；Compose 部署時必填。
SUPABASE_DOCKER_NETWORK=
```

## 官方依據

- [Coolify 的 Compose、變數與網域設定](https://coolify.io/docs/applications/builds/docker-compose)
- [Coolify 支援的 Custom Docker Options](https://coolify.io/docs/applications/builds/custom-docker-options)
- [Docker Compose external networks 與參數化名稱](https://docs.docker.com/reference/compose-file/networks/)
