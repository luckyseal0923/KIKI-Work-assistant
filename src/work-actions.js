import { taipeiDay } from './assistant-command.js';

export const WORK_CODE=/^W[0-9A-F]{8}$/u;
export const PROPOSAL_CODE=/^P[0-9A-F]{8}$/u;
const STATE={active:'未完成／有效',in_progress:'進行中',done:'已完成',canceled:'已取消'};
const KIND={task:'待辦',decision:'決議',event:'行程'};
const CONTEXT_QUESTION=/^(?:請問)?(?:是由誰負責|由誰負責|是誰負責|誰負責|負責人是誰|負責人呢|誰來處理|什麼時候(?:到期|截止|完成)?|何時(?:到期|截止|完成)?|期限(?:是什麼時候|呢)?|地點(?:在哪裡|呢)|在哪裡|時間呢|後來呢|目前呢|進度如何|完成了嗎|確認了嗎|決定了嗎|有定案嗎|還缺什麼)(?:的)?[。！？!?]?$/u;

export function normalizeRequest(request){
  return request.trim().replace(/^(?:[①-⑳]\s*|(?:\([1-9]\d?\)|（[1-9]\d?）|[1-9]\d?[.、)])\s+)/u,'').trim();
}
export function directWorkPlan(request){
  const value=normalizeRequest(request);
  if(!/^(?:請\s*)?(?:新增|建立)(?:待辦|工作|任務|決議|行程)\s*[:：]\s*\S/u.test(value))return null;
  if(/根據|依照|群組|討論|訊息|剛才|之前|過去|Google|Gmail|Outlook|行事曆|日曆|calendar|寄信|寄出|發送|通知|提醒我|密碼|金鑰|權限|https?:/iu.test(value))return null;
  return {mode:'work_propose',keyword:null,search_terms:[],source_scope:'none',clarification:null,inputTokens:0,outputTokens:0};
}

export function workspaceControl(request) {
  const text=normalizeRequest(request).replace(/[。！!？?]+$/u,'').trim();
  if(/^(工作清單|我的待辦|有哪些未完成的?工作|有哪些工作未完成|還有哪些(?:工作|待辦)(?:沒完成|未完成))$/u.test(text))return {action:'list'};
  if(text==='待確認提案')return {action:'pending'};
  if(/^(重置對話|清除對話記憶)$/u.test(text))return {action:'reset'};
  const confirm=/^(確認|取消提案)\s+(P[0-9A-F]{8})$/iu.exec(text);
  if(confirm)return {action:confirm[1]==='確認'?'confirm':'discard',code:confirm[2].toUpperCase()};
  const history=/^工作歷程\s+(W[0-9A-F]{8})$/iu.exec(text);
  if(history)return {action:'history',code:history[1].toUpperCase()};
  return null;
}

export function isFollowup(request) {
  const value=normalizeRequest(request);
  return CONTEXT_QUESTION.test(value)||/^(那|這份|這個|這件|這些|剛才|剛剛|上一|再|繼續|改短|簡短一點)|^(?:請|幫我|把|將)?(?:剛才|剛剛|上面|上述|這件)|(?:他|她|乙|甲|丙)呢[？?]?$/u.test(value);
}
export function fastFollowup(request,context){
  if(!context)return null;
  const value=normalizeRequest(request);
  if(CONTEXT_QUESTION.test(value)){
    const targets=context.previousProposal?.actions||context.records||[];
    if(['work_query','work_propose'].includes(context.scope?.mode)&&targets.length>1)return {mode:'clarify',keyword:null,search_terms:[],source_scope:'none',clarification:'前次包含多筆工作，請指定要追問的工作代碼或主題。',inputTokens:0,outputTokens:0};
    return {mode:'followup',keyword:null,clarification:null,source_scope:'none',inputTokens:0,outputTokens:0};
  }
  if(['work_query','work_propose'].includes(context.scope?.mode)&&/^(?:把|將)?這(?:件|項)/u.test(value)
    &&/完成|取消|改期|改成|改為|更新|負責|期限/u.test(value)&&!/[？?]|嗎|是否|有沒有|是不是/u.test(value)){
    const targets=context.previousProposal?.actions||context.records||[];
    if(targets.length!==1)return {mode:'clarify',keyword:null,search_terms:[],source_scope:'none',clarification:'前次包含多筆工作，請指定要修改的工作代碼。',inputTokens:0,outputTokens:0};
    return {mode:'work_propose',keyword:null,search_terms:[],source_scope:'none',clarification:null,
      inheritedItemCode:context.records?.[0]?.code||context.previousProposal?.actions?.[0]?.target||null,inputTokens:0,outputTokens:0};
  }
  if(/^(?:請)?(?:再找更早的|再往前找|找更早的|更早之前的呢)[。！？!?]?$/u.test(value)&&context.scope?.query&&context.snapshot?.sourceRefs?.length){
    const before=new Date(Math.min(...context.snapshot.sourceRefs.map(r=>new Date(r.at).getTime()))).toISOString();
    const query={...context.scope.query,range_start:'1970-01-01T00:00:00.000Z',range_end:before,history:true,scopeLabel:`沿用前次主題，查找 ${taipeiDay(before).day} ${new Date(before).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})} 以前的已保存紀錄`};
    return {mode:'group_history',keyword:query.keyword,search_terms:query.searchTerms||[],clarification:null,source_scope:'none',inheritedQuery:query,inputTokens:0,outputTokens:0};
  }
  if(/^(?:請)?(?:再(?:簡短|短|精簡)一點|再短些|改成條列式|改成表格|那(?:甲|乙|丙|他|她)呢)[。！？!?]?$/u.test(value)){
    return {mode:'followup',keyword:null,clarification:null,source_scope:'none',inputTokens:0,outputTokens:0};
  }
  return null;
}

