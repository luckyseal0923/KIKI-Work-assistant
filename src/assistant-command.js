import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

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

export function parseCommand(text) {
  const value = text.trim().replace(/[，,。.!！]+$/u, '').trim();
  if (/^(幫助|說明|help)$/iu.test(value)) return { kind: 'help', keyword: null };
  if (/^(狀態|status)$/iu.test(value)) return { kind: 'status', keyword: null };
  if (/^整理今天討論[，,]?\s*列出結論與待辦$/u.test(value)) return { kind: 'summary', keyword: null };
  const match = /^(今日摘要|今天摘要|整理今天|今日待辦|今天待辦)(?:\s+(.{1,60}))?$/u.exec(value);
  if (match) return { kind: match[1].includes('待辦') ? 'todos' : 'summary', keyword: match[2]?.trim() || null };
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
  const command = text.length > 500 ? { kind: 'unsupported', keyword: null } : parseCommand(text.slice(index + length));
  const range = taipeiDay(event.timestamp);
  const quota = taipeiDay(now);
  return {
    ...command,
    operatorUserId: assistant.operatorUserId,
    sourceDigest: createHash('sha256').update(text).digest('hex'),
    rangeStart: range.start, rangeEnd: range.end,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 45000).toISOString(),
    quotaStart: quota.start, quotaEnd: quota.end,
    dailyLimit: assistant.dailyLimit, cooldownSeconds: assistant.cooldownSeconds,
    encryptedReplyToken: encryptReplyToken(token, config.secret),
  };
}

export const HELP_TEXT = '綺綺 KIKI｜智慧秘書\n請先從群組成員清單真正 @KIKI，再輸入：\n• 幫助\n• 狀態\n• 今日摘要\n• 今日待辦\n也可加關鍵字，例如：今日摘要 OSCE。\n摘要使用臺北時間今日、目前仍保存的訊息，結果會回到這個群組。';
