# 綺綺 KIKI｜智慧秘書

Your Intelligent Work Assistant

本文件說明第一階段的 Coolify 部署與單群驗收。

目標：`LINE 測試群 → HTTPS /webhook → 受限 PostgreSQL 連線 → 既有 Supabase 的 linebot 區域`。

管理頁 `https://supabase-test.wfhai.org/project/default` 不是資料庫連線位址。這份程式不使用 Supabase REST API，不需要暴露 `linebot` schema，也不需要共用的高權限 API key。

## 1. 先準備部署位置（不傳送秘密）

確認下列一般資訊：

- Coolify 要放在哪個專案、環境與主機。
- 收訊子網域，例如 `kiki.example.org`；這只是範例，尚未替你設定 DNS。
- 程式來源：使用者指定的 GitHub 儲存庫為 [luckyseal0923/KIKI-Work-assistant](https://github.com/luckyseal0923/KIKI-Work-assistant)。Coolify 請選 [`codex/kiki-phase1`](https://github.com/luckyseal0923/KIKI-Work-assistant/tree/codex/kiki-phase1) 分支，讓它讀取本專案的 Dockerfile；儲存庫名稱與可見性維持現況。GitHub 到 Coolify 的連接尚未確認，需依實際介面設定；技術套件及映像名稱仍為 `kiki-work-assistant`。
- 從收訊容器實際可到達的 PostgreSQL 主機／容器名稱、port、資料庫名稱、私有網路或 TLS 方式。不能由 Supabase 管理頁網址推測這些值。

同主機時優先使用經確認的私有容器網路；請由維護者確認既有 Supabase PostgreSQL 的網路名稱及 DNS 別名，再將這個新應用接入所需網路。不為本專案開放公網 PostgreSQL port，也不重設現有 Supabase／其他應用的權限或驗證。

不同主機若沒有現成的受保護路徑，先請維護者提供私有連線或受控 TLS 路徑，不以開放資料庫公網來繞過問題。

## 2. 先部署「只識別群組」模式

在 Coolify 建立一個新的 Application，選擇 GitHub 來源與 **Dockerfile** build pack。使用既有 GitHub 連接或儲存庫 URL；不為本專案更動儲存庫可見性。設定：

| 欄位 | 值 |
| --- | --- |
| Application 顯示名稱 | `綺綺 KIKI｜智慧秘書`；若欄位只接受 ASCII，使用 `kiki-work-assistant` |
| Repository | `https://github.com/luckyseal0923/KIKI-Work-assistant` |
| Branch | `codex/kiki-phase1`；先確認 GitHub 已顯示該分支再部署 |
| Base directory | 專案根目錄 `/` |
| Dockerfile location | `/Dockerfile`（介面若顯示相對路徑則填 `Dockerfile`） |
| Ports Exposes | `3000` |
| Domain | 你已設定 DNS 的 `https://收訊子網域`，如介面要求指定內部 port 則對應 `3000` |
| Host port mapping | 不另行公開 `3000`；由 Coolify 代理轉送 |
| Replicas | `1` |

環境變數先只設定：

```dotenv
APP_MODE=discover
PORT=3000
LINE_CHANNEL_SECRET=由你安全填入
```

Channel secret 在 LINE Developers 該 Messaging API channel 的 **Basic settings**。請直接填入 Coolify 的受保護欄位，不貼回聊天，不提供給前端。

所有變數只需 **Runtime**；秘密設為隱藏／鎖定、Literal（保留 `$` 原字元），關閉 Build time。不把秘密當作 Docker build arguments。不同 Coolify 版本用字可能略有差異，依實際介面設定。

選 Deploy。Dockerfile 已提供以 Node 執行的 healthcheck，不需額外安裝 curl，也不要再加入互相衝突的檢查：

- `GET /healthz`：程式還活著；只回 `{"ok":true}`。
- `GET /readyz`：識別模式表示可驗簽；記錄模式會查資料庫可達性。資料庫探測合併並快取 5 秒，避免外界重複探測拖累共用資料庫。
- Docker healthcheck 使用 `/readyz`。Coolify／Docker 顯示 healthy 後，仍要完成下面的 LINE 與資料庫驗收。

容器沒有需要持久保存的聊天檔案；資料全部進資料庫。若掛載自簽 TLS 的 CA，另依第 5 節設定唯讀檔案。

**沒有 Git 來源時**：可在有 Docker 的受控機器從本專案目錄建置 `docker build -t kiki-work-assistant:0.1.0 .`，推送至你指定的私人映像倉庫，再在 Coolify 選 Docker Image。倉庫位置與權限尚未設定。不要直接把這份有 `COPY` 的 Dockerfile 貼入 Coolify 的「無 Git Dockerfile」欄位，該方式沒有本專案原始碼的建置 context。交付 ZIP 是原始碼備份，不是可直接執行的容器映像。

本次原始碼交付為 [kiki-work-assistant-0.1.0-github-source.zip](../outputs/kiki-work-assistant-0.1.0-github-source.zip)，搭配 [SHA-256 檢查碼](../outputs/kiki-work-assistant-0.1.0-github-source.zip.sha256)。這些連結指向原專案的交付資料夾，不提交到 GitHub；可在本機執行 `scripts/package-source.ps1` 重新產生，ZIP 本身也不包含 `outputs/`。先前交付檔仍保留。`linebot.messages`、`linebot_app`、環境變數及 `/webhook` 路徑保持既有定義。

## 3. 設定 LINE 並取得測試群 ID

到 LINE Developers 的 Messaging API：

1. Webhook URL 填入 `https://你實際的收訊子網域/webhook`。
2. 按 **Verify**，預期成功。這只驗證 HTTPS 連通與簽章，不表示訊息已入資料庫。
3. 開啟 **Use webhook**。
4. 開啟 **Webhook redelivery**。LINE 預設不開啟；重送次數／間隔不公開，也不保證每則事件都送達。
5. 保持已設定的 **Allow bot to join group chats**。

bot 已加入你的測試群，**不必移除再邀請**。請在該群親自傳送：

```text
合成測試：取得測試群識別碼
```

在 Coolify 的受保護 Runtime Logs 找到：

```json
{"event":"group_candidate","group_id":"C…"}
```

實際日誌有時間及完整 ID。只複製該群的 ID 到下一階段的 `ALLOWED_GROUP_ID`。這個模式不保存該句文字或發言者，也不自動授權第一個來訊的群組。請確認它對應你剛剛操作的測試群；若同時出現多個 ID，先釐清對應群組，不猜測。

每個程序最多顯示 20 個不同群組 ID，每群顯示一次，以免日誌與記憶體無限成長；需要重新觀察時可重新啟動識別模式。

## 4. 套用專用區增量 SQL 與安全登入

若要從 KIKI 連入另一個 Supabase stack 的私有網路，先依 [私有資料庫網路部署說明](PRIVATE_DATABASE.md) 檢查並套用 KIKI 專用的 `compose.yaml`，保留既有對外代理網路及網域。單純的 discover 收訊仍可使用原 Dockerfile 部署；兩種方式都不能以健康檢查成功代替資料庫認證與權限驗收。

既有 `linebot_app`、`linebot`、`linebot.messages` 不要重新建立。

### 4-1 增量結構

在既有 Supabase SQL Editor，以 `postgres` 執行完整的：

```text
migrations/001_event_safety.sql
```

這份 SQL 只更動 `linebot`：增加兩個編輯欄位、允許未知原發送時間暫存 `NULL`、建立事件去重表與撤回狀態表，並只對新表設定專用角色權限與 RLS。既有資料保留；沒有重設全庫權限或新增 exposed schema。SQL 可重跑，鎖定逾時會使整批回滾，不要因此停止其他服務。

### 4-2 密碼

請由有管理權限的人在受保護的 PostgreSQL 終端機使用互動方式設定密碼。若在既有資料庫容器內且本機管理認證允許，可執行：

```text
psql -U postgres -d postgres
```

若實際管理連線方式不同，使用現有管理方式；不要修改 `pg_hba.conf` 為 trust，也不要為了這一步暴露公網 port。

進入 psql 後：

```text
SET password_encryption = 'scram-sha-256';
\password linebot_app
```

它會互動詢問密碼兩次，不在命令列參數或 SQL 查詢文字放正式密碼。用密碼管理器產生專用長密碼，之後只填 Coolify 的 `DB_PASSWORD`。不要貼回聊天或存進版本控制。不要用共用 `postgres` 密碼代替。

若沒有可安全互動的終端機，請維護者協助；不要把含明碼的 `ALTER ROLE ... PASSWORD '...'` 存進 SQL Editor 查詢歷史。

### 4-3 開啟專用角色登入

安全設定密碼後，再以管理員執行完整的：

```text
migrations/002_role_login.sql
```

只將既有的 `linebot_app` 設為可登入，角色總連線上限 4，並設定短逾時。每個應用程序的連線池最多 2 條；單一 replica 做滾動替換時最多兩個程序合計 4 條。這不是為 Supabase 全庫設上限。

## 5. 填入記錄模式的 Runtime 設定

保留 Channel secret，將下列值由你安全填入。不要照貼說明用的中文佔位文字：

| 變數 | 填寫方式 |
| --- | --- |
| `APP_MODE` | `record` |
| `PORT` | `3000` |
| `ALLOWED_GROUP_ID` | 第 3 節確認的唯一完整群組 ID，不支援逗號多群或萬用字元 |
| `LINE_CHANNEL_SECRET` | 原本的秘密設定 |
| `DB_HOST` | 從這個收訊容器實際可達的 PostgreSQL DNS 名稱 |
| `DB_PORT` | 實際 PostgreSQL port；範例預設 `5432` |
| `DB_NAME` | 既有資料庫名稱；範例 `postgres` |
| `DB_USER` | 固定 `linebot_app`；程式會拒絕 `postgres` 等其他帳號 |
| `DB_PASSWORD` | 第 4 節設定的專用密碼 |
| `DB_TLS` | 預設 `verify-full`；只有已確認的同主機私有網路可選 `private` |
| `DB_CA_FILE` | 自簽 CA 時填容器內唯讀 CA 路徑；一般可信 CA 可留空 |
| `DB_PRIVATE_NETWORK_CONFIRMED` | `DB_TLS=private` 時才填 `true`；其他情況為 `false` |

`verify-full` 會驗證憑證及主機名稱；不提供 `rejectUnauthorized=false` 的略過方式。若憑證不被信任，掛載正確 CA 並使用符合憑證的主機名稱。程式刻意使用分開的連線欄位，避免密碼 URL 編碼及 `sslmode` 覆蓋 TLS 設定。

若維護者確認同主機私有容器網路且 PostgreSQL 未啟用 TLS，才改用 `private` 並明確確認；這不會自動建立或保護網路。不要把公網 IP／公網網域當作已確認的私有網路。

設定好 Runtime 變數後重新部署。部署不會自動執行 migration，以免新服務擅自修改共用資料庫。

## 6. 用真正的應用帳號檢查權限

record 模式啟動時會自動執行權限檢查，通過才開始監聽。日誌應有 `database_audit_passed` 與 `server_started`。

也可在 Coolify 應用的 Terminal 執行：

```text
npm run db:check
```

若目前仍在 discover 模式，先填好 DB Runtime 設定並重新啟動，再從該模式的 Terminal 執行上述指令，通過後切換 record。這樣可先看失敗的細節，避免無法啟動的容器沒有 Terminal。

檢查只讀取系統權限資料與自有表結構，不讀取聊天列或其他系統內容。會檢查角色高權限／角色成員關係、三張表的權限與 RLS、其他 schema 可存取的資料表／欄位權限、外部可執行的 `SECURITY DEFINER` 函式，以及可建立物件的 schema。

預期 `ok` 為 `true`。若出現 `external_table_privileges` 或 `external_security_definer`，表示即使名為專用角色，仍可能經由 `PUBLIC` 或既有授權接觸其他區域，服務會拒絕以 record 模式啟動。詳細檢查輸出只有物件名稱，不含內容或密碼。

**這時請先請資料庫維護者評估。不要全域撤銷 PUBLIC、改動其他應用、授予超級使用者，或停用檢查來繞過。** 要調整什麼權限必須根據實際報告另行決定；此交付沒有擅自處理共用資料庫的外部權限。

此檢查是部署當下的保守檢查，並非全面資安稽核，也無法阻止日後管理員新增不當授權。未來變更共用資料庫授權後應重跑。

## 7. 雲端端到端驗收（只用合成資料）

先確認 `APP_MODE=record`、健康檢查通過及 LINE 的 Webhook redelivery 已開啟。由你在測試群操作，程式不代發訊息。

| 操作 | 應觀察到的結果 |
| --- | --- |
| 在允許群送 `合成驗收 A：明天 09:00 開會` | `linebot.messages` 多一列，文字相符，原發送時間存在 |
| 引用上一則再送 `合成驗收 B：收到` | 新列的 `quoted_message_id` 指向被引用的訊息 ID |
| 編輯 A 為 `合成驗收 A：改成 10:00 開會` | A 仍只有一列，文字更新，`edited_at` 有值，`sent_at` 維持原發送時間 |
| 撤回 A | A 的文字列消失；`linebot.message_state` 的對應列有 `unsent_at`，沒有原文與發言者 |
| 如已有另個純測試群或私訊，傳合成文字 | 不出現在 `linebot.messages`；不必為此額外邀請 bot 到新群 |
| 查看 Runtime Logs | 只有處理數量／固定事件名稱，沒有測試原文、user ID 或秘密 |

可在 SQL Editor 用下列查詢核對；這僅應用於你的合成測試群，不把正式群原文帶入聊天：

```sql
SELECT message_id, group_id, message_text, quoted_message_id,
       sent_at AT TIME ZONE 'Asia/Taipei' AS sent_at_tw,
       received_at AT TIME ZONE 'Asia/Taipei' AS received_at_tw,
       edited_at AT TIME ZONE 'Asia/Taipei' AS edited_at_tw
FROM linebot.messages
WHERE group_id = '填入測試群組ID'
ORDER BY received_at DESC
LIMIT 20;
```

```sql
SELECT message_id, group_id,
       unsent_at AT TIME ZONE 'Asia/Taipei' AS unsent_at_tw
FROM linebot.message_state
WHERE group_id = '填入測試群組ID' AND unsent_at IS NOT NULL;
```

不在共用 Supabase 上刻意停機、撤權或塞滿連線來測失敗。失敗與重送已在本機用合成資料驗證；若需雲端故障演練，先有獨立測試資源再做。

## 8. 逾時、錯誤與試辦界線

- 正常收訊只做資料庫交易，不做 AI 或慢速外部查詢。單程序連線池最多 2 條；取得連線逾時 700ms、單句 SQL 1000ms、鎖等待 400ms、每批儲存含取得連線的目標上限 1600ms。處理中最多 4 批，超出回 `503`，單請求最多 1 MiB／100 個事件。
- 這些上限協助快速失敗，並不保證網路、主機排程或 LINE 一定在固定時間內完成。成功回應只在交易提交後送出；若提交成功但回應遺失，重送會去重。過慢時不先假回成功。
- `401`：檢查 Channel secret 是否屬於同一個 channel，及代理有沒有改寫原始 body；不要打印 body 或 secret 診斷。
- `503`：看固定錯誤代碼、`/readyz` 及安全的 `db:check` 結果，檢查網路、TLS、登入、migration、過載；不要啟用原文請求或 SQL 參數記錄。
- LINE Verify 成功、Coolify Deploy 成功、healthcheck 成功，各自只代表一部分；第 7 節實際入庫與撤回成功才算這階段串接完成。
- LINE 不保證重送送達，也不能事後重新下載使用者文字。服務長時間中斷、尚未開啟 webhook、discover 期間與未授權群組的訊息都不會自動回補；撤回事件若完全漏收，也無法自動清除該文字。
- 目前表內撤回刪除不等於抹除資料庫備份／WAL。資料庫與代理日誌、錯誤參數記錄、備份保留政策由維護者確認；測試期間只用合成資料。不要開啟可記錄本文／參數的除錯模式。
- 這是單群短期試辦；未設定自動保存期限。觀察儲存成長後再決定文字與去重紀錄的保存政策；tombstone 不可任意清除。Coolify 異常通知、AI、摘要、時間判讀、多群授權與 Google Sheets 都不在此階段。

暫停收訊時，可先在 LINE 關閉 Use webhook，或把本應用停止；這不會刪除既有資料。不要刪除共用 Supabase 服務或把 migration 反向全庫回復。

## 參考文件

- [Coolify Dockerfile](https://coolify.io/docs/applications/builds/dockerfile)
- [Coolify 環境變數：Runtime、鎖定與 Literal](https://coolify.io/docs/applications/configuration/environment-variables)
- [Coolify 健康檢查](https://coolify.io/docs/applications/configuration/health-checks)
- [LINE 簽章驗證](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [LINE 重送與撤回](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [PostgreSQL 權限與 PUBLIC](https://www.postgresql.org/docs/current/ddl-priv.html)
- [node-postgres TLS 設定](https://node-postgres.com/features/ssl)