function text(value,max,nullable=false) {
  if(nullable&&value===null)return null;
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value))throw new Error('invalid_work_output');
  return value.trim();
}

export function normalizeWorkDate(value,anchor) {
  if(!value)return {due_on:null,due_at:null,date_note:null};
  const day=taipeiDay(anchor).day,year=Number(day.slice(0,4));
  let date=null,note=null;
  const absolute=/(?<!\d)(?:(\d{4})[\/.-])?(\d{1,2})[\/.-](\d{1,2})(?!\d)/u.exec(value);
  const relative=/(今天|今日|明天|明日|後天|昨天)/u.exec(value);
  if(absolute){
    const y=Number(absolute[1]||year),m=Number(absolute[2]),d=Number(absolute[3]);
    const parsed=new Date(Date.UTC(y,m-1,d));
    if(parsed.getUTCFullYear()!==y||parsed.getUTCMonth()!==m-1||parsed.getUTCDate()!==d)return {due_on:null,due_at:null,date_note:'日期無效，待確認'};
    date=parsed.toISOString().slice(0,10); if(!absolute[1])note=`年份依來源日期採 ${year} 年，請確認`;
  }else if(relative){
    const offsets={今天:0,今日:0,明天:1,明日:1,後天:2,昨天:-1};
    date=new Date(new Date(`${day}T00:00:00+08:00`).getTime()+offsets[relative[1]]*86400000+8*3600000).toISOString().slice(0,10);
    note=`相對日期以來源 ${day}（臺北）計算`;
  }
  if(!date)return {due_on:null,due_at:null,date_note:'保留原文，具體日期待確認'};
  const numeric={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'十一':11,'十二':12};
  const clock=/(上午|早上|下午|晚上|中午)?\s*(十二|十一|十|[一二三四五六七八九]|\d{1,2})(?:[:：](\d{2})|點(?:(\d{1,2})分?|半)?)/u.exec(value);
  let hour=null,minute=0;
  if(clock){hour=Number(numeric[clock[2]]||clock[2]);minute=Number(clock[3]||clock[4]||0);if(clock[0].endsWith('半'))minute=30;
    if(['下午','晚上'].includes(clock[1])&&hour<12)hour+=12;
    if(['上午','早上'].includes(clock[1])&&hour===12)hour=0;
    if(clock[1]==='中午'&&hour<12)hour+=12;
    if(hour>23||minute>59)return {due_on:date,due_at:null,date_note:'時間無效，待確認'};
  }else if(/中午/u.test(value))hour=12;
  const at=hour===null?null:new Date(`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+08:00`).toISOString();
  return {due_on:date,due_at:at,date_note:note};
}
export function workQueryDate(request,anchor){
  if(!/行程|會議|待辦|工作|任務|到期|期限/u.test(request))return null;
  const relative=/(今天|今日|明天|明日|後天)/u.exec(request);
  if(relative)return normalizeWorkDate(relative[1],anchor).due_on;
  const date=/(?<!\d)(?:(\d{4})[\/.-])?(\d{1,2})[\/.-](\d{1,2})(?!\d)/u.exec(request);
  return date?normalizeWorkDate(date[0],anchor).due_on:null;
}

function explicitCreateOwner(request){
  if(/如果|假如|可能|尚未|未定|待確認|不要|不得|不是|不由|是否|能否|或者|[？?]/u.test(request))return null;
  const owners=[...request.matchAll(/由\s*([^，,。；;：:\n]{1,100}?)\s*負責/gu)].map(m=>m[1].trim());
  if(owners.length!==1||!owners[0]||/或/u.test(owners[0]))return null;
  return owners[0]==='我'?'管理者':owners[0];
}

