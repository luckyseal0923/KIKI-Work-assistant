import { readFileSync } from 'node:fs';
import { USER_ID } from './assistant-command.js';

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

function boundedInteger(env, field, fallback, min, max) {
  const value = env[field] || String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new ConfigError(field);
  return Number(value);
}

export function assistantConfig(env, mode) {
  if (env.ASSISTANT_ENABLED !== undefined && !['true', 'false', ''].includes(env.ASSISTANT_ENABLED)) {
    throw new ConfigError('ASSISTANT_ENABLED');
  }
  if (env.ASSISTANT_FREEFORM_ENABLED !== undefined && !['true','false',''].includes(env.ASSISTANT_FREEFORM_ENABLED)) {
    throw new ConfigError('ASSISTANT_FREEFORM_ENABLED');
  }
  const freeformEnabled = env.ASSISTANT_FREEFORM_ENABLED === 'true';
  if(env.ASSISTANT_WORKSPACE_ENABLED!==undefined&&!['true','false',''].includes(env.ASSISTANT_WORKSPACE_ENABLED))throw new ConfigError('ASSISTANT_WORKSPACE_ENABLED');
  const workspaceEnabled=env.ASSISTANT_WORKSPACE_ENABLED==='true';
  if(env.ASSISTANT_ORGANIZER_ENABLED!==undefined&&!['true','false',''].includes(env.ASSISTANT_ORGANIZER_ENABLED))throw new ConfigError('ASSISTANT_ORGANIZER_ENABLED');
  const organizerEnabled=env.ASSISTANT_ORGANIZER_ENABLED==='true';
  if(env.ASSISTANT_MULTI_GROUP_ENABLED!==undefined&&!['true','false',''].includes(env.ASSISTANT_MULTI_GROUP_ENABLED))throw new ConfigError('ASSISTANT_MULTI_GROUP_ENABLED');
  const multiGroupEnabled=env.ASSISTANT_MULTI_GROUP_ENABLED==='true';
  if(multiGroupEnabled&&!organizerEnabled)throw new ConfigError('ASSISTANT_MULTI_GROUP_ENABLED');
  if(organizerEnabled&&!workspaceEnabled)throw new ConfigError('ASSISTANT_ORGANIZER_ENABLED');
  if(workspaceEnabled&&(!freeformEnabled||env.ASSISTANT_ENABLED!=='true'))throw new ConfigError('ASSISTANT_WORKSPACE_ENABLED');
  if (env.ASSISTANT_ENABLED !== 'true') {
    if (freeformEnabled) throw new ConfigError('ASSISTANT_FREEFORM_ENABLED');
    return { enabled: false };
  }
  if (mode !== 'record') throw new ConfigError('ASSISTANT_ENABLED');
  const operatorUserId = required(env, 'OPERATOR_USER_ID');
  if (!USER_ID.test(operatorUserId)) throw new ConfigError('OPERATOR_USER_ID');
  const model = env.OPENAI_MODEL || 'gpt-6-luna';
  if (!['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].includes(model)) throw new ConfigError('OPENAI_MODEL');
  return {
    enabled: true, freeformEnabled, workspaceEnabled, organizerEnabled,multiGroupEnabled,maxGroups:boundedInteger(env,'ASSISTANT_MAX_GROUPS',3,2,10), operatorUserId, model,
    contextMessages:boundedInteger(env,'ASSISTANT_CONTEXT_MESSAGES',20,5,50),
    contextCharacters:boundedInteger(env,'ASSISTANT_CONTEXT_CHARACTERS',12000,2000,22000),
    openaiApiKey: required(env, 'OPENAI_API_KEY'),
    lineAccessToken: required(env, 'LINE_CHANNEL_ACCESS_TOKEN'),
    maxMessages: boundedInteger(env, 'ASSISTANT_MAX_MESSAGES', 100, 10, 100),
    dailyLimit: boundedInteger(env, 'ASSISTANT_DAILY_LIMIT', 20, 1, 100),
    cooldownSeconds: boundedInteger(env, 'ASSISTANT_COOLDOWN_SECONDS', 30, 10, 300),
  };
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
    assistant: assistantConfig(env, mode),
  };
}
