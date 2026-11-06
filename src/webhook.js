import { createHmac, timingSafeEqual } from 'node:crypto';
import { GROUP_ID } from './config.js';
import { assistantJobForEvent } from './assistant-command.js';

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
    if (source.groupId !== config.allowedGroupId) continue;
    if (!['message', 'messageEdited', 'unsend'].includes(event.type)) continue;
    if (event.type !== 'unsend' && event.message?.type !== 'text') continue;
    const base = {
      kind: event.type,
      eventId: id(event.webhookEventId),
      groupId: source.groupId,
      at: timestamp(event.timestamp),
    };
    if (event.type === 'unsend') {
      events.push({ ...base, messageId: id(event.unsend?.messageId) });
    } else {
      const message = event.message;
      if (typeof message.text !== 'string' || message.text.includes('\0') || message.text.length > 100000) {
        throw new HttpError(400);
      }
      const assistantJob = assistantJobForEvent(event, config);
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
