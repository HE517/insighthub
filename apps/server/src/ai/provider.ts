/**
 * # The server-side AI provider seam (`docs/CONTRACTS.md` §11.2)
 *
 * ```text
 * HTTP route (`route.ts`)  ──suggest(input, signal)──►  ServerAiProvider
 *                                                        ├─ OpenAiProvider (`openai.ts`, global fetch)
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
 * Every failure is a `ServerAiProviderError` with a `kind` that the route maps to exactly
 * one HTTP response (`docs/CONTRACTS.md` §11.2):
 *
 * | `kind` | Route response |
 * | --- | --- |
 * | `not-configured` | `503 ai_provider_not_configured` |
 * | `timeout` | `504 provider_timeout` |
 * | `provider` | `502 provider_error` |
 * | `invalid-output` | `502 invalid_provider_output` |
 *
 * A provider must never return a partially repaired draft. "The model's JSON was almost
 * right" is `invalid-output`, not a draft with the bad operation dropped.
 *
 * ## Credential hygiene is a property of this type
 *
 * `ServerAiProviderError.message` is written by the provider implementation and is
 * **never** put in an HTTP response (`route.ts` only reads `kind`). Implementations must
 * still keep the message free of the API key, request headers and prompt/content, because
 * a message is the thing an operator's logger will eventually capture. The OpenAI adapter
 * uses fixed message templates for exactly that reason.
 */
import type { AiSuggestionDraft } from '@insighthub/shared';

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

/** The four failure classes §11.2 gives a response code. */
export type ServerAiProviderErrorKind =
  'not-configured' | 'timeout' | 'provider' | 'invalid-output';

/**
 * A typed provider failure.
 *
 * Deliberately not carrying a `cause`: a fetch error or a provider response body can hold
 * request material, and an attached cause is the usual way it reaches a log via a generic
 * error serializer. The fixed `message` is all the provider implementation may say.
 */
export class ServerAiProviderError extends Error {
  readonly kind: ServerAiProviderErrorKind;

  constructor(kind: ServerAiProviderErrorKind, message: string) {
    super(message);
    this.name = 'ServerAiProviderError';
    this.kind = kind;
  }
}

/** Narrowing helper for call sites that must not trust `instanceof` across realms/tests. */
export function isServerAiProviderError(error: unknown): error is ServerAiProviderError {
  return error instanceof ServerAiProviderError;
}
