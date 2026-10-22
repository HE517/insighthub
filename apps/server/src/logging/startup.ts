/**
 * The startup summary (M4 B9, `docs/DECISIONS.md` D-082 §5).
 *
 * ## Why the summary is its own event, not a pile of `console.log` lines
 *
 * An operator — or a deploy dashboard — needs to answer "what configuration is this process
 * actually running?" without reading prose. `server.config` is exactly the non-sensitive
 * configuration, as fields:
 *
 * ```json
 * {"event":"server.config","nodeEnv":"production","port":3001,"host":"0.0.0.0",
 *  "authMode":"clerk","aiProvider":"openai","aiModel":"gpt-5.6-luna",
 *  "dataPath":"/var/data","staticDir":"/app/apps/web/dist","backupEnabled":true}
 * ```
 *
 * The field list is closed on purpose. It is the task's list, and adding a field means deciding
 * again that the value is safe to publish — not merely that it is convenient.
 *
 * ## Secrets
 *
 * A secret is never a field of `server.config`. Each server-only credential gets its own
 * `server.secret` line carrying **presence only**:
 *
 * ```json
 * {"event":"server.secret","name":"CLERK_SECRET_KEY","present":true}
 * ```
 *
 * `present: true` is enough to distinguish "configured" from "missing" (the two states an
 * operator debugs); the value is not needed for that, so it is not available to the logger at
 * all. `CLERK_PUBLISHABLE_KEY` is a public browser value and does not need this treatment.
 */
import { DEFAULT_OPENAI_MODEL, readServerAiProviderKind } from '../ai/openai.js';
import type { ServerConfig } from '../config.js';
import type { Logger } from './logger.js';

/** Environment values that are defined and not blank; an empty shell variable means "unset". */
export function isEnvironmentValuePresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The configured OpenAI model, for the startup summary and the `ai.suggest` event.
 *
 * Read through the same default as the adapter so the log cannot claim a model the provider is
 * not using (D-082 D3). It is configuration, not a credential.
 */
export function readConfiguredAiModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env['OPENAI_MODEL'] ?? '').trim() || DEFAULT_OPENAI_MODEL;
}

/**
 * Emit the startup summary: one `server.config` event plus one `server.secret` per credential.
 *
 * Called once, after the configuration gate has accepted the process and before the store is
 * opened, so a failed deploy still records the configuration it was attempted with.
 */
export function logStartupSummary(
  logger: Logger,
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  logger.info('server.config', {
    nodeEnv: config.nodeEnv ?? 'development',
    port: config.port,
    host: config.host,
    authMode: config.authMode ?? 'demo',
    aiProvider: readServerAiProviderKind(env),
    aiModel: readConfiguredAiModel(env),
    dataPath: config.dataPath ?? null,
    staticDir: config.staticDir ?? null,
    backupEnabled: config.backupEnabled === true,
  });

  // Server-only credentials: **presence only**. Never `env[name]`.
  for (const name of ['CLERK_SECRET_KEY', 'OPENAI_API_KEY'] as const) {
    logger.info('server.secret', { name, present: isEnvironmentValuePresent(env[name]) });
  }
}
