/**
 * The Moonshot **Kimi** adapter — the second production-supported provider (D-085).
 *
 * ## Why it is not "the OpenAI adapter with a different URL"
 *
 * Kimi speaks an OpenAI-compatible wire format, so it reuses the transport
 * (`openai-compatible.ts`). Everything above the wire is stated here explicitly, because D-085 §2
 * forbids assuming two providers mean the same thing just because their JSON looks similar:
 *
 * | Parameter | OpenAI | Kimi (this file) |
 * | --- | --- | --- |
 * | endpoint | `https://api.openai.com/v1` | `https://api.moonshot.cn/v1` (CN platform) |
 * | credential | `OPENAI_API_KEY` | `KIMI_API_KEY` |
 * | default model | `gpt-5.6-luna` | {@link DEFAULT_KIMI_MODEL} (`kimi-k3`) |
 * | output bound field | `max_tokens` | `max_tokens` |
 * | structured output | `response_format: {type:"json_object"}` | **prompt-only** (no `response_format`) |
 *
 * ## The model choice
 *
 * K2 is being retired (2026-12), so the production default is the **K3** family and exactly
 * `kimi-k3`: it supports `response_format`/JSON mode at a lower cost tier than `kimi-k3.1-pro`.
 * `kimi-k3.1-pro` is an Owner decision if proposal quality proves insufficient, and `highspeed`
 * is deliberately not selected because there is no real latency requirement (D-085 §3).
 *
 * ## Why prompt-only, not JSON mode
 *
 * The CN endpoint answered the B12 live request with HTTP 400 `invalid_request_error` while the
 * request carried `response_format`. Rather than guess which sub-parameter caused it, this adapter
 * stops sending the parameter: the system prompt already demands bare JSON, and the response still
 * passes `JSON.parse` plus the strict `AiSuggestionDraft` schema, so a malformed answer is
 * `invalid_output` exactly as before. This is a recorded provider-capability finding, not a silent
 * runtime fallback.
 *
 * ## Configuration
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `AI_PROVIDER=kimi` | selects this adapter |
 * | `KIMI_API_KEY` | **required**; absent ⇒ no provider (`503`), and production refuses to start |
 * | `AI_MODEL` | optional model override; defaults to {@link DEFAULT_KIMI_MODEL} |
 * | `AI_PROVIDER_TIMEOUT_MS` | optional; defaults to 30 s |
 * | `OPENAI_MAX_OUTPUT_TOKENS` | optional; defaults to 4096, sent as `max_tokens` |
 * | `AI_BASE_URL` | development-only endpoint override; production refuses it |
 */
import { ServerAiProviderError } from './errors.js';
import {
  readAiBaseUrl,
  readAiProviderSelector,
  readMaxOutputTokens,
  readPositiveIntegerEnv,
} from './env.js';
import {
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  DEFAULT_AI_TIMEOUT_MS,
  createOpenAICompatibleProvider,
} from './openai-compatible.js';
import type { ServerAiProvider } from './provider.js';

/**
 * The code allowlist for Moonshot's **China** OpenAI-compatible endpoint (D-085 §1).\n *\n * InsightHub supports the platform.kimi.com (CN) platform only: a CN key does not authenticate\n * against the international pi.moonshot.ai host (observed 401 invalid_authentication_error),\n * so the endpoint is fixed rather than region-configurable.
 *
 * Configuration names a **provider**, not a URL: the only exception is the development
 * `AI_BASE_URL` proxy, which production refuses before a port is bound.
 */
export const KIMI_API_BASE_URL = 'https://api.moonshot.cn/v1';

/**
 * The production default model (D-085 §3).
 *
 * K3 series, not K2 (retiring 2026-12) and not `kimi-k3.1-pro` (a costier tier kept for an Owner
 * decision) and not `highspeed` (no latency requirement).
 */
export const DEFAULT_KIMI_MODEL = 'kimi-k3';

