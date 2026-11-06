import pg from 'pg';
import { databaseConfig, ConfigError } from '../src/config.js';
import { auditDatabase } from '../src/database-audit.js';

let pool;
try {
  pool = new pg.Pool(databaseConfig(process.env));
  pool.on('error', () => {});
  const audit = await auditDatabase(pool, { assistantEnabled: process.env.ASSISTANT_ENABLED === 'true',
    freeformEnabled: process.env.ASSISTANT_FREEFORM_ENABLED === 'true',workspaceEnabled:process.env.ASSISTANT_WORKSPACE_ENABLED==='true',organizerEnabled:process.env.ASSISTANT_ORGANIZER_ENABLED==='true',multiGroupEnabled:process.env.ASSISTANT_MULTI_GROUP_ENABLED==='true' });
  // Object names only, never table contents or connection credentials.
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  process.exitCode = audit.ok ? 0 : 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false,
    error: error instanceof ConfigError ? 'invalid_configuration' : 'database_check_failed',
    ...(error instanceof ConfigError ? { field: error.field } : {}) })}\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
