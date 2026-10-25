/**
 * The provider error vocabulary (`docs/CONTRACTS.md` §11.2).
 *
 * ## Why this is its own module
 *
 * `provider.ts` owns the seam **and** (since M4 B12) the environment factory, and the factory
 * imports every adapter. If the adapters imported the error class back from `provider.ts` the
 * module graph would contain one cycle per adapter. Keeping the frozen vocabulary in a leaf
 * module lets `openai-compatible.ts`, `openai.ts`, `kimi.ts` and `stub.ts` depend on it without
 * depending on the factory.
 *
 * `provider.ts` re-exports all three symbols below, so the public surface every existing caller
 * (and test) imports is unchanged.
 *
 * ## Fail closed, with one typed vocabulary
 *
 * Every failure is a `ServerAiProviderError` with a `kind` that the route maps to exactly one
 * HTTP response:
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
 * ## Credential hygiene is a property of this type
 *
 * `ServerAiProviderError.message` is written by the provider implementation and is **never**
 * put in an HTTP response (`route.ts` only reads `kind`). Implementations must still keep the
 * message free of the API key, request headers and prompt/content, because a message is the
 * thing an operator's logger will eventually capture. The adapters use fixed message templates
 * for exactly that reason.
 */

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
  /**
   * The upstream HTTP status, when the provider answered at all. Safe to log: it is a number, not
   * request material. Without it an operator cannot tell "bad key" (401) from "model not found"
   * (404) from "rate limited" (429), which are three different fixes.
   */
  readonly upstreamStatus?: number;
  /**
   * The provider's own error code (`model_not_found`, `invalid_api_key`, …), when the response
   * carried one. A short machine code, never the human message, which can echo request material.
   */
  readonly providerCode?: string;

  constructor(
    kind: ServerAiProviderErrorKind,
    message: string,
    details: { upstreamStatus?: number; providerCode?: string } = {},
  ) {
    super(message);
    this.name = 'ServerAiProviderError';
    this.kind = kind;
    if (details.upstreamStatus !== undefined) this.upstreamStatus = details.upstreamStatus;
    if (details.providerCode !== undefined) this.providerCode = details.providerCode;
  }
}

/** Narrowing helper for call sites that must not trust `instanceof` across realms/tests. */
export function isServerAiProviderError(error: unknown): error is ServerAiProviderError {
  return error instanceof ServerAiProviderError;
}
