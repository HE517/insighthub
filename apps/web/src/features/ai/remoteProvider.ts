import { aiSuggestionDraftSchema, type AiEditSuggestion } from '@insighthub/shared';

import { apiUrl } from '../../api.js';
import { buildSuggestion, projectText, type AiProvider, type AiSuggestInput } from './provider.js';

/**
 * The **remote** provider (M3 Round 2, `docs/DECISIONS.md` D-080, `docs/CONTRACTS.md` §11.2).
 *
 * It calls `POST /api/ai/suggest` and turns the returned **draft** into an `AiEditSuggestion`
 * locally. The server never sees a browser credential: it owns the API key, and the browser only
 * ever sends the document snapshot and receives plain UTF-16 offsets.
 *
 * ## Why the round trip does not return a suggestion
 *
 * Anchors are Yjs `RelativePosition`s, which are replica-specific. Only the client that minted
 * them can resolve them against its own `Y.Text` (`docs/CONTRACTS.md` §11.2). The endpoint
 * therefore returns a draft:
 *
 * ```ts
 * { summary: string, operations: Array<{ kind, index, length?, text }>, model?: string }
 * ```
 *
 * This module is the *only* place that turns that draft into a proposal. It re-reads the live
 * `Y.Text` (via `buildSuggestion`), mints the anchors with `createOperationAnchor`, computes the
 * unified diff locally, stamps `input.baseRevision` from the caller's local revision counter, and
 * returns a schema-valid `AiEditSuggestion` — a **proposal**, never document state (R8).
 *
 * ## Failure is typed and total
 *
 * Every non-2xx answer, an unparseable body, a body that fails `aiSuggestionDraftSchema`, and an
 * aborted call all reject with a {@link RemoteProviderError}. There is no partial suggestion, no
 * "best effort" repair and no empty diff: a suggestion the user could Accept is either built from
 * a schema-valid draft or never returned at all.
 *
 * ## Credential hygiene
 *
 * The endpoint does not return a key, and this module would not read one if it did: no response
 * body is copied into an error message, and the only environment variable the browser AI surface
 * knows about is `VITE_AI_PROVIDER` (`aiProvider.ts`). The request body is exactly the frozen
 * `AiSuggestHttpRequest` — it contains the instruction and document content, never a credential.
 *
 * ## Cancellation (R9)
 *
 * The caller's `AbortSignal` is forwarded to `fetch` unchanged. A pre-aborted signal never reaches
 * the network, a caller abort maps to `kind: 'aborted'`, and every await is followed by an abort
 * check so a response that arrives after dismissal cannot become a proposal.
 */

/** The endpoint from `docs/CONTRACTS.md` §12. Exported so a test can assert the default. */
export const AI_SUGGEST_ENDPOINT = '/api/ai/suggest';

/**
 * The seven failure classes this provider distinguishes.
 *
 * They map onto the contract's HTTP matrix (`docs/CONTRACTS.md` §11.2) plus two client-side
 * conditions:
 *
 * | `kind` | cause |
 * | --- | --- |
 * | `unauthorized` | `401` — no/expired session |
 * | `not-found` | `404` — unknown document or no read access (non-disclosure) |
 * | `not-configured` | `503` — no server-side provider configured |
 * | `timeout` | `504`, or a fetch abort that was **not** requested by the caller |
 * | `provider` | `502`, any other HTTP failure, or an unreachable endpoint |
 * | `invalid-output` | `200` with malformed JSON, a draft that fails the shared schema, or a draft that cannot be turned into a valid suggestion |
 * | `aborted` | the caller's own `AbortSignal` fired |
 */
export const REMOTE_PROVIDER_FAILURES = [
  'unauthorized',
  'not-found',
  'not-configured',
  'timeout',
  'provider',
  'invalid-output',
  'aborted',
] as const;

export type RemoteProviderFailure = (typeof REMOTE_PROVIDER_FAILURES)[number];

/**
 * Fixed messages, one per kind.
 *
 * Deliberately **not** built from the response: a provider message can quote the prompt or the
 * document, and an error string is the usual thing a log or an error boundary captures. Keeping
 * the templates constant makes "no response body, prompt or key in an error" a property of the
 * type rather than a habit of the caller.
 */
const FAILURE_MESSAGES: Readonly<Record<RemoteProviderFailure, string>> = {
  unauthorized: 'The AI request was rejected: no valid session.',
  'not-found': 'The document is not available to this session.',
  'not-configured': 'The AI provider is not configured on the server.',
  timeout: 'The AI provider did not answer in time.',
  provider: 'The AI provider failed to produce a suggestion.',
  'invalid-output': 'The AI provider returned a proposal that could not be used.',
  aborted: 'The AI request was aborted.',
};

/** A typed remote-provider failure. `kind` is the stable discriminator for the UI. */
export class RemoteProviderError extends Error {
  readonly kind: RemoteProviderFailure;
  /** HTTP status, when the failure came from a response. Never rendered as copy. */
  readonly status?: number;

