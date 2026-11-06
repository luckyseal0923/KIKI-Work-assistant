import { decryptReplyToken, helpText, taipeiDay } from './assistant-command.js';
import { AssistantError } from './assistant-clients.js';
import { UNSUPPORTED_TASK } from './assistant-dialogue.js';
import { resolveRequestPlan } from './assistant-scope.js';
import {workspaceControl,isFollowup,fastFollowup,describeWork,renderProposal,workQueryDate} from './work-actions.js';

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
    `${m.ref} ${snapshot.history ? taipeiDay(m.at).day+' ' : ''}${time(m.at)}${m.speaker?' '+m.speaker:''}`]));
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
  constructor({ config, store, summarizer, dialogue, workspace, replier, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { config, store, summarizer, dialogue, workspace, replier, log, now });
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
    await this.workspace?.expire();
    for (let i = 0; !this.stopping && i < 10; i++) {
      const job = await this.store.claim();
      if (!job) return;
      await this.process(job);
    }
  }
  async process(job) {
    let attemptedReply = false, snapshot = null,cacheContext=false,contextScope={},pendingApi=false;
    const metrics = {};
    const remaining = () => new Date(job.expires_at).getTime() - this.now();
    const send = async text => {
      if (this.stopping || remaining() < 1000) throw new AssistantError('expired');
      if (!await this.store.unchanged(job, snapshot)) throw new AssistantError('source_changed');
      if(this.workspace&&!await this.workspace.unchanged(job,snapshot))throw new AssistantError('source_changed');
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
        if(this.workspace){const usage=await this.workspace.usage(job);text+=`\n今日已記錄輸入／輸出：${usage.today.input}／${usage.today.output} tokens。\n模型費用估算：今日 US$${usage.today.usd.toFixed(4)}；本月 US$${usage.month.usd.toFixed(4)}。\n依 ${usage.asOf} 標準未快取牌價估算，非實際帳單。${usage.month.unpriced?`另有 ${usage.month.unpriced} 筆缺少完整計價資料。`:''}`;}
      } else if(job.kind==='workspace'){
        if(!this.workspace)throw new AssistantError('source_changed');
        const request=await this.store.readRequest(job),control=request&&workspaceControl(request);
        if(!control)throw new AssistantError('source_changed');
        if(control.action==='reset'){await this.workspace.clearContext(job);text='已清除短期對話記憶。原始群組紀錄與正式工作仍可查詢。';}
        else if(control.action==='discard')text=await this.workspace.discard(job,control.code);
        else if(control.action==='pending'){
          const pending=await this.workspace.pending(job);
          text=pending.length===1?renderProposal(pending[0]):pending.length
            ?'綺綺 KIKI｜待確認提案\n'+pending.map(p=>`${p.code}：${p.actions.length} 項動作`).join('\n')+'\n請以完整提案代碼確認或取消。':'目前沒有尚未到期的待確認提案。';
        }else if(control.action==='confirm'){
          const result=await this.workspace.apply(job,control.code);
          const notices={already_applied:'這份提案已套用，不會重複建立工作。',missing:'找不到這份提案。',expired:'提案已到期，請重新提出。',discarded:'這份提案已取消。',invalid:'這份提案已失效，請重新核對後提出。',source_changed:'來源已修改或收回，提案未套用。',conflict:'工作已有新版本，提案未套用，請重新查詢。',duplicate:'已有相同正式工作，提案未重複套用。'};
          text=result.status==='applied'?'綺綺 KIKI｜工作已確認\n'+result.items.map(describeWork).join('\n\n'):notices[result.status]||'這份提案目前無法套用。';
          if(result.status==='applied'){
            const records=[];for(const item of result.items)records.push(...(await this.workspace.readItems(job,{itemCode:item.code,status:null})).items);
            snapshot=this.workspace.recordSnapshot(records);cacheContext=true;contextScope={mode:'work_query'};
          }
        }else if(control.action==='history'){
          const events=await this.workspace.history(job,control.code);
          text=`綺綺 KIKI｜工作歷程 ${control.code}\n`+(events.length?events.map(e=>`版本 ${e.version}｜${taipeiDay(e.created_at).day} ${time(e.created_at)}\n${e.available?describeWork({code:control.code,body:e.next_body}):'來源已變更或收回，內容待重新確認。'}`).join('\n\n'):'目前找不到可查的工作歷程。');
        }else{
          const result=await this.workspace.readItems(job);
          snapshot=this.workspace.recordSnapshot(result.items);snapshot.total=result.total;snapshot.totalIsLowerBound=result.totalIsLowerBound;snapshot.truncated ||= result.totalIsLowerBound;
          text='綺綺 KIKI｜工作清單\n'+(snapshot.messages.length?snapshot.messages.map(m=>m.text).join('\n\n'):'目前沒有已確認、尚未完成的工作。');
          if(result.totalIsLowerBound)text+='\n（僅列最近20筆，請以主題縮小查詢。）';cacheContext=true;contextScope={mode:'work_query'};
        }
        metrics.messageCount=snapshot?.messages.length||0;
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
        const memory=this.workspace&&isFollowup(request)?await this.workspace.readContext(job):null;
        let proposed=fastFollowup(request,memory);
        if(!proposed){metrics.apiCalls=(metrics.apiCalls||0)+1;pendingApi=true;proposed=await this.dialogue.plan(request, job.range_start,
          { signal: this.abort.signal, timeout: Math.min(6000, aiRemaining()),context:memory });pendingApi=false;}
        addUsage(proposed);
        let plan = this.workspace&&['followup','work_query','work_propose'].includes(proposed.mode)?proposed:resolveRequestPlan(proposed, request, job);
        if(proposed.inheritedQuery)plan={...proposed,history:true,eventDate:proposed.inheritedQuery.eventDate,
          sourceStart:proposed.inheritedQuery.range_start,sourceEnd:proposed.inheritedQuery.range_end,scopeLabel:proposed.inheritedQuery.scopeLabel};
        if(plan.mode==='followup'&&!memory)plan={mode:'clarify',keyword:null,clarification:'找不到仍有效的前一段對話，請附上原文或指定要查的主題。'};
        if(!this.workspace&&['followup','work_query','work_propose'].includes(plan.mode))throw new AssistantError('invalid_ai_plan');
        if (plan.mode === 'unsupported') text = UNSUPPORTED_TASK;
        else if (plan.mode === 'clarify') text = `綺綺 KIKI｜待確認\n${plan.clarification}`;
        else {
          if (!await this.store.unchanged(job, null)) throw new AssistantError('source_changed');
          if(plan.mode==='followup')snapshot=memory.snapshot;
          else if(plan.mode==='work_query'){
            const itemCode=request.match(/\bW[0-9A-F]{8}\b/iu)?.[0]?.toUpperCase()||plan.inheritedItemCode||null;
            const status=/已完成/u.test(request)?'done':/已取消/u.test(request)?'canceled':/全部/u.test(request)?null:'open';
            const dueOn=workQueryDate(request,job.created_at);
            const keyword=!dueOn&&plan.keyword&&!/^(工作|任務|待辦|決議|行程|未完成|已完成|進度|狀態)$/u.test(plan.keyword)?plan.keyword:null;
            const result=await this.workspace.readItems(job,{itemCode,status,keyword,dueOn,kind:/行程/u.test(request)&&!/待辦|工作|任務/u.test(request)?'event':null});
            snapshot=this.workspace.recordSnapshot(result.items);snapshot.total=result.total;snapshot.totalIsLowerBound=result.totalIsLowerBound;snapshot.truncated ||= result.totalIsLowerBound;
          }else if(plan.mode==='work_propose'){
            const itemCode=request.match(/\bW[0-9A-F]{8}\b/iu)?.[0]?.toUpperCase()||plan.inheritedItemCode||null;
            const createOnly=/新增|建立|記下|幫我記/u.test(request)&&!itemCode&&!memory;
            const recordKeyword=plan.keyword&&!/^(工作|任務|待辦|決議|行程|未完成|已完成|進度|狀態)$/u.test(plan.keyword)?plan.keyword:null;
            let records=createOnly?[]:memory?.records?.length&&!itemCode?memory.records:
              (await this.workspace.readItems(job,{itemCode,status:null,keyword:recordKeyword})).items;
            if(memory?.snapshot)snapshot=memory.snapshot;
            if(['today','history'].includes(plan.source_scope)&&/討論|訊息|群組|紀錄|根據/u.test(request)){
              const sourcePlan=resolveRequestPlan({...plan,mode:plan.source_scope==='today'?'group_today':'group_history'},request,job);
              if(sourcePlan.mode==='clarify')throw new AssistantError('invalid_work_range');
              snapshot=await this.store.readMessages({...job,keyword:sourcePlan.keyword,searchTerms:sourcePlan.search_terms||[],history:sourcePlan.history,range_start:sourcePlan.sourceStart,range_end:sourcePlan.sourceEnd,scopeLabel:sourcePlan.scopeLabel});
            }
            ({records,snapshot}=this.workspace.proposalInput(snapshot,records));
            if(!await this.store.unchanged(job,snapshot)||!await this.workspace.unchanged(job,snapshot))throw new AssistantError('source_changed');
            metrics.apiCalls=(metrics.apiCalls||0)+1;
            pendingApi=true;
            const result=await this.dialogue.propose(request,{records,snapshot,context:memory,createdAt:job.created_at},{signal:this.abort.signal,timeout:aiRemaining()});
            pendingApi=false;
            addUsage(result);
            const proposal=await this.workspace.createProposal(job,result.actions,snapshot,records,memory?.previousProposal);
            snapshot ||= {messages:[],ids:[],versions:[],sourceRefs:[],total:0,truncated:false,readAt:new Date().toISOString()};
            snapshot.workspaceSourceRefs=proposal.sources;
            text=renderProposal(proposal);cacheContext=true;contextScope={mode:'work_propose',proposalCode:proposal.code};
          }else if (['group_today','group_history'].includes(plan.mode)) snapshot = await this.store.readMessages({ ...job,
            keyword: plan.keyword,searchTerms:plan.search_terms||[], history: plan.history, eventDate: plan.eventDate, scopeLabel: plan.scopeLabel,
            range_start: plan.sourceStart, range_end: plan.sourceEnd });
          if(this.workspace&&plan.eventDate&&!proposed.inheritedQuery){
            const dueOn=plan.eventDate.year?`${plan.eventDate.year}-${String(plan.eventDate.month).padStart(2,'0')}-${String(plan.eventDate.day).padStart(2,'0')}`:null;
            const records=(await this.workspace.readItems(job,{status:null,dueOn,eventDate:plan.eventDate,kind:/行程/u.test(request)?'event':null})).items;
            snapshot=this.workspace.appendRecords(snapshot,records);
          }
          metrics.messageCount = snapshot?.messages.length || 0; metrics.truncated = snapshot?.truncated || false;
          if(plan.mode!=='work_propose'&&snapshot && !snapshot.messages.length) text = plan.mode==='work_query'
            ?'目前沒有符合條件的已確認工作。尚未確認的內容請查「待確認提案」。'
            :`${plan.scopeLabel||'本次範圍'}中尚無符合範圍的文字；這不代表沒有其他行程或討論。`;
          else if(plan.mode!=='work_propose') {
            if (!await this.store.unchanged(job, snapshot)) throw new AssistantError('source_changed');
            metrics.apiCalls=(metrics.apiCalls||0)+1;
            pendingApi=true;
            const answer = await this.dialogue.answer(request, plan, snapshot,
              { signal: this.abort.signal, timeout: aiRemaining(),context:memory });
            pendingApi=false;
            addUsage(answer); text = renderDialogue(job, plan, snapshot, answer);
            cacheContext=Boolean(this.workspace);contextScope={mode:plan.mode,keyword:plan.keyword,query:snapshot?.query||null};
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
          metrics.apiCalls=(metrics.apiCalls||0)+1;
          pendingApi=true;
          const result = await this.summarizer.summarize(job, snapshot,
            { signal: this.abort.signal, timeout: Math.min(20000, remaining() - 7000) });
          pendingApi=false;
          metrics.inputTokens = result.inputTokens; metrics.outputTokens = result.outputTokens;
          text = renderSummary(job, snapshot, result);
          cacheContext=Boolean(this.workspace);contextScope={mode:job.kind,query:snapshot.query||null};
        }
      } else throw new AssistantError('invalid_job_kind');
      text=text.slice(0,4500);
      await send(text);
      await this.store.finish(job, 'sent', null, metrics);
      if(cacheContext)try{await this.workspace.saveContext(job,text,snapshot,contextScope);}catch{this.log('assistant_context_unavailable');}
      this.log('assistant_job_finished', { kind: job.kind, status: 'sent', message_count: metrics.messageCount ?? 0 });
    } catch (error) {
      if(pendingApi){metrics.inputTokens=null;metrics.outputTokens=null;}
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
