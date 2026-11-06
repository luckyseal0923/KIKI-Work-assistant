import { createHmac, timingSafeEqual } from 'node:crypto';
import { GROUP_ID } from './config.js';
import { assistantJobForEvent,assistantJobForAction } from './assistant-command.js';
import {workspaceControl} from './work-actions.js';

export class HttpError extends Error {
  constructor(status) { super('Request rejected'); this.status = status; }
}

export function validSignature(raw, signature, secret) {
  // A SHA-256 digest is exactly 32 bytes / 44 base64 characters.
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const actual = Buffer.from(signature, 'base64');
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new HttpError(400);
  return value;
}

function optionalId(value) { return value == null ? null : id(value); }

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new HttpError(400);
  return new Date(value).toISOString();
}

export function selectEvents(raw, config) {
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400); }
  if (!body || !Array.isArray(body.events)) throw new HttpError(400);
  if (body.events.length > 100) throw new HttpError(413);
  const events = [];
  const candidates = new Set();
  for (const event of body.events) {
    const source = event?.source;
    if (source?.type !== 'group' || typeof source.groupId !== 'string' || !GROUP_ID.test(source.groupId)) continue;
    if (config.mode === 'discover') {
      // The bot may already have joined before the webhook was configured.
      // Accept a verified message as an identification signal, without retaining its text/user.
      if (['join', 'message', 'messageEdited', 'unsend'].includes(event.type)) candidates.add(source.groupId);
      continue;
    }
    const scoped=config.groupContexts?.get(source.groupId)||config;
    if (source.groupId !== scoped.allowedGroupId) continue;
    if(event.type==='postback'){
      const assistantJob=assistantJobForAction(event,scoped);
      const control=assistantJob&&workspaceControl(assistantJob.command);
      if(scoped.enrollmentOnly&&(!control||!['confirm','discard'].includes(control.action)||!scoped.enrollmentProposalCodes?.has(control.code)))continue;
      if(assistantJob)events.push({kind:'postback',eventId:id(event.webhookEventId),groupId:source.groupId,
        at:timestamp(event.timestamp),userId:id(source.userId),assistantJob,
        ...(!scoped.enrollmentOnly&&assistantJob.keyword!=='group_control'?{groupVersion:scoped.groupVersion}: {})});
      continue;
    }
    if (!['message', 'messageEdited', 'unsend'].includes(event.type)) continue;
    if (event.type !== 'unsend' && event.message?.type !== 'text') continue;
    const base = {
      kind: event.type,
      eventId: id(event.webhookEventId),
      groupId: source.groupId,
      at: timestamp(event.timestamp),
      ...(!scoped.enrollmentOnly&&scoped.groupVersion?{groupVersion:scoped.groupVersion}: {}),
    };
    if (event.type === 'unsend') {
      if(scoped.enrollmentOnly&&!scoped.enrollmentMessageIds?.has(event.unsend?.messageId))continue;
      events.push({ ...base, messageId: id(event.unsend?.messageId) });
    } else {
      const message = event.message;
      if (typeof message.text !== 'string' || message.text.includes('\0') || message.text.length > 100000) {
        throw new HttpError(400);
      }
      const assistantJob = assistantJobForEvent(event, scoped);
      if(scoped.enrollmentOnly){
        const knownEdit=event.type==='messageEdited'&&scoped.enrollmentMessageIds?.has(message.id);
        if(!knownEdit&&(!assistantJob||!['group_enroll','group_control'].includes(assistantJob.keyword)
          &&!(scoped.enrollmentProposalCodes?.has(workspaceControl(message.text.slice(assistantJob.requestOffset))?.code))))continue;
        if(assistantJob&&assistantJob.keyword===null)assistantJob.keyword='group_control';
      }else if(assistantJob&&['confirm','discard'].includes(workspaceControl(message.text.slice(assistantJob.requestOffset||0))?.action)
        &&scoped.enrollmentProposalCodes?.has(workspaceControl(message.text.slice(assistantJob.requestOffset||0)).code))assistantJob.keyword='group_control';
      if(assistantJob&&['group_enroll','group_control'].includes(assistantJob.keyword))delete base.groupVersion;
      events.push({
        ...base,
        messageId: id(message.id),
        userId: optionalId(source.userId),
        text: message.text,
        quotedMessageId: optionalId(message.quotedMessageId),
        ...(assistantJob ? { assistantJob } : {}),
      });
    }
  }
  return { events, candidates };
}
