# 綺綺 KIKI｜智慧秘書：第一階段驗收

Your Intelligent Work Assistant

2026-11-06 已完成原允許測試群的一則真實 LINE 合成訊息入庫與收回。以下時間均為臺灣時間（UTC+8）。

| 驗收項目 | 實際結果 |
| --- | --- |
| LINE → KIKI → Supabase | 使用者親自在既定測試群送出指定合成文字；17:42:24 入庫，精確匹配 1 則 |
| LINE 收回 → Supabase | 使用者收回同一則；撤回時間為 17:44:14，原文字列 0 筆、撤回紀錄 1 筆 |
| 同則關聯 | 以既定群組與訊息 ID 摘要關聯核對，沒有用整張表的數量變化推測 |
| 目前收訊模式 | `record`，只接受既有 `ALLOWED_GROUP_ID` |
| 真正受限連線 | KIKI 容器的實際 `npm run db:check` 回報 `ok: true`，問題清單皆空 |
| 專用角色 | `linebot_app` LOGIN、連線總上限 4、NOINHERIT、高權限旗標關閉、短逾時 |
| 私網 | 既有代理及 Supabase 外部網路；私有 DNS／TCP 已驗證，未公開資料庫 port |
| 對外 HTTPS | apex 健康／就緒與 www 健康皆 200，未簽章空 webhook 401；未略過 TLS 驗證 |

驗收使用目前的 LINE 平台、已部署 KIKI 程序及既有 Supabase，沒有在伺服器偽造 LINE 簽章或代替使用者送群組訊息。查詢只針對指定合成文字及其同則撤回狀態，沒有讀取其他訊息或成員。

## 權限與資料變更

`001_event_safety.sql` 已套用並核對。共享 ACL 只調整 pg_net 的請求表、回應表及請求序列；經使用者明確批准後提交，其他 26 角色的 442 組有效權限及 grant option 保持一致，專用角色對外區可存取物件為 0。使用者親自設定專用 SCRAM 密碼後，經批准套用 002，沒有把正式密碼放入聊天、SQL Editor 或 Git。

Compose 只有 KIKI 服務，沿用原 Dockerfile，沒有重建 Supabase、移動資料、公開 5432、掛載 Docker socket 或修改其他應用。對外 HTTPS 與內部資料庫傳輸分別核對：既有資料庫 `ssl=off`，僅在已確認的同主機容器私網使用 `DB_TLS=private` 及私網確認旗標。

本次真正寫入的是使用者指定的合成測試訊息；收到 LINE 收回事件後，應用移除該文字列並保留撤回紀錄。沒有人工刪除資料庫文字來代替驗收，也沒有修改應用的安全檢查或加入物件白名單。

## 驗證界線

- 真實雲端驗證涵蓋這一則訊息的簽章、既定允許群組的正向收訊、入庫及同則收回，不能推論每種 LINE 事件皆已實測。
- 其他群組的負向拒絕、實際 LINE 編輯事件、平台重送、網路中斷、亂序及大量同時訊息尚未實測；相關邏輯有先前的本機合成測試，證據種類不同。
- 其他共享角色的有效權限已比對保留，但沒有操作其他應用進行業務流程驗收。
- 單一測試群已開始持續收錄新文字；沒有新增 AI、摘要、Sheets 或群組回覆功能。

## 私有證據

完整快照、命令、截圖與檢查碼保存在原工作目錄的 `outputs/`，依 `.gitignore` 不提交 Git。主要紀錄為 `kiki-e2e-insert-proof-20261106.json`、`kiki-e2e-unsend-proof-20261106.json`、`kiki-e2e-unsend-confirmed-20261106.jpg`、`kiki-private-route-and-db-check-20261106.json` 及 `pg-net-acl-execution-manifest-20261106.json`。

Git 只保存必要程式與不含秘密的說明文件；不包含正式密碼、Channel secret、完整群組 ID、成員資料、完整 webhook 或真實聊天內容。