/** Default deadline for one suggestion (D-082 D3: 30 s). */
export const DEFAULT_KIMI_TIMEOUT_MS = DEFAULT_AI_TIMEOUT_MS;

/** Default cap on the model's output tokens (D-082 D3: 4096), sent as `max_tokens`. */
export const DEFAULT_KIMI_MAX_OUTPUT_TOKENS = DEFAULT_AI_MAX_OUTPUT_TOKENS;

export interface KimiProviderOptions {
  /** Server-only credential. Never logged, never returned, never put in a body. */
  readonly apiKey: string;
  /** Defaults to {@link DEFAULT_KIMI_MODEL}. */
  readonly model?: string;
  /** Defaults to {@link DEFAULT_KIMI_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Defaults to {@link DEFAULT_KIMI_MAX_OUTPUT_TOKENS}; sent as `max_tokens`. */
  readonly maxOutputTokens?: number;
  /** Overrides {@link KIMI_API_BASE_URL}. Only the development `AI_BASE_URL` proxy supplies it. */
  readonly endpoint?: string;
  /** Test seam. Production omits it and uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The configuration the environment may supply. */
export interface KimiProviderConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Present only when the development `AI_BASE_URL` proxy overrides the allowlisted endpoint. */
  readonly endpoint?: string;
}

/**
 * The model this adapter would use: `AI_MODEL` when set, otherwise {@link DEFAULT_KIMI_MODEL}.
 *
 * There is deliberately no `KIMI_MODEL` alias in the frozen configuration (D-085 §1) — a second
 * provider-specific variable would be a second place for the model to disagree with the log.
 */
export function readKimiModel(env: NodeJS.ProcessEnv): string {
  return (env['AI_MODEL'] ?? '').trim() || DEFAULT_KIMI_MODEL;
}

/**
 * Read the server-only **Kimi** configuration, or `null` when this adapter is not selected or has
 * no credential.
 *
 * Same fail-closed policy as OpenAI: a missing key is a runtime `503`, never a crash and never a
 * browser-side fallback. Production additionally refuses to start (`KIMI_API_KEY_MISSING`).
 */
export function readKimiProviderConfig(env: NodeJS.ProcessEnv): KimiProviderConfig | null {
  if (readAiProviderSelector(env) !== 'kimi') return null;

  const apiKey = (env['KIMI_API_KEY'] ?? '').trim();
  if (apiKey === '') return null;

  const endpoint = readAiBaseUrl(env);
  return {
    apiKey,
    model: readKimiModel(env),
    maxOutputTokens: readMaxOutputTokens(env, DEFAULT_KIMI_MAX_OUTPUT_TOKENS),
    timeoutMs: readPositiveIntegerEnv(env['AI_PROVIDER_TIMEOUT_MS'], DEFAULT_KIMI_TIMEOUT_MS),
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

/** Build the Kimi-backed provider. Throws for an empty key or a non-positive numeric bound. */
export function createKimiProvider(options: KimiProviderOptions): ServerAiProvider {
  const apiKey = options.apiKey.trim();
  if (apiKey === '') {
    throw new ServerAiProviderError(
      'not-configured',
      'the AI provider is not configured: no API key was supplied',
    );
  }

  return createOpenAICompatibleProvider({
    provider: 'kimi',
    endpoint: options.endpoint ?? KIMI_API_BASE_URL,
    apiKey,
    model: options.model?.trim() || DEFAULT_KIMI_MODEL,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    // `max_tokens` is what the Kimi Chat Completions endpoint documents; stated explicitly rather
    // than inherited, so a provider that switches to `max_completion_tokens` is a one-line change
    // with its own test.
    maxTokensField: 'max_tokens',
    // No `response_format` (D-085 §3 rev after the live 400 `invalid_request_error`): the CN
    // endpoint rejected the JSON-mode request for this model. The system prompt already demands
    // bare JSON, and the response still goes through parse + strict draft schema validation, so
    // dropping the parameter weakens nothing except the provider-side enforcement hint.
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}
