# 綺綺 KIKI｜智慧秘書

Your Intelligent Work Assistant

2026-11-05 本機命名調整紀錄。原命名階段只同步品牌文字、技術識別名稱與交付封裝，版本維持 `0.1.0`，當時未操作遠端服務。之後使用者已指定 [luckyseal0923/KIKI-Work-assistant](https://github.com/luckyseal0923/KIKI-Work-assistant) 作為 GitHub 上傳目標，本次交付分支為 `codex/kiki-phase1`；是否已連接 Coolify 仍未確認。以下保留原命名階段的修改前後紀錄。

## 更新檔案

- `README.md`、`docs/DEPLOY.md`、`docs/VALIDATION.md`：正式名稱、副標、儲存庫與容器範例、交付連結及本次檢查範圍。
- `package.json`：ASCII 套件名稱、正式顯示名稱與英文副標；`package-lock.json` 的兩個根套件名稱同步更新，版本與依賴不變。
- `Dockerfile`：新增容器映像的品牌標籤，原建置與啟動指令不變。
- `src/config.js`：只更新 PostgreSQL 的 `application_name` 識別標籤；沒有改帳號、連線欄位、權限或收訊行為。
- `scripts/package-source.ps1`：改用新交付檔名，並在封裝後寫出同名 SHA-256 檢查碼。
- 本文件為新增檔案，收錄可直接對照替換的程式設定段落。

以下各段為完整對應的修改區塊；其餘程式內容保持既有定義。

## package.json 開頭

修改前：

```json
  "name": "line-group-receiver",
  "version": "0.1.0",
```

修改後：

```json
  "name": "kiki-work-assistant",
  "displayName": "綺綺 KIKI｜智慧秘書",
  "description": "Your Intelligent Work Assistant",
  "version": "0.1.0",
```

## package-lock.json 根層 name 與 packages[""].name

兩個位置各自將下列同一段替換；保留各自原本的縮排：

修改前：

```json
  "name": "line-group-receiver",
```

修改後：

```json
  "name": "kiki-work-assistant",
```

## Dockerfile 開頭

修改前：

```dockerfile
FROM node:24-alpine
ENV NODE_ENV=production
```

修改後：

```dockerfile
FROM node:24-alpine
LABEL org.opencontainers.image.title="綺綺 KIKI｜智慧秘書" \
      org.opencontainers.image.description="Your Intelligent Work Assistant"
ENV NODE_ENV=production
```

## src/config.js 應用識別標籤

修改前：

```javascript
    application_name: 'line-group-receiver',
```

修改後：

```javascript
    application_name: 'kiki-work-assistant',
```

這是 PostgreSQL 連線的應用名稱標示，不是資料庫角色；`DB_USER=linebot_app` 及已存在的 `linebot` 物件不變。

## scripts/package-source.ps1 封裝檔名

修改前：

```powershell
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = Join-Path $projectRoot 'outputs'
$archivePath = Join-Path $outputDirectory 'line-group-receiver-0.1.0-source.zip'
```

修改後：

```powershell
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = Join-Path $projectRoot 'outputs'
$archivePath = Join-Path $outputDirectory 'kiki-work-assistant-0.1.0-source.zip'
```

## scripts/package-source.ps1 封裝結束後

修改前：

```powershell
Write-Output $archivePath
```

修改後：

```powershell
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
Set-Content -LiteralPath "$archivePath.sha256" -Value "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))" -Encoding ascii
Write-Output $archivePath
Write-Output "$archivePath.sha256"
```

## 後續 GitHub 交付的封裝檔名

為保留先前已交付的命名版，打包腳本僅將封裝檔名改為新名稱，其他打包排除規則與 SHA-256 流程不變。

`scripts/package-source.ps1` 修改前：

```powershell
$archivePath = Join-Path $outputDirectory 'kiki-work-assistant-0.1.0-source.zip'
```

修改後：

```powershell
$archivePath = Join-Path $outputDirectory 'kiki-work-assistant-0.1.0-github-source.zip'
```

## 交付檔

本次 GitHub 交付封裝為 [kiki-work-assistant-0.1.0-github-source.zip](../outputs/kiki-work-assistant-0.1.0-github-source.zip)，搭配 [SHA-256 檢查碼](../outputs/kiki-work-assistant-0.1.0-github-source.zip.sha256)。這些連結指向原專案的 `outputs/`，不提交到 GitHub；為避免遞迴打包，ZIP 不含 `outputs/`。原命名版 `kiki-work-assistant-0.1.0-source.zip` 及其檢查碼仍保留。

舊的 `outputs/line-group-receiver-0.1.0-source.zip` 與其 `.sha256` 檔保留原樣，沒有覆寫。文件中只有歷史交付說明及上述修改前區塊會保留舊技術名稱；目前套件、容器範例與連線識別標籤均使用新名稱。
