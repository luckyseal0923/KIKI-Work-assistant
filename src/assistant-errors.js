export function failureMessage(code,{stage='answer',request='',applied=false}={}){
  if(applied)return '正式紀錄可能已更新，但回覆未完成。請查「工作清單」或「工作歷程」，不要另外建立相同工作；同一提案可再確認，系統不會重複套用。';
  if(code==='ai_refused')return '這次內容無法由 AI 處理。你可以縮小問題或改為查詢工作清單；正式紀錄未變更。';
  if(['ai_rate_limited','ai_request_failed','ai_incomplete'].includes(code))return 'AI 服務這次未完成回覆，正式工作未變更。請稍後手動重送；也可先查「工作清單」或「待確認提案」，這兩項不使用 AI。';
  if(code==='expired')return '這次要求處理逾時。請重新 @KIKI 下指令；若剛才是在確認提案，先查看工作清單，避免另建相同工作。';
  if(code==='topic_ambiguous')return '這個說法同時對應多個主題。請先查「主題清單」，再用完整主題名稱或 T 開頭代碼指定；尚未合併或變更工作。';
  if(code==='topic_source_changed')return '主題定義的來源已修改或收回，暫不沿用別名。請查「主題清單」取得代碼，再用「重建主題 T代碼：完整名稱；別名：說法一、說法二」重新提出完整定義並確認。';
  if(code==='group_list_primary_only')return '群組清單只會在原管理群顯示。請到原管理群 @KIKI 輸入「群組清單」；本群可用「群組狀態」查看自己的設定。';
  if(code==='group_missing')return '本群尚未啟用。請由既定管理者真正 @KIKI 輸入「申請啟用本群：群組名稱」，核對提案後再確認。';
  if(code==='group_disabled')return '本群已停用或設定已改變，這次操作停止。請先查看「群組狀態」；要重新啟用，請由既定管理者申請並確認。';
  if(code==='work_preview_too_long')return '提案內容太長，尚未儲存或套用。請一次只交辦一件工作，讓完整變更能顯示給你確認。';
  if(['invalid_work_output','invalid_work_target','ungrounded_work_owner','ungrounded_work_date','conflicting_work_owner'].includes(code))return '這次未能產生可核對的工作提案，正式工作未變更。請明確寫出一件事、負責人和期限；未知欄位可以寫「未指定」。';
  if(code==='invalid_ai_output'&&stage==='plan')return '這次未能辨識你的要求，尚未建立提案。可改用「新增待辦：主題…，由…負責…，期限…」；查舊訊息時請附主題或日期。';
  if(code==='invalid_ai_output')return '這次回答未通過來源或格式核對，因此沒有當成正式結果。請縮小主題，或附上要整理的原文。';
  if(code==='topic_missing')return '找不到仍有效的指定主題。請查「主題清單」，或先建立並確認主題與別名。';
  if(code==='topic_exists')return '已有相符的主題或別名，尚未另建。請查「主題清單」；要調整別名，可用「主題別名 完整名稱：說法一、說法二」。';
  if(code==='work_conflict')return '這張工作卡片的版本已改變，沒有套用舊操作。請重新查「工作清單」，再使用最新卡片。';
  if(code==='work_source_changed')return '這件工作的來源已修改或收回，暫不產生變更提案。請重新核對原始交辦。';
  if(code==='work_missing')return '找不到這件工作。請重新查看工作清單，或指定完整的 W 開頭代碼。';
  return /新增|建立|完成|改期|取消|負責/u.test(request)?'這次工作要求未完成。請先查「待確認提案」或「工作清單」核對現況，再重新提出；不會自動重試寫入。':'這次查詢未完成。請縮小主題或日期後再試；原始訊息與既有工作仍保留。';
}
