import pg from 'pg';
import { loadConfig, ConfigError } from './config.js';
import { PgStore } from './store.js';
import { auditDatabase } from './database-audit.js';
import { createServer } from './server.js';
import { log } from './logger.js';
import { AssistantStore } from './assistant-store.js';
import { AssistantWorker } from './assistant-worker.js';
import { OpenAISummarizer, LineReplier } from './assistant-clients.js';
import { OpenAIDialogue } from './assistant-dialogue.js';

let pool;
let server;
let assistantWorker;
try {
  const config = loadConfig();
  let store;
  if (config.database) {
    pool = new pg.Pool(config.database);
    pool.on('error', () => log('database_connection_error'));
    const audit = await auditDatabase(pool, { assistantEnabled: config.assistant.enabled,
      freeformEnabled: config.assistant.freeformEnabled });
    if (!audit.ok) {
      log('database_audit_failed', { issues: audit.issues });
      throw new Error('Database audit failed');
    }
    store = new PgStore(pool, { assistantEnabled: config.assistant.enabled });
    log('database_audit_passed');
    if (config.assistant.enabled) assistantWorker = new AssistantWorker({ config,
      store: new AssistantStore(pool, config), summarizer: new OpenAISummarizer(config.assistant),
      dialogue: config.assistant.freeformEnabled ? new OpenAIDialogue(config.assistant) : null,
      replier: new LineReplier(config.assistant.lineAccessToken), log });
  }
  server = createServer({ config, store, assistantWorker, log });
  server.on('error', () => {
    log('server_failed'); process.exitCode = 1;
    (async () => { await assistantWorker?.stop(); await pool?.end(); })().catch(() => {});
  });
  server.listen(config.port, '0.0.0.0', () => {
    assistantWorker?.start();
    log('server_started', { mode: config.mode, assistant_enabled: config.assistant.enabled,
      freeform_enabled: Boolean(config.assistant.freeformEnabled) });
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('server_stopping');
    const deadline = setTimeout(() => process.exit(1), 8000);
    deadline.unref();
    const workerStopped = assistantWorker?.stop();
    server.close(async () => {
      try { await workerStopped; await pool?.end(); } finally { clearTimeout(deadline); }
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  log('startup_failed', error instanceof ConfigError ? { field: error.field } : {});
  await pool?.end();
  process.exitCode = 1;
}
