import { decryptReplyToken, helpText, taipeiDay } from './assistant-command.js';
import { AssistantError } from './assistant-clients.js';
import { UNSUPPORTED_TASK } from './assistant-dialogue.js';
import { resolveRequestPlan } from './assistant-scope.js';

const time = value => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));

export function renderSummary(job, snapshot, summary) {
  const refs = new Map(snapshot.messages.map(m => [m.ref, `${m.ref} ${time(m.at)}`]));
  const evidence = list => `〔${list.map(ref => refs.get(ref)).join('、')}〕`;
  const lines = [`綺綺 KIKI｜${job.kind === 'todos' ? '今日待辦' : '今日摘要'}`, `${taipeiDay(job.range_start).day}｜截至 ${time(snapshot.readAt || job.created_at)}｜以已保存訊息為限`,
    `符合範圍 ${snapshot.total} 則，本次整理 ${snapshot.messages.length} 則${job.keyword ? `｜主題：${job.keyword}` : ''}`];
  if (snapshot.truncated) lines.push('注意：僅涵蓋最近部分訊息，部分長文已節錄，並非完整全日摘要。');
  if (job.kind !== 'todos') {
    lines.push('', '重點');
    lines.push(...(summary.summary.length ? summary.summary.map(p => `• ${p.text}${evidence(p.refs)}`) : ['• 尚無足夠內容。']));
    lines.push('', '明確結論');
    lines.push(...(summary.decisions.length ? summary.decisions.map(p => `• ${p.text}${evidence(p.refs)}`) : ['• 未見明確決議。']));
  }
  lines.push('', '待辦');
  lines.push(...(summary.todos.length ? summary.todos.map(p => `• ${p.task}\n  負責：${p.owner ?? '未指定'}；期限：${p.due ?? '未指定'}${evidence(p.refs)}`) : ['• 未見明確待辦。']));
  lines.push('', 'AI 整理，請依引述時間核對原始討論。');
  const output = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > 4200) { output.push('（內容較長，以上僅顯示部分整理結果。）'); break; }
    output.push(line); size += line.length + 1;
  }
  return output.join('\n');
}

export function renderDialogue(job, plan, snapshot, answer) {
  const lines = [`綺綺 KIKI｜${answer.title}`];
  if (snapshot) {
    lines.push(`${snapshot.scopeLabel || taipeiDay(job.range_start).day}｜截至 ${time(snapshot.readAt)}｜以已保存訊息為限`,
      `符合範圍${snapshot.totalIsLowerBound ? '至少' : ''} ${snapshot.total} 則，本次使用 ${snapshot.messages.length} 則${plan.keyword ? `｜主題：${plan.keyword}` : ''}`);
    if (plan.eventDate) lines.push(`查找行程日期：${plan.eventDate.year ? plan.eventDate.year+'/' : ''}${plan.eventDate.month}/${plan.eventDate.day}（依群組文字）`);
    if (snapshot.truncated) lines.push('注意：僅涵蓋最近部分訊息，部分長文已節錄，並非完整全日內容或全部歷史。');
  }
  const refs = new Map((snapshot?.messages || []).map(m => [m.ref,
    `${m.ref} ${snapshot.history ? taipeiDay(m.at).day+' ' : ''}${time(m.at)}`]));
  for (const block of answer.blocks) {
    lines.push('', block.text + (block.refs.length ? `〔${block.refs.map(ref => refs.get(ref)).join('、')}〕` : ''));
  }
  const footer = snapshot ? 'AI 整理，請依引述時間核對原始討論。'
    : plan.mode === 'draft' ? 'AI 草稿，請核對後使用。' : 'AI 回覆，請核對內容。';
  const output = [];
  let size = footer.length + 100;
  for (const line of lines) {
    if (size + line.length + 1 > 4200) { output.push('（內容較長，以上僅顯示部分結果。）'); break; }
    output.push(line); size += line.length + 1;
  }
  return output.concat(['',footer]).join('\n');
}

