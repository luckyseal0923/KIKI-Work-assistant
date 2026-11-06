import { loadConfig, ConfigError } from '../src/config.js';

try {
  const config = loadConfig();
  const a = config.assistant;
  process.stdout.write(`${JSON.stringify({ ok: a.enabled, enabled: a.enabled,
    ...(a.enabled ? { model: a.model, freeform_enabled: a.freeformEnabled,workspace_enabled:a.workspaceEnabled,
      ...(a.workspaceEnabled?{context_messages:a.contextMessages,context_characters:a.contextCharacters}:{}),daily_limit: a.dailyLimit, maximum_messages: a.maxMessages,
      operator_configured: true, line_token_configured: true, openai_key_configured: true } : {}) })}\n`);
  process.exitCode = a.enabled ? 0 : 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false,
    error: error instanceof ConfigError ? 'invalid_configuration' : 'check_failed',
    ...(error instanceof ConfigError ? { field: error.field } : {}) })}\n`);
  process.exitCode = 1;
}
