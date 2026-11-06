import { taipeiDay } from './assistant-command.js';

const DAY = 86400000;
const EXTERNAL_ACTION = /Google|Gmail|Outlook|行事曆|日曆|calendar|寄信|寄出|發送|發出|通知|提醒我|新增|建立|刪除|取消|修改|改到|幫我排|安排/iu;
const HISTORY = /過去|以前|歷史|曾經|之前|昨天|昨日|前天|上週|上周|上個月|最近|近\s*\d+\s*天/u;

function datesIn(request, year) {
  return [...request.matchAll(/(?<!\d)(?:(\d{4})[\/.-])?(\d{1,2})(?:[\/.-]|月)(\d{1,2})日?(?!\d)/gu)].map(m => {
    const y = Number(m[1] || year), month = Number(m[2]), day = Number(m[3]);
    const at = new Date(Date.UTC(y, month - 1, day));
    if (at.getUTCFullYear() !== y || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
    return { year: m[1] ? y : null, month, day, start: new Date(`${at.toISOString().slice(0,10)}T00:00:00+08:00`).getTime() };
  });
}

function eventDateQuery(request) {
  return /行程|會議|約會|聚餐|吃飯/u.test(request) && /有什麼|有哪些|有沒有|查詢|查看|列出|找出|整理/u.test(request)
    && !EXTERNAL_ACTION.test(request) && !/改寫|改成|草擬|草稿|公告|解釋|翻譯|什麼意思/u.test(request)
    && !/(?:當天|當日|昨天|昨日|上週|上周|上個月).*(?:訊息|對話|討論)/u.test(request);
}

export function eventDatePattern(date) {
  if (!date) return null;
  if (!Number.isInteger(date.month) || date.month < 1 || date.month > 12 ||
      !Number.isInteger(date.day) || date.day < 1 || date.day > 31) throw new Error('Invalid event date');
  if (date.year !== undefined && date.year !== null && (!Number.isInteger(date.year) || date.year < 1 || date.year > 9999)) throw new Error('Invalid event year');
  const month = date.month < 10 ? `0?${date.month}` : `${date.month}`;
  const day = date.day < 10 ? `0?${date.day}` : `${date.day}`;
  const year = date.year ? `${date.year}` : '[0-9]{4}';
  // Only validated numeric values enter this server-built pattern, never model SQL/regex.
  return `(^|[^0-9/.年-])(?:${year}[/.年-]\\s*)?(?:${month}\\s*[/.\\-]\\s*${day}|${month}\\s*月\\s*${day}\\s*日?)([^0-9]|$)`;
}

export function resolveRequestPlan(plan, request, job) {
  const today = taipeiDay(job.created_at), end = new Date(job.created_at).getTime();
  const year = Number(today.day.slice(0,4)), dates = datesIn(request, year);
  const eventQuery = eventDateQuery(request);
  const clarify = question => ({ ...plan, mode: 'clarify', keyword: null, clarification: question });
  if (eventQuery && dates.length && (dates.length !== 1 || !dates[0])) return clarify('請指定一個有效的行程日期，例如 11/10。');
  if (eventQuery && dates.length === 1 && dates[0]) {
    plan = { ...plan, mode: 'group_history', keyword: null, clarification: null, eventDate: dates[0],...(plan.search_terms?{search_terms:[]}: {}) };
  }
  if (!['group_today','group_history'].includes(plan.mode)) return plan;
  if (HISTORY.test(request)) plan = { ...plan, mode: 'group_history' };
  if (!eventQuery && dates.length && /訊息|對話|討論|紀錄/u.test(request)) plan = { ...plan, mode: 'group_history' };
  const codes = [...new Set(request.match(/\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+\b/giu)?.filter(v => /\d/u.test(v)) || [])];
  if (codes.some(v => v.length > 60)) return clarify('主題代碼請控制在 60 個字元內。');
  if (codes.length > 1) return clarify('請先指定一個主題代碼，讓我精確查找已保存的訊息。');
  if (codes.length === 1) plan = { ...plan, keyword: codes[0],...(plan.search_terms?{search_terms:[]}: {}) };
  if (plan.mode === 'group_today') return { ...plan, history: false,
    sourceStart: today.start, sourceEnd: today.end, scopeLabel: `本群 ${today.day} 已保存訊息` };
  let start = 0, finish = end, label = '本群已保存歷史訊息';
  const midnight = new Date(today.start).getTime();
  if (!eventQuery && dates.length && /訊息|對話|討論|紀錄/u.test(request)) {
    if (dates.some(d => !d) || dates.length > 2) return clarify('請提供有效的一個日期或起訖日期，格式例如 2026/11/01 到 2026/11/06。');
    start = dates[0].start; finish = (dates[1] || dates[0]).start + DAY;
    if (finish <= start || start > end) return clarify('指定的訊息日期尚未發生或起訖順序不正確，請確認日期。');
    label = `本群訊息日期 ${new Date(start + 8*3600000).toISOString().slice(0,10)} 至 ${new Date(finish - 1 + 8*3600000).toISOString().slice(0,10)}`;
  } else if (/昨天|昨日/u.test(request)) { start = midnight-DAY; finish = midnight; label='本群昨天已保存訊息'; }
  else if (/前天/u.test(request)) { start=midnight-2*DAY; finish=midnight-DAY; label='本群前天已保存訊息'; }
  else if (/上上週|上上周/u.test(request)) return clarify('請以起訖日期指定要查找的訊息範圍。');
  else if (/上週|上周/u.test(request)) {
    const weekday = new Date(midnight+8*3600000).getUTCDay();
    finish=midnight-((weekday+6)%7)*DAY; start=finish-7*DAY; label='本群上週已保存訊息（週一至週日）';
  } else if (/上個月/u.test(request)) {
    finish = new Date(`${today.day.slice(0,7)}-01T00:00:00+08:00`).getTime();
    const prior = new Date(finish+8*3600000); prior.setUTCMonth(prior.getUTCMonth()-1);
    start=prior.getTime()-8*3600000; label='本群上個月已保存訊息';
  } else {
    const recent=/(?:最近|過去|近)\s*(\d+)\s*天/u.exec(request);
    if (recent) {
      const n=Number(recent[1]); if (n<1 || n>366) return clarify('最近幾天可指定 1 到 366 天；更久的內容請用主題或起訖日期查找。');
      start=midnight-(n-1)*DAY; label=`本群最近 ${n} 天已保存訊息`;
    }
  }
  return { ...plan, history: true, sourceStart: new Date(start).toISOString(),
    sourceEnd: new Date(Math.min(finish,end)).toISOString(), scopeLabel: label };
}
