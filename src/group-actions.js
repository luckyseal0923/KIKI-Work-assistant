export function groupControl(request){
  const match=/^申請啟用本群\s*[:：]\s*(.{2,60})$/u.exec(request);
  if(match&&!/[\x00-\x1f\x7f]/u.test(match[1]))return {action:'group_enroll',label:match[1].trim()};
  if(request==='停用本群')return {action:'group_disable'};
  if(request==='群組清單')return {action:'groups'};
  if(request==='群組狀態')return {action:'group_status'};
  if(/^申請啟用本群/u.test(request))return {action:'group_invalid'};
  return null;
}
export function describeGroup(group){
  return `${group.code||'確認後產生代碼'}｜${group.label}\n狀態：${group.enabled?'已啟用':'未啟用／已停用'}\n操作：僅既定管理者；AI 額度：所有群共用每日 20 次`;
}
