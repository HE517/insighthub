/**
 * The OpenAI adapter — one provider over the shared transport (`openai-compatible.ts`).
 *
 * ## Deliberate choices
 *
 * - **No SDK, no second network path.** The request shape lives in the transport; this module
 *   owns only the OpenAI-specific parameters and the environment reader (`docs/DECISIONS.md`
 *   D-080 §6, `AGENTS.md` R3).
 * - **The key never leaves the transport's request headers.** It is not logged, not put in an
 *   error message, not returned and not part of any thrown object. Every failure is a fixed
 *   template with at most an HTTP status number in it.
 * - **Fail closed.** Schema validation is the gate, not a suggestion: a malformed, out-of-bounds
 *   or partially-valid answer is `invalid-output`; nothing is repaired, re-asked or partially
 *   accepted (`docs/CONTRACTS.md` §11.2).
 * - **No retry (D-082 D3).** One `fetch` per `suggest`; a 5xx, network error, timeout or abort is
 *   reported once and never re-sent.
 *
 * ## Configuration
 *
 * Read in one place, `readOpenAiProviderConfig`, and only in the server process:
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `AI_PROVIDER` | `openai` enables this adapter; `kimi`/`stub` enable theirs; unset, `disabled` or an unknown value means no provider (`503`) |
 * | `OPENAI_API_KEY` | **required** when `AI_PROVIDER=openai`; absent ⇒ `503`, never a crash |
 * | `AI_MODEL` | optional; the unified model selector, wins over the deprecated alias |
 * | `OPENAI_MODEL` | optional **deprecated alias**; used only when `AI_MODEL` is unset |
 * | `OPENAI_MAX_OUTPUT_TOKENS` | optional; defaults to {@link DEFAULT_OPENAI_MAX_OUTPUT_TOKENS} (4096), sent as `max_tokens` |
 * | `AI_PROVIDER_TIMEOUT_MS` | optional; defaults to {@link DEFAULT_OPENAI_TIMEOUT_MS} (30 s) |
 * | `AI_BASE_URL` | development-only endpoint override; **production refuses it** (`AI_BASE_URL_FORBIDDEN`). Absent ⇒ the code allowlist |
 *
 * `AI_MODEL` is the single entry point (D-085 §1): a deployment switches provider without
 * renaming its configuration, and `OPENAI_MODEL` keeps working only as a migration fallback.
 *
 * ## `stub` is explicit, and not a production mode
 *
 * `AI_PROVIDER=stub` is the only way to select `createStubProvider()`. It is never a default and
 * never a fallback: an unset variable still yields `null` (the route answers `503`). Production
 * configuration validation (`startup.ts`) rejects `stub` outright.
 *
 * ## Request parameters (per provider, not inherited)
 *
 * `maxTokensField: 'max_tokens'` and `response_format: { type: 'json_object' }` are stated here
 * explicitly. The transport has no opinion about either, because D-085 §2 requires structured
 * output to be configured (and tested) provider by provider rather than assumed from wire
 * similarity.
 */
import {
  AI_SYSTEM_PROMPT,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  DEFAULT_AI_TIMEOUT_MS,
  createOpenAICompatibleProvider,
} from './openai-compatible.js';
import { ServerAiProviderError } from './errors.js';
import { readAiBaseUrl, readAiProviderSelector, readPositiveIntegerEnv } from './env.js';
import type { ServerAiProvider } from './provider.js';

/**
 * The code allowlist for OpenAI's Chat Completions endpoint (D-085 §1).
 *
 * Configuration names a **provider**, not a URL: the only exception is the development
 * `AI_BASE_URL` proxy, which production refuses before a port is bound.
 */
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

/** Default model when neither `AI_MODEL` nor `OPENAI_MODEL` is set. Documented per §11.2. */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';

/** Default deadline for one suggestion (D-082 D3: 30 s). */
export const DEFAULT_OPENAI_TIMEOUT_MS = DEFAULT_AI_TIMEOUT_MS;

/**
 * Default cap on the model's output tokens (D-082 D3: 4096), sent as `max_tokens`.
 *
 * It is a server-side cost ceiling, not a suggestion: the draft schema already caps 32
 * operations, and this bounds what the model can bill even for a hostile instruction.
 */
export const DEFAULT_OPENAI_MAX_OUTPUT_TOKENS = DEFAULT_AI_MAX_OUTPUT_TOKENS;