export function validateWorkActions(value,{records=[],messages=[],request,createdAt,context=null}) {
  if(!value||Object.keys(value).sort().join(',')!=='actions'||!Array.isArray(value.actions)||value.actions.length<1||value.actions.length>3)throw new Error('invalid_work_output');
  const known=new Map(records.filter(r=>r.available!==false).map(r=>[r.code,r]));
  const refs=new Map(messages.map(m=>[m.ref,m])); const targets=new Set();
  return value.actions.map(action=>{
    if(!action||Object.keys(action).sort().join(',')!=='due_text,kind,operation,owner,refs,status,target,title,topic')throw new Error('invalid_work_output');
    if(!['create','update'].includes(action.operation)||!KIND[action.kind]||!STATE[action.status]||!Array.isArray(action.refs)||action.refs.length>20||action.refs.some(r=>!refs.has(r)))throw new Error('invalid_work_output');
    const previous=action.operation==='update'?known.get(action.target):null;
    if(action.operation==='create'?action.target!==null:!previous||targets.has(action.target))throw new Error('invalid_work_target');
    if(previous)targets.add(action.target);
    const body={kind:action.kind,topic:text(action.topic,80),title:text(action.title,500),owner:text(action.owner,100,true),due_text:text(action.due_text,200,true),status:action.status};
    // A single explicit assignment in the owner's direct request must survive model omission.
    // This only fills a new single action, never infers assignments from ambiguous discussions.
    const assigned=value.actions.length===1&&action.operation==='create'?explicitCreateOwner(request):null;
    if(assigned&&body.owner&&body.owner!==assigned)throw new Error('conflicting_work_owner');
    if(assigned&&body.owner===null)body.owner=assigned;
    const quoted=action.refs.map(r=>refs.get(r));
    const availableText=[request,context?.originalRequest,context?.previousRequest,...(context?.previousProposal?.actions||[]).flatMap(a=>[a.body.title,a.body.owner,a.body.due_text]),
      ...quoted.map(m=>m.text),...(previous?[previous.body.title,previous.body.owner,previous.body.due_text]:[])].filter(Boolean).join('\n');
    const selfAssigned=value=>/我(?:來|會|要|負責)|由我/u.test(value);
    const speakerOwner=quoted.some(m=>m.speaker===body.owner&&selfAssigned(m.text));
    const requestOwner=body.owner==='管理者'&&selfAssigned(request);
    if(body.owner&&!availableText.includes(body.owner)&&!speakerOwner&&!requestOwner)throw new Error('ungrounded_work_owner');
    if(body.due_text&&!availableText.includes(body.due_text))throw new Error('ungrounded_work_date');
    const anchor=quoted.findLast(m=>body.due_text&&m.text.includes(body.due_text))?.at||createdAt;
    const normalized=previous&&body.due_text===previous.body.due_text
      ?{due_on:previous.body.due_on,due_at:previous.body.due_at,date_note:previous.body.date_note}
      :normalizeWorkDate(body.due_text,anchor);
    return {operation:action.operation,target:action.target,expected_version:previous?.version??null,
      body:{...body,...normalized},previous_body:previous?.body||null,refs:[...new Set(action.refs)]};
  });
}

export function describeWork(item) {
  const b=item.body;
  const when=b.due_at?new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(b.due_at)):b.due_on;
  return `${item.code}｜${KIND[b.kind]}｜${b.topic}\n${b.title}\n負責：${b.owner||'未指定'}；期限／時間：${b.due_text||'未指定'}${when?` → ${when}`:''}\n狀態：${STATE[b.status]}${b.date_note?`\n日期說明：${b.date_note}`:''}`;
}

export function renderProposal(proposal) {
  const lines=[`綺綺 KIKI｜待確認工作提案 ${proposal.code}`,'以下尚未寫入正式工作紀錄：'];
  for(const [i,a] of proposal.actions.entries()){
    lines.push('',`${i+1}. ${a.operation==='create'?'新增':'更新'}${a.operation==='update'?`（目前版本 ${a.expected_version}）`:''}`,
      ...(a.previous_body?['變更前：',describeWork({code:a.target,body:a.previous_body}),'變更後：']:[]),
      describeWork({code:a.target||'確認後產生代碼',body:a.body}));
  }
  lines.push('',`10 分鐘內，請真正 @KIKI 輸入「確認 ${proposal.code}」或「取消提案 ${proposal.code}」。`,'確認前若原訊息或目標紀錄改變，提案會停止套用。');
  const result=lines.join('\n');if(result.length>4300)throw new Error('work_preview_too_long');return result;
}
