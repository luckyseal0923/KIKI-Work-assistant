import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequestPlan, eventDatePattern } from '../src/assistant-scope.js';

const job={created_at:'2026-11-06T15:40:00.000Z'};
const plan=mode=>({mode,keyword:null,clarification:null});

test('an explicit topic code narrows group reads even if the model omits or broadens its keyword',()=>{
  for(const keyword of [null,'討論']) {
    const result=resolveRequestPlan({...plan('group_today'),keyword},'把今天 KIKI-NL-20261106-02 的討論整理成會議紀錄',job);
    assert.equal(result.keyword,'KIKI-NL-20261106-02'); assert.equal(result.history,false);
  }
  assert.equal(resolveRequestPlan(plan('group_history'),'找出 KIKI-NL-01 和 KIKI-NL-02 的紀錄',job).mode,'clarify');
});

test('a date in a saved schedule query means event date, not posting date or external calendar access',()=>{
  const result=resolveRequestPlan(plan('unsupported'),'11/10 我有什麼行程',job);
  assert.equal(result.mode,'group_history'); assert.equal(result.sourceStart,'1970-01-01T00:00:00.000Z');
  assert.equal(result.sourceEnd,job.created_at); assert.equal(result.eventDate.month,11); assert.equal(result.eventDate.day,10);
  assert.equal(result.keyword,null);
  for(const text of ['查詢 Google 行事曆，11/10 我有什麼行程','11/10 有哪些行程，請寄信通知我']) {
    assert.equal(resolveRequestPlan(plan('unsupported'),text,job).mode,'unsupported');
  }
  assert.equal(resolveRequestPlan(plan('draft'),'把「11/10 我有什麼行程」改成正式公告',job).mode,'draft');
  assert.equal(resolveRequestPlan(plan('answer'),'解釋「11/10 我有什麼行程」是什麼意思',job).mode,'answer');
  assert.equal(resolveRequestPlan(plan('group_history'),'11/32 我有什麼行程',job).mode,'clarify');
  assert.equal(resolveRequestPlan(plan('group_history'),'11/5 和 11/10 有什麼行程',job).mode,'clarify');
});

test('history windows use Taipei posting dates and cannot extend after the current request',()=>{
  const yesterday=resolveRequestPlan(plan('group_history'),'找出昨天 OSCE 討論的決議',job);
  assert.equal(yesterday.sourceStart,'2026-11-04T16:00:00.000Z'); assert.equal(yesterday.sourceEnd,'2026-11-05T16:00:00.000Z');
  const lastWeek=resolveRequestPlan(plan('group_history'),'整理上週的群組訊息',job);
  assert.equal(lastWeek.sourceStart,'2026-10-25T16:00:00.000Z'); assert.equal(lastWeek.sourceEnd,'2026-11-01T16:00:00.000Z');
  const dates=resolveRequestPlan(plan('group_history'),'找出 2026/11/01 到 2026/11/06 的 OSCE 討論',job);
  assert.equal(dates.sourceStart,'2026-10-31T16:00:00.000Z'); assert.equal(dates.sourceEnd,job.created_at);
  assert.equal(resolveRequestPlan(plan('group_history'),'整理 2026/11/10 的訊息',job).mode,'clarify');
  const recent=resolveRequestPlan(plan('group_history'),'整理最近 7 天的討論',job);
  assert.equal(recent.sourceStart,'2026-10-30T16:00:00.000Z');
  assert.equal(resolveRequestPlan(plan('group_history'),'找出過去 OSCE 的決議',job).history,true);
});

test('event date filters accept equivalent month/day spellings and reject unrelated dates or model patterns',()=>{
  const pattern=eventDatePattern({month:11,day:10}); const match=new RegExp(pattern,'u');
  for(const text of ['11/10 07:00 合成行程','11-10 合成行程','11月10日 合成行程','2026/11/10 合成行程']) assert.match(text,match);
  for(const text of ['11/01 合成行程','11/100 合成行程','111/10 合成行程']) assert.doesNotMatch(text,match);
  assert.throws(()=>eventDatePattern({month:'11|.*',day:10}));
  const year=new RegExp(eventDatePattern({month:11,day:10,year:2026}),'u');
  for(const text of ['2026/11/10 合成','2026年11月10日 合成','11/10 合成']) assert.match(text,year);
  for(const text of ['2027/11/10 合成','2027年11月10日 合成']) assert.doesNotMatch(text,year);
  assert.equal(eventDatePattern(null),null);
});
