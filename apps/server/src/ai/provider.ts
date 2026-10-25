/**
 * # The server-side AI provider seam and environment factory (`docs/CONTRACTS.md` §11.2)
 *
 * ```text
 * HTTP route (`route.ts`)  ──suggest(input, signal)──►  ServerAiProvider
 *                                                        ├─ OpenAI adapter (`openai.ts`)
 *                                                        ├─ Kimi adapter   (`kimi.ts`)
 *                                                        ├─ deterministic stub (`stub.ts`, dev/test only)
 *                                                        └─ fake (tests only)
 * ```
 *
 * ## Why the seam returns a **draft**
 *
 * An `AiEditSuggestion` carries Yjs `RelativePosition` anchors, and those are
 * replica-specific: only the client that minted them can resolve them against its own
 * `Y.Text`. A server that minted anchors would hand the client positions that resolve on
 * the server and misresolve (or fail) on the client. So the provider's contract stops one
 * step earlier: plain UTF-16 offsets into the `content` the caller submitted. The client
 * re-reads its live text, mints the anchors (`createOperationAnchor`), computes the diff and
 * only then builds the suggestion (`docs/DECISIONS.md` D-080 §1). The model therefore
 * produces the *ingredients* of a proposal and can never write document state.
 *
 * ## Fail closed, with one typed error vocabulary
 *
 * The vocabulary lives in `errors.ts` (so the adapters do not have to import the factory back)
 * and is re-exported here, which is where every caller has always imported it from:
 *
 * | `kind` | Route response |
 * | --- | --- |
 * | `not-configured` | `503 ai_provider_not_configured` |
 * | `timeout` | `504 provider_timeout` |
 * | `provider` | `502 provider_error` |
 * | `invalid-output` | `502 invalid_provider_output` |
 *
 * A provider must never return a partially repaired draft. "The model's JSON was almost right"
 * is `invalid-output`, not a draft with the bad operation dropped.
 *
 * ## Selection (M4 B12, `docs/DECISIONS.md` D-085)
 *
 * `AI_PROVIDER` names a provider, never a URL or a model:
 *
 * | `AI_PROVIDER` | Factory result |
 * | --- | --- |
 * | `openai` | OpenAI adapter, only if `OPENAI_API_KEY` is present |
 * | `kimi` | Kimi adapter, only if `KIMI_API_KEY` is present |
 * | `stub` | deterministic stub — development/evidence only; production refuses to start |
 * | `disabled`, unset, or anything else | `null` ⇒ the route answers `503` |
 *
 * Four properties this module exists to guarantee:
 *
 * 1. **One decision, two readers.** The factory and the startup log both go through
 *    `readServerAiProviderKind`, so the process cannot log a provider it did not build (or build
 *    one it did not log).
 * 2. **No fallback.** `stub` never stands in for a broken key, and OpenAI never stands in for
 *    Kimi. A selected provider without its credential is `null`, not the next choice.
 * 3. **Unknown means disabled.** An unknown value fails closed here; production additionally
 *    refuses to start (`AI_PROVIDER_INVALID`), because a typo that silently disables AI looks
 *    like a provider outage. Non-production stays permissive (the startup gate is production-only
 *    except for the Clerk guard).
 * 4. **The key is only ever a presence check.** No reader logs, returns or interpolates a value.
 */
import type { AiSuggestionDraft } from '@insighthub/shared';

import { readAiProviderSelector } from './env.js';
import { createKimiProvider, readKimiModel, readKimiProviderConfig } from './kimi.js';
import { createOpenAiProvider, readOpenAiModel, readOpenAiProviderConfig } from './openai.js';
import { STUB_MODEL, createStubProvider } from './stub.js';

/** The user turn of one suggestion request (§11.2 request shape, minus `documentId`). */
export interface ServerAiSuggestInput {
  /** The user's natural-language instruction. */
  readonly instruction: string;
  /** Document snapshot the returned offsets are relative to. */
  readonly content: string;
  /** Optional selection in UTF-16, the same space as an operation's `index`. */
  readonly selection?: { readonly from: number; readonly to: number };
}

