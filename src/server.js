import http from 'node:http';
import { HttpError, selectEvents, validSignature } from './webhook.js';

const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let done = false;
    const timer = setTimeout(() => finish(new HttpError(408)), 5000);
    timer.unref();
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('error', fail);
      req.removeListener('aborted', abort);
      if (error) { chunks = []; req.resume(); reject(error); }
      else resolve(Buffer.concat(chunks));
    }
    function data(chunk) {
      size += chunk.length;
      if (size > MAX_BODY) finish(new HttpError(413));
      else chunks.push(chunk);
    }
    function end() { finish(); }
    function fail() { finish(new HttpError(400)); }
    function abort() { finish(new HttpError(400)); }
    req.on('data', data).once('end', end).once('error', fail).once('aborted', abort);
  });
}

function respond(res, status, ok) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(status >= 400 ? { Connection: 'close' } : {}),
  });
  res.end(JSON.stringify({ ok }));
}

export function createServer({ config, store, assistantWorker = null,groups=null, log = () => {} }) {
  let active = 0;
  let readiness = null;
  let readyUntil = 0;
  let cachedReady = false;
  // Limit candidate log volume/memory. Only discover mode emits complete group IDs.
  const discovered = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return respond(res, 200, true);
    if (req.method === 'GET' && req.url === '/readyz') {
      if (config.mode === 'discover') return respond(res, 200, true);
      if (Date.now() >= readyUntil) {
        readiness ??= store.ready().then(() => { cachedReady = true; }, () => { cachedReady = false; })
          .finally(() => { readyUntil = Date.now() + 5000; readiness = null; });
        await readiness;
      }
      return respond(res, cachedReady ? 200 : 503, cachedReady);
    }
    if (req.method !== 'POST' || req.url !== '/webhook') return respond(res, 404, false);
    // A fixed bound avoids an unbounded pool queue or body buffers during bursts.
    if (active >= 4) { req.resume(); return respond(res, 503, false); }
    active++;
    try {
      const encoding = req.headers['content-encoding'];
      if (encoding && encoding !== 'identity') throw new HttpError(415);
      const raw = await readBody(req);
      if (!validSignature(raw, req.headers['x-line-signature'], config.secret)) throw new HttpError(401);
      const routed=groups?await groups.forWebhook(raw):config;
      const { events, candidates } = selectEvents(raw, routed);
      for (const groupId of candidates) {
        if (discovered.size < 20 && !discovered.has(groupId)) {
          discovered.add(groupId);
          log('group_candidate', { group_id: groupId });
        }
      }
      // No 200 until the complete batch has committed. No volatile background queue.
      if (events.length) {
        const processed = await store.save(events);
        log('batch_committed', { processed, duplicate: events.length - processed });
        if (events.some(event => event.assistantJob)) assistantWorker?.wake();
      }
      respond(res, 200, true);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      log(status === 503 ? 'storage_unavailable' : 'request_rejected', { status });
      // Never log error.message/stack: a database error can contain the actual row.
      respond(res, status, false);
    } finally {
      active--;
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  server.maxRequestsPerSocket = 100;
  return server;
}