export class AssistantWorker {
  constructor({ config, store, summarizer, dialogue, replier, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { config, store, summarizer, dialogue, replier, log, now });
    this.stopping = false; this.pending = null; this.timer = null; this.abort = new AbortController();
  }
  start() {
    this.timer = setInterval(() => this.wake(), 10000); this.timer.unref(); this.wake();
  }
  wake() {
    if (this.stopping || this.pending) return;
    this.pending = this.drain().catch(() => this.log('assistant_worker_unavailable'))
      .finally(() => { this.pending = null; });
  }
  async stop() { this.stopping = true; clearInterval(this.timer); this.abort.abort(); await this.pending; }
  async drain() {
    await this.store.expire();
    for (let i = 0; !this.stopping && i < 10; i++) {
      const job = await this.store.claim();
      if (!job) return;
      await this.process(job);
    }
  }
  async process(job) {
    let attemptedReply = false, snapshot = null;
    const metrics = {};
    const remaining = () => new Date(job.expires_at).getTime() - this.now();
    const send = async text => {
      if (this.stopping || remaining() < 1000) throw new AssistantError('expired');
      if (!await this.store.unchanged(job, snapshot)) throw new AssistantError('source_changed');
      attemptedReply = true;
      await this.replier.reply(decryptReplyToken(job.encrypted_reply_token, this.config.secret), text,
        { signal: this.abort.signal, timeout: Math.min(6000, remaining()) });
    };
    try {
      if (!await this.store.current(job)) throw new AssistantError('source_changed');
      let text;
      if (job.kind === 'help' || job.kind === 'unsupported') text = job.kind === 'help' ? helpText(this.config)
        : `${this.config.assistant.freeformEnabled ? '這次要求無法處理，請將每次文字控制在 8,000 字元內並附上原文。' : '目前支援的指令如下：'}\n${helpText(this.config)}`;
      else if (job.kind === 'rate_limited') text = job.notice_reason === 'daily_limit'
        ? '今天的 AI 請求已達上限，明天再試。一般訊息仍會持續收錄。'
        : '上一個 AI 請求剛送出，請稍候再下指令。';
      else if (job.kind === 'status') {
        const status = await this.store.status(job);
        text = `綺綺 KIKI｜狀態\n${status.day}（臺北）\n今日已保存 ${status.messages} 則訊息。\n今日已接受 ${status.used} 次 AI 請求，上限 ${status.dailyLimit} 次。\n只接受管理者在此群組標記 KIKI 的要求。`;
      } else if (job.kind === 'assist') {
        if (!this.config.assistant.freeformEnabled || !this.dialogue) throw new AssistantError('source_changed');
        if (remaining() < 9000) throw new AssistantError('expired');
        const request = await this.store.readRequest(job);
        if (!request || !await this.store.unchanged(job, null)) throw new AssistantError('source_changed');
        const deadline = this.now() + Math.min(20000, remaining() - 7000);
        const aiRemaining = () => {
          const ms = Math.min(deadline - this.now(), remaining() - 7000);
          if (ms < 1000) throw new AssistantError('expired');
          return ms;
        };
        const addUsage = result => {
          for (const key of ['inputTokens','outputTokens']) {
            const value = result[key];
            metrics[key] = !Number.isSafeInteger(value) || value < 0 ? null
              : metrics[key] === undefined ? value : metrics[key] === null ? null : metrics[key] + value;
          }
        };
        const proposed = await this.dialogue.plan(request, job.range_start,
          { signal: this.abort.signal, timeout: Math.min(6000, aiRemaining()) });
        addUsage(proposed);
        const plan = resolveRequestPlan(proposed, request, job);
        if (plan.mode === 'unsupported') text = UNSUPPORTED_TASK;
        else if (plan.mode === 'clarify') text = `綺綺 KIKI｜待確認\n${plan.clarification}`;
        else {
          if (!await this.store.unchanged(job, null)) throw new AssistantError('source_changed');
          if (['group_today','group_history'].includes(plan.mode)) snapshot = await this.store.readMessages({ ...job,
            keyword: plan.keyword, history: plan.history, eventDate: plan.eventDate, scopeLabel: plan.scopeLabel,
            range_start: plan.sourceStart, range_end: plan.sourceEnd });
          metrics.messageCount = snapshot?.messages.length || 0; metrics.truncated = snapshot?.truncated || false;
          if (snapshot && !snapshot.messages.length) text = `${plan.scopeLabel}中尚無符合範圍的文字；這不代表沒有其他行程或討論。`;
          else {
            if (!await this.store.unchanged(job, snapshot)) throw new AssistantError('source_changed');
            const answer = await this.dialogue.answer(request, plan, snapshot,
              { signal: this.abort.signal, timeout: aiRemaining() });
            addUsage(answer); text = renderDialogue(job, plan, snapshot, answer);
          }
        }
      } else if (['summary','todos'].includes(job.kind)) {
        if (remaining() < 9000) throw new AssistantError('expired');
        snapshot = await this.store.readMessages(job);
        metrics.messageCount = snapshot.messages.length; metrics.truncated = snapshot.truncated;
        if (!snapshot.messages.length) text = '今天尚無符合範圍、可供整理的已保存訊息。';
        else {
          if (!await this.store.unchanged(job, snapshot)) throw new AssistantError('source_changed');
          if (remaining() < 8000) throw new AssistantError('expired');
          const result = await this.summarizer.summarize(job, snapshot,
            { signal: this.abort.signal, timeout: Math.min(20000, remaining() - 7000) });
          metrics.inputTokens = result.inputTokens; metrics.outputTokens = result.outputTokens;
          text = renderSummary(job, snapshot, result);
        }
      } else throw new AssistantError('invalid_job_kind');
      await send(text);
      await this.store.finish(job, 'sent', null, metrics);
      this.log('assistant_job_finished', { kind: job.kind, status: 'sent', message_count: metrics.messageCount ?? 0 });
    } catch (error) {
      const code = error instanceof AssistantError ? error.code : 'assistant_failed';
      const canceled = code === 'source_changed';
      if (!attemptedReply && !canceled && !this.stopping && remaining() > 1500) {
        try { await send(code === 'ai_refused' ? '這次內容無法整理，請查看原始討論。' : '這次整理未完成，請稍後重新下指令。'); } catch {}
      }
      await this.store.finish(job, canceled ? 'canceled' : code === 'expired' ? 'expired' : 'failed', code, metrics);
      this.log('assistant_job_finished', { kind: job.kind, status: canceled ? 'canceled' : 'failed', error_code: code });
    }
  }
}
