import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { workspaceControl } from './work-actions.js';
import {readCardAction} from './assistant-cards.js';

export const USER_ID = /^U[0-9a-f]{32}$/i;
const OFFSET = 8 * 60 * 60 * 1000;

export function taipeiDay(at = Date.now()) {
  const date = new Date(at);
  const day = new Date(date.getTime() + OFFSET).toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00+08:00`);
  return { day, start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

function tokenKey(secret) {
  return Buffer.from(hkdfSync('sha256', secret, 'kiki-reply-token', 'assistant-v1', 32));
}

export function encryptReplyToken(token, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptReplyToken(encoded, secret) {
  const data = Buffer.from(encoded, 'base64');
  if (data.length < 30 || data[0] !== 1) throw new Error('Invalid encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(secret), data.subarray(1, 13));
  decipher.setAuthTag(data.subarray(13, 29));
  return Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]).toString('utf8');
}

export function parseCommand(text, { freeformEnabled = false, workspaceEnabled=false,organizerEnabled=false,multiGroupEnabled=false } = {}) {
  const value = text.trim().replace(/[，,。.!！]+$/u, '').trim();
  const control=workspaceEnabled&&workspaceControl(value);
  if(control&&(!['topics','topic','topic_define','topic_invalid','work_state'].includes(control.action)||organizerEnabled)
    &&(!control.action.startsWith('group')||multiGroupEnabled))return {kind:'workspace',keyword:control.action==='group_enroll'?'group_enroll':control.action.startsWith('group')?'group_control':null};
  if (/^(幫助|說明|help)$/iu.test(value)) return { kind: 'help', keyword: null };
  if (/^(狀態|status)$/iu.test(value)) return { kind: 'status', keyword: null };
  if (/^整理今天討論[，,]?\s*列出結論與待辦$/u.test(value)) return { kind: 'summary', keyword: null };
  const match = /^(今日摘要|今天摘要|整理今天|今日待辦|今天待辦)(?:\s+(.{1,60}))?$/u.exec(value);
  if (match) {
    if (freeformEnabled && match[2] && /\s|[，,。！？!?：:]|請|幫我|詳細|簡短|改成|寫成|列出|條列|表格/u.test(match[2])) {
      return { kind: 'assist', keyword: null };
    }
    return { kind: match[1].includes('待辦') ? 'todos' : 'summary', keyword: match[2]?.trim() || null };
  }
  if (freeformEnabled && value) return { kind: 'assist', keyword: null };
  if (!value) return { kind: 'help', keyword: null };
  return { kind: 'unsupported', keyword: null };
}

// Called only after the raw-body signature and exact allowed group are checked.
// Display names, plain "@KIKI" strings and the first person to speak confer no authority.
export function assistantJobForEvent(event, config, now = Date.now()) {
  const assistant = config.assistant;
  if (!assistant?.enabled || event.type !== 'message' || event.message?.type !== 'text' ||
      event.source?.groupId !== config.allowedGroupId || event.source?.userId !== assistant.operatorUserId) return null;
  const text = event.message.text;
  const mentions = event.message.mention?.mentionees;
  const self = Array.isArray(mentions) ? mentions.filter(m => m?.type === 'user' && m.isSelf === true) : [];
  if (!Array.isArray(self) || self.length !== 1 || typeof text !== 'string') return null;
  const { index, length } = self[0];
  if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || length < 1 ||
      index + length > text.length || text.slice(0, index).trim()) return null;
  const token = event.replyToken;
  if (typeof token !== 'string' || token.length > 512 || !token.length || /[\s\x00-\x1f\x7f]/u.test(token)) return null;
  if (!Number.isSafeInteger(event.timestamp) || event.timestamp < now - 19 * 60000 || event.timestamp > now + 120000) return null;
  const maximum = assistant.freeformEnabled ? 8000 : 500;
  const command = text.length > maximum ? { kind: 'unsupported', keyword: null }
    : parseCommand(text.slice(index + length), assistant);
  const range = taipeiDay(event.timestamp);
  const quota = taipeiDay(now);
  return {
    ...command,
    ...(['assist','workspace'].includes(command.kind) ? { requestOffset: index + length } : {}),
    operatorUserId: assistant.operatorUserId,
    sourceDigest: createHash('sha256').update(text).digest('hex'),
    rangeStart: range.start, rangeEnd: range.end,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 45000).toISOString(),
    quotaStart: quota.start, quotaEnd: quota.end,
    dailyLimit: assistant.dailyLimit, cooldownSeconds: assistant.cooldownSeconds,
    quotaScope:assistant.multiGroupEnabled?'shared':'group',
    encryptedReplyToken: encryptReplyToken(token, config.secret),
  };
}

export function assistantJobForAction(event,config,now=Date.now()){
  if(!config.assistant?.organizerEnabled||event.type!=='postback'||event.source?.type!=='group'
    ||event.source.groupId!==config.allowedGroupId||event.source.userId!==config.assistant.operatorUserId)return null;
  const action=readCardAction(event.postback?.data,config,now);
  const token=event.replyToken;
  if(!action||typeof token!=='string'||!token.length||token.length>512||/[\s\x00-\x1f\x7f]/u.test(token)
    ||!Number.isSafeInteger(event.timestamp)||event.timestamp<now-19*60000||event.timestamp>now+120000)return null;
  const range=taipeiDay(event.timestamp),quota=taipeiDay(now);
  return {kind:'workspace',keyword:config.enrollmentProposalCodes?.has(action.target)?'group_control':null,sourceKind:'action',requestOffset:0,command:action.command,
    operatorUserId:config.assistant.operatorUserId,sourceDigest:createHash('sha256').update(action.command).digest('hex'),
    rangeStart:range.start,rangeEnd:range.end,quotaStart:quota.start,quotaEnd:quota.end,
    createdAt:new Date(now).toISOString(),expiresAt:new Date(now+45000).toISOString(),
    dailyLimit:config.assistant.dailyLimit,cooldownSeconds:config.assistant.cooldownSeconds,quotaScope:config.assistant.multiGroupEnabled?'shared':'group',encryptedReplyToken:encryptReplyToken(token,config.secret)};
}

export const HELP_TEXT = '綺綺 KIKI｜智慧秘書\n請先從群組成員清單真正 @KIKI，再輸入：\n• 幫助\n• 狀態\n• 今日摘要\n• 今日待辦\n也可加關鍵字，例如：今日摘要 OSCE。\n摘要使用臺北時間今日、目前仍保存的訊息，結果會回到這個群組。';

export function helpText(config) {
  return HELP_TEXT + (config.assistant?.freeformEnabled
    ? '\n\n也可以直接交辦：\n• 解釋什麼是 SMART 目標\n• 把今天討論整理成會議紀錄\n• 找出過去 OSCE 討論的決議\n• 11/10 我有什麼行程\n• 將下面文字改成正式公告：……\n可查 KIKI 開始收錄後，本群仍保存的歷史文字；回覆會附來源時間，超出上限會標示部分內容。'+(config.assistant.workspaceEnabled?'':'\n每次標記獨立處理；修改草稿時請附上原文。')+'\n不執行寄信、排入外部行事曆或其他系統操作。'
    : '')+(config.assistant?.workspaceEnabled?'\n\n工作秘書：\n• 工作清單\n• 待確認提案\n• 確認 P提案代碼\n• 取消提案 P提案代碼\n• 工作歷程 W工作代碼\n• 重置對話\n也可直接要求新增、完成、改期或取消工作；會先提出待確認提案。對話可接續約 30 分鐘，正式工作另行保存。':'')
    +(config.assistant?.organizerEnabled?'\n\n主題與按鈕：\n• 主題清單\n• 建立主題：教學測試；別名：課程籌備、教材準備\n• 主題別名 教學測試：課程籌備、教材準備\n• 主題 教學測試\n主題別名確認後才用於本群查找，遇到歧義會請你指定；卡片按鈕仍只有管理者能操作。':'')
    +(config.assistant?.multiGroupEnabled?'\n\n多群設定：\n• 申請啟用本群：群組名稱\n• 群組狀態\n• 停用本群\n• 群組清單（限原管理群）\n啟用／停用都先預覽再確認，各群資料分開；所有群共用每日 AI 額度與請求間隔。':'');
}
