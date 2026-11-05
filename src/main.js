import pg from 'pg';
import { loadConfig, ConfigError } from './config.js';
import { PgStore } from './store.js';
import { auditDatabase } from './database-audit.js';
import { createServer } from './server.js';
import { log } from './logger.js';

let pool;
let server;
try {
  const config = loadConfig();
  let store;
  if (config.database) {
    pool = new pg.Pool(config.database);
    pool.on('error', () => log('database_connection_error'));
    const audit = await auditDatabase(pool);
    if (!audit.ok) {
      log('database_audit_failed', { issues: audit.issues });
      throw new Error('Database audit failed');
    }
    store = new PgStore(pool);
    log('database_audit_passed');
  }
  server = createServer({ config, store, log });
  server.on('error', () => { log('server_failed'); process.exitCode = 1; pool?.end(); });
  server.listen(config.port, '0.0.0.0', () => log('server_started', { mode: config.mode }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('server_stopping');
    const deadline = setTimeout(() => process.exit(1), 8000);
    deadline.unref();
    server.close(async () => {
      try { await pool?.end(); } finally { clearTimeout(deadline); }
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