/**
 * One server-side AI provider.
 *
 * `signal` is mandatory (`AGENTS.md` R9): it fires when the HTTP client goes away or when
 * the implementation's own deadline expires. An implementation must stop its network call
 * on abort and reject with `kind: 'timeout'` — never resolve with a stale draft.
 */
export interface ServerAiProvider {
  suggest(input: ServerAiSuggestInput, signal: AbortSignal): Promise<AiSuggestionDraft>;
}

// The frozen error vocabulary, re-exported so `provider.ts` remains the one import every caller
// and test uses. See `errors.ts` for the fail-closed contract and the credential-hygiene rules.
export {
  ServerAiProviderError,
  isServerAiProviderError,
  type ServerAiProviderErrorKind,
} from './errors.js';

/** The provider class selected by configuration. `disabled` means the route answers `503`. */
export type ServerAiProviderKind = 'openai' | 'kimi' | 'stub' | 'disabled';

/**
 * One built provider plus the identity of what was built.
 *
 * The factory returns this instead of a bare provider (M4 B12) because the entrypoint and the
 * `ai.suggest` event must name the provider and model that actually ran. Keeping them in one
 * object means the logged `kind` cannot disagree with the constructed adapter.
 */
export interface ConfiguredServerAiProvider {
  readonly provider: ServerAiProvider;
  readonly kind: Exclude<ServerAiProviderKind, 'disabled'>;
  /** The model id this provider will stamp on a draft (never a credential). */
  readonly model: string;
}

/**
 * Which provider the environment selects, for the startup log and the startup summary.
 *
 * `disabled` covers every state that builds nothing: unset, `disabled`, an unknown value, and a
 * selected provider whose key is missing. The check is delegated to the same config readers the
 * factory uses, so the two cannot drift.
 */
export function readServerAiProviderKind(
  env: NodeJS.ProcessEnv = process.env,
): ServerAiProviderKind {
  switch (readAiProviderSelector(env)) {
    case 'stub':
      return 'stub';
    case 'openai':
      return readOpenAiProviderConfig(env) === null ? 'disabled' : 'openai';
    case 'kimi':
      return readKimiProviderConfig(env) === null ? 'disabled' : 'kimi';
    default:
      // `disabled`, unset, or an unknown value: fail closed. Production refuses an unknown value
      // outright (`AI_PROVIDER_INVALID`); outside production it is simply "no provider".
      return 'disabled';
  }
}

/**
 * The model the configured provider would use, for the startup summary and the `ai.suggest`
 * event.
 *
 * Read through each adapter's own resolver, so the log cannot claim a model the provider is not
 * using (D-082 D3). It is configuration, not a credential.
 */
export function readAiModel(env: NodeJS.ProcessEnv = process.env): string {
  return readAiProviderSelector(env) === 'kimi' ? readKimiModel(env) : readOpenAiModel(env);
}

/**
 * Build the configured provider, or `null` when nothing is configured.
 *
 * The default parameter is the process environment; `index.ts` passes it explicitly only so it
 * can log whether AI is enabled. Nothing here throws on missing configuration. Construction is
 * pure — no I/O, no connection, no key inspection beyond presence — so calling this in a test is
 * safe without a fake fetch.
 *
 * Precedence is deliberate and total: the literal `AI_PROVIDER` value decides, and the only
 * additional requirement is that provider's own credential. There is no fallback in either
 * direction.
 */
export function createServerAiProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredServerAiProvider | null {
  switch (readAiProviderSelector(env)) {
    case 'stub':
      return { provider: createStubProvider(), kind: 'stub', model: STUB_MODEL };

    case 'openai': {
      const config = readOpenAiProviderConfig(env);
      return config === null
        ? null
        : { provider: createOpenAiProvider(config), kind: 'openai', model: config.model };
    }

    case 'kimi': {
      const config = readKimiProviderConfig(env);
      return config === null
        ? null
        : { provider: createKimiProvider(config), kind: 'kimi', model: config.model };
    }

    default:
      return null;
  }
}
