import {
  DOCUMENT_TEXT_KEY,
  documentMetaSchema,
  type CollaborativeSession,
  type DocumentMeta,
} from '@insighthub/shared';

import { getJson } from '../../api.js';

/**
 * Read/directory tools for the AI feature (D-075 §3 item 1).
 *
 * Two tools, both deliberately small:
 *
 * | tool | input | output | writes? |
 * | --- | --- | --- | --- |
 * | {@link readDocumentText} | a session's `doc` | the live `Y.Text` content | never |
 * | {@link listDocuments} | an `AbortSignal` | `DocumentMeta[]` from `GET /api/documents` | never |
 *
 * ## What is *not* here
 *
 * - **No caching.** The text is read from `Y.Text` on every call. R11 forbids mirroring document
 *   content into Redux or React state, and a "context cache" here would be that mirror with a
 *   different name.
 * - **No CodeMirror access.** The selection is an *input* to the provider (`AiSuggestInput`),
 *   supplied by the UI that already owns the editor state. This module must not learn about
 *   CodeMirror, or the AI layer could not run without an editor mounted.
 * - **No writes.** Nothing here mutates the document, presence or the session.
 *
 * `listDocuments` is the single network call allowed in M3 round 1. It always takes an
 * `AbortSignal` (R9), and every failure is a typed {@link DocumentListError} — never a silent
 * empty list, because "no documents" and "the request failed" are different product states.
 */

/**
 * The current document text, read straight from the CRDT.
 *
 * The caller must treat the return value as a snapshot: use it to generate a proposal, then throw
 * it away. Never store it in Redux/React state (R11).
 */
export function readDocumentText(session: Pick<CollaborativeSession, 'doc'>): string {
  return session.doc.getText(DOCUMENT_TEXT_KEY).toString();
}

/** Why a document listing failed. */
export type DocumentListFailure =
  'aborted' | 'unauthorized' | 'http' | 'network' | 'timeout' | 'malformed';

/**
 * A failed `GET /api/documents`.
 *
 * `kind` is the stable discriminator; `status` is present for `http`/`unauthorized`.
 * `unauthorized` is split out from `http` because `401` has a product meaning (the session is
 * gone or expired — A5's bootstrap gets involved) rather than "the server is unhappy".
 */
export class DocumentListError extends Error {
  readonly kind: DocumentListFailure;
  readonly status?: number;

  constructor(kind: DocumentListFailure, message: string, status?: number) {
    super(message);
    this.name = 'DocumentListError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** `GET /api/documents` response body, per `docs/CONTRACTS.md` §12 / §17.4. */
interface DocumentsResponse {
  documents: DocumentMeta[];
}

/**
 * List the documents this session may read.
 *
 * The `signal` is mandatory and is forwarded to `fetch` by the shared HTTP client, which also
 * applies a timeout. A caller that switches documents must abort in order to satisfy A5's
 * stale-response ownership rule rather than rendering a previous document's list.
 *
 * Rejects (never resolves with `[]`) when:
 *
 * - the signal was already aborted (`aborted`);
 * - the server answers `401` (`unauthorized`);
 * - any other non-2xx answer (`http`, with `status`);
 * - the request is unreachable or times out (`network` / `timeout`);
 * - the body is not `{ documents: DocumentMeta[] }` (`malformed`) — validated with the **shared**
 *   schema, so the client cannot drift from the server contract.
 */
export async function listDocuments(signal: AbortSignal): Promise<DocumentMeta[]> {
  // `requestJson` installs its abort listener when it starts; checking here closes the window
  // where a call made with an already-aborted signal would still reach the network.
  if (signal.aborted) {
    throw new DocumentListError(
      'aborted',
      'The document list request was aborted before it started.',
    );
  }

  const result = await getJson<unknown>('/api/documents', { signal });
  if (!result.ok) {
    if (result.error.kind === 'aborted') {
      throw new DocumentListError('aborted', 'The document list request was aborted.');
    }
    if (result.error.kind === 'timeout') {
      throw new DocumentListError('timeout', result.error.message);
    }
    if (result.error.kind === 'network') {
      throw new DocumentListError('network', result.error.message);
    }
    if (result.error.status === 401) {
      throw new DocumentListError(
        'unauthorized',
        'GET /api/documents answered 401: no valid session.',
        401,
      );
    }
    throw new DocumentListError(
      'http',
      `GET /api/documents failed with HTTP ${String(result.error.status)}.`,
      result.error.status,
    );
  }

  if (typeof result.data !== 'object' || result.data === null) {
    throw new DocumentListError('malformed', 'GET /api/documents did not answer a JSON object.');
  }

  const parsed = documentMetaSchema
    .array()
    .safeParse((result.data as Partial<DocumentsResponse>).documents);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<documents>'}: ${issue.message}`)
      .join('; ');
    throw new DocumentListError(
      'malformed',
      `GET /api/documents returned an invalid body: ${detail}`,
    );
  }

  return parsed.data;
}
