import { readFileSync } from 'node:fs';

export const GROUP_ID = /^C[0-9a-f]{32}$/i;

export class ConfigError extends Error {
  constructor(field) {
    super('Invalid configuration');
    this.field = field;
  }
}

function required(env, field) {
  const value = env[field];
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new ConfigError(field);
  }
  return value;
}

function port(value, field) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new ConfigError(field);
  }
  return Number(value);
}

export function databaseConfig(env) {
  const user = required(env, 'DB_USER');
  if (user !== 'linebot_app') throw new ConfigError('DB_USER');
  const tls = env.DB_TLS || 'verify-full';
  let ssl;
  if (tls === 'verify-full') {
    ssl = { rejectUnauthorized: true };
    if (env.DB_CA_FILE) {
      try { ssl.ca = readFileSync(env.DB_CA_FILE, 'utf8'); }
      catch { throw new ConfigError('DB_CA_FILE'); }
    }
  } else if (tls === 'private' && env.DB_PRIVATE_NETWORK_CONFIRMED === 'true') {
    ssl = false;
  } else {
    throw new ConfigError('DB_TLS');
  }
  return {
    host: required(env, 'DB_HOST'),
    port: port(env.DB_PORT || '5432', 'DB_PORT'),
    database: required(env, 'DB_NAME'),
    user,
    password: required(env, 'DB_PASSWORD'),
    ssl,
    max: 2,
    connectionTimeoutMillis: 700,
    idleTimeoutMillis: 10000,
    statement_timeout: 1000,
    lock_timeout: 400,
    idle_in_transaction_session_timeout: 2000,
    query_timeout: 1200,
    application_name: 'kiki-work-assistant',
    // Avoid resolving application objects in a shared/public schema.
    options: '-c search_path=pg_catalog',
  };
}

export function loadConfig(env = process.env) {
  const mode = env.APP_MODE;
  if (!['discover', 'record'].includes(mode)) throw new ConfigError('APP_MODE');
  const secret = required(env, 'LINE_CHANNEL_SECRET');
  if (mode === 'record' && !GROUP_ID.test(env.ALLOWED_GROUP_ID || '')) {
    throw new ConfigError('ALLOWED_GROUP_ID');
  }
  return {
    mode,
    secret,
    port: port(env.PORT || '3000', 'PORT'),
    allowedGroupId: mode === 'record' ? env.ALLOWED_GROUP_ID : null,
    database: mode === 'record' ? databaseConfig(env) : null,
  };
}