  constructor(kind: RemoteProviderFailure, status?: number) {
    super(FAILURE_MESSAGES[kind]);
    this.name = 'RemoteProviderError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export interface RemoteProviderOptions {
  /** Endpoint to POST to. Defaults to `AI_SUGGEST_ENDPOINT` under `VITE_API_BASE`. */
  endpoint?: string;
  /**
   * `fetch` implementation. Injected by tests so the whole matrix runs without a network; the
   * default is the platform `fetch` (which sends the `HttpOnly` session cookie with `include`).
   */
  fetchImpl?: typeof fetch;
  /** Clock for `createdAt`; injectable so a test can pin the whole suggestion. */
  now?: () => Date;
}

/**
 * Instances created by {@link createRemoteProvider}.
 *
 * The panel uses this to decide whether remote-only UI rules apply when a provider is injected
 * directly (its `provider` prop) rather than chosen by `createAiProvider`. A `WeakSet` keeps the
 * `AiProvider` interface unchanged and lets the entries be collected with the provider.
 */
const remoteProviders = new WeakSet<AiProvider>();

/**
 * Create the remote provider.
 *
 * Safe to keep one instance per app: it holds only the endpoint, the fetch implementation and the
 * clock, and `suggest` keeps no request state between calls.
 */
export function createRemoteProvider(options: RemoteProviderOptions = {}): AiProvider {
  const endpoint = options.endpoint ?? apiUrl(AI_SUGGEST_ENDPOINT);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? ((): Date => new Date());

  const provider: AiProvider = {
    async suggest(input: AiSuggestInput): Promise<AiEditSuggestion> {
      if (isAborted(input.signal)) throw new RemoteProviderError('aborted');

      // A collapsed caret is not a selection. Sending `{from:to}` with `from === to` invites a
      // provider to "edit" an empty range, which yields a schema-valid draft that changes nothing
      // and a proposal the user could Accept for no effect (A6 round-2 probe). Omit it instead.
      const selection =
        input.selection === undefined || input.selection.from === input.selection.to
          ? undefined
          : input.selection;

      const body = {
        documentId: input.documentId,
        instruction: input.instruction,
        baseRevision: input.baseRevision,
        content: input.text,
        ...(selection === undefined ? {} : { selection }),
      };

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: input.signal,
        });
      } catch (error: unknown) {
        throw mapFetchFailure(error, input.signal);
      }

      if (!response.ok) {
        throw new RemoteProviderError(kindForStatus(response.status), response.status);
      }

      // The caller may have dismissed the panel while the body was in flight. Do not read or
      // validate a response nobody is waiting for.
      if (isAborted(input.signal)) throw new RemoteProviderError('aborted');

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw isAborted(input.signal)
          ? new RemoteProviderError('aborted')
          : new RemoteProviderError('invalid-output');
      }

      if (isAborted(input.signal)) throw new RemoteProviderError('aborted');

      const draft = aiSuggestionDraftSchema.safeParse(payload);
      if (!draft.success) throw new RemoteProviderError('invalid-output');

      // A schema-valid draft can still be a no-op (every operation writes back the same text).
      // Such a draft must never become an Accept-able proposal: there would be nothing to review
      // and nothing to apply. Treat it as unusable output, not as an empty suggestion.
      if (projectText(input.text, draft.data.operations) === input.text) {
        throw new RemoteProviderError('invalid-output');
      }

      // Anchors, diff and `baseRevision` are minted here, against the **live** `Y.Text` the input
      // carries. A draft whose offsets no longer fit the document (the user typed while the
      // request was in flight) throws inside `buildSuggestion`; that is an unusable proposal, not
      // a partial one, so it becomes `invalid-output` and nothing is returned.
      try {
        return buildSuggestion({
          input,
          summary: draft.data.summary,
          drafts: draft.data.operations,
          now: now(),
          idPrefix: 'remote',
        });
      } catch {
        throw new RemoteProviderError('invalid-output');
      }
    },
  };

  remoteProviders.add(provider);
  return provider;
}

/** Whether `provider` came from {@link createRemoteProvider} (identity, not duck typing). */
export function isRemoteAiProvider(provider: AiProvider): boolean {
  return remoteProviders.has(provider);
}

/** Map one HTTP status to the contract's client vocabulary. */
function kindForStatus(status: number): RemoteProviderFailure {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 404:
      return 'not-found';
    case 503:
      return 'not-configured';
    case 504:
      return 'timeout';
    default:
      // 502 plus every status the contract does not give a client-specific meaning (400, 403,
      // 429, 5xx). Failing as `provider` is honest: there is no suggestion.
      return 'provider';
  }
}

/**
 * Classify a thrown `fetch`.
 *
 * A caller-initiated abort is `aborted` (regardless of the error the runtime produces); an abort
 * the caller did not ask for is a deadline (`timeout`); everything else — DNS, refused connection,
 * TLS — is `provider`. The original error is never attached or copied into the message.
 */
function mapFetchFailure(error: unknown, signal?: AbortSignal): RemoteProviderError {
  if (isAborted(signal)) return new RemoteProviderError('aborted');
  if (isAbortLike(error)) return new RemoteProviderError('timeout');
  return new RemoteProviderError('provider');
}

function isAbortLike(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Read the live abort state through a call.
 *
 * A direct `signal?.aborted` comparison would be narrowed by TypeScript to `false` after the
 * first guard, even though an `AbortSignal` can fire while an `await` is suspended. The helper
 * keeps each check a real runtime read.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}
