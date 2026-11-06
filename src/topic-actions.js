export const TOPIC_CODE=/^T[0-9A-F]{8}$/u;
const clean=v=>v.trim().normalize('NFC').replace(/\s+/gu,' ');
export function validateTopicDefinition(name,aliases=[]){
  const invalid=v=>typeof v!=='string'||/[\x00-\x1f\x7f]/u.test(v);
  if(invalid(name)||!Array.isArray(aliases)||aliases.length>4||aliases.some(invalid))throw new Error('invalid_topic_definition');
  name=clean(name);aliases=[...new Map(aliases.map(v=>[clean(v).toLowerCase(),clean(v)])).values()].filter(v=>v.toLowerCase()!==name.toLowerCase());
  if(name.length<2||name.length>60||aliases.some(v=>v.length<2||v.length>30)||[name,...aliases].some(v=>/^(工作|訊息|討論|整理|待辦|全部|今天|目前|最近)$/u.test(v)))throw new Error('invalid_topic_definition');
  return {name,aliases};
}
export function topicControl(request){
  if(request==='主題清單')return {action:'topics'};
  const rebuild=/^重建主題\s+(T[0-9A-F]{8})\s*[:：]\s*([^；;]+?)(?:[；;]\s*別名\s*[:：]\s*(.*))?$/iu.exec(request);
  if(rebuild){try{return {action:'topic_define',target:rebuild[1].toUpperCase(),rebuild:true,definition:validateTopicDefinition(rebuild[2],rebuild[3]?rebuild[3].split(/[、，,]/u):[])}}catch{return {action:'topic_invalid'}}}
  const create=/^建立主題\s*[:：]\s*([^；;]+?)(?:[；;]\s*別名\s*[:：]\s*(.*))?$/u.exec(request);
  if(create){try{return {action:'topic_define',definition:validateTopicDefinition(create[1],create[2]?create[2].split(/[、，,]/u):[])}}catch{return {action:'topic_invalid'}}}
  const update=/^主題別名\s+([^：:]+)\s*[:：]\s*(.*)$/u.exec(request);
  if(update){try{return {action:'topic_define',target:clean(update[1]),definition:validateTopicDefinition('主題名稱',update[2]?update[2].split(/[、，,]/u):[])}}catch{return {action:'topic_invalid'}}}
  const view=/^主題\s+(.{1,60})$/u.exec(request);
  if(view)return {action:'topic',target:clean(view[1])};
  if(/^建立主題|^主題別名|^重建主題/u.test(request))return {action:'topic_invalid'};
  return null;
}
export function describeTopic(topic){
  return `${topic.code||'確認後產生代碼'}｜${topic.definition.name}\n別名：${topic.definition.aliases.join('、')||'未設定'}${topic.version?`\n版本：${topic.version}`:''}`;
}