/** The system prompt. Exported so the adapter test can pin the JSON-only instruction. */
export const OPENAI_SYSTEM_PROMPT = AI_SYSTEM_PROMPT;

export interface OpenAiProviderOptions {
  /** Server-only credential. Never logged, never returned, never put in a body. */
  readonly apiKey: string;
  /** Defaults to {@link DEFAULT_OPENAI_MODEL}. */
  readonly model?: string;
  /** Defaults to {@link DEFAULT_OPENAI_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Defaults to {@link DEFAULT_OPENAI_MAX_OUTPUT_TOKENS}; sent as `max_tokens`. */
  readonly maxOutputTokens?: number;
  /** Overrides {@link OPENAI_API_BASE_URL}. Only the development `AI_BASE_URL` proxy supplies it. */
  readonly endpoint?: string;
  /** Test seam. Production omits it and uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The configuration the environment may supply (§11.2). */
export interface OpenAiProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Present only when the development `AI_BASE_URL` proxy overrides the allowlisted endpoint. */
  readonly endpoint?: string;
}

/**
 * The model this adapter would use.
 *
 * `AI_MODEL` is the unified selector (D-085 §1); `OPENAI_MODEL` is the deprecated alias kept for
 * the migration window. Exported so the startup summary and the `ai.suggest` event read the same
 * answer the request will use.
 */
export function readOpenAiModel(env: NodeJS.ProcessEnv): string {
  const unified = (env['AI_MODEL'] ?? '').trim();
  if (unified !== '') return unified;
  return (env['OPENAI_MODEL'] ?? '').trim() || DEFAULT_OPENAI_MODEL;
}

/**
 * Read the server-only **OpenAI** configuration.
 *
 * Returns `null` for any state in which no OpenAI provider can be built. That is the whole
 * fail-closed policy for OpenAI configuration: a missing key must produce `503`, not a startup
 * crash (the production gate owns fail-fast) and certainly not a browser-side fallback.
 *
 * A different `AI_PROVIDER` (including `stub`, `kimi` or an unknown value) also returns `null`
 * here: this reader never widens a selection.
 */
export function readOpenAiProviderConfig(env: NodeJS.ProcessEnv): OpenAiProviderConfig | null {
  if (readAiProviderSelector(env) !== 'openai') return null;

  const apiKey = (env['OPENAI_API_KEY'] ?? '').trim();
  if (apiKey === '') return null;

  const endpoint = readAiBaseUrl(env);
  // Numeric policy: an unset/blank/invalid value means "use the frozen default", matching the
  // permissive config layer (`config.ts`). Fail-fast for *invalid configuration* is the
  // startup gate's job; the hard numbers themselves come from D-082 D3.
  return {
    apiKey,
    model: readOpenAiModel(env),
    maxOutputTokens: readPositiveIntegerEnv(
      env['OPENAI_MAX_OUTPUT_TOKENS'],
      DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
    ),
    timeoutMs: readPositiveIntegerEnv(env['AI_PROVIDER_TIMEOUT_MS'], DEFAULT_OPENAI_TIMEOUT_MS),
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

/**
 * Build the OpenAI-backed provider.
 *
 * Throws for an empty key or a non-positive numeric bound. The environment factory never reaches
 * those throws (it returns `null` first), but a hand-built provider must fail closed too.
 */
export function createOpenAiProvider(options: OpenAiProviderOptions): ServerAiProvider {
  const apiKey = options.apiKey.trim();
  if (apiKey === '') {
    throw new ServerAiProviderError(
      'not-configured',
      'the AI provider is not configured: no API key was supplied',
    );
  }

  return createOpenAICompatibleProvider({
    provider: 'openai',
    endpoint: options.endpoint ?? OPENAI_API_BASE_URL,
    apiKey,
    model: options.model?.trim() || DEFAULT_OPENAI_MODEL,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    // OpenAI's documented Chat Completions field, and its JSON mode. Both are stated here so a
    // change on one provider cannot silently change the other (D-085 §2).
    maxTokensField: 'max_tokens',
    responseFormat: { type: 'json_object' },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

/*
 * The environment factory and the startup-log selector live in `provider.ts` (selection spans
 * three adapters, so it must not live in any one of them). Re-exported here because `openai.ts`
 * was their historical home and every existing caller/test imports them from this module.
 */
export { createServerAiProviderFromEnv, readServerAiProviderKind } from './provider.js';
export type { ConfiguredServerAiProvider, ServerAiProviderKind } from './provider.js';
