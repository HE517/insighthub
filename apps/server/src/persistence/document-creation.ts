/**
 * The durable seam for **creating a document with its owner** (M4 B12.5, D-084 method C).
 *
 * ## Why this is one method instead of three calls
 *
 * Acceptance #4 requires the document row, its `document_meta` row and the creator's `owner`
 * membership row to be all-or-nothing. Composing `create` + `ensureDocumentMeta` +
 * `membership.seed` at the call site would be three statements on two SQLite connections; a
 * crash between them leaves a document nobody owns (method B in D-084 — explicitly rejected).
 *
 * Because the membership table now lives in `insighthub.db` (schema 2), the store can write all
 * three rows inside one `BEGIN IMMEDIATE … COMMIT` on **one** connection:
 *
 * ```text
 * BEGIN IMMEDIATE
 *   INSERT document
 *   INSERT document_meta
 *   INSERT authz_document_membership (role = 'owner')
 * COMMIT
 * ```
 *
 * A throw from any step (including a real constraint/trigger failure) rolls all three back. The
 * HTTP layer therefore only has to map success to `201` and failure to its error body.
 *
 * ## What this seam deliberately is not
 *
 * It does not generate the id, resolve the owner or validate the title: those are the route's
 * authority boundaries (H2/id, session/owner, D-084 body rules). It also does not expose
 * "update" or "delete": B12.5 is creation only (§9 of the acceptance criteria).
 */

/** The title used when `POST /api/documents` omits one (`docs/DECISIONS.md` D-084). */
export const DEFAULT_NEW_DOCUMENT_TITLE = 'Untitled document';

/** `DocumentMeta.title` is capped at 200 characters (`packages/shared/src/document.ts`). */
export const DOCUMENT_TITLE_MAX_LENGTH = 200;

/** The three facts the server — never the client — decides when creating a document. */
export interface CreateDocumentInput {
  /** Server-generated (`randomUUID`); never accepted from a request body. */
  readonly documentId: string;
  /** Already trimmed and validated by the route. */
  readonly title: string;
  /** The internal user id from `resolveAuthenticatedUser`; never a client-supplied owner. */
  readonly ownerUserId: string;
}

/**
 * The creation capability of the durable store.
 *
 * Separate from the frozen `DocumentStore` seam (`docs/CONTRACTS.md` §14.1), exactly like
 * `DocumentMetaStore`: §14 is about content reconstruction and must not grow a write API for a
 * product feature. Keeping it here also lets `app.ts` take an injectable capability, so a test
 * server without a store simply cannot mount the route.
 */
export interface DocumentCreationStore {
  /**
   * Insert the document, its metadata and the owner membership atomically.
   *
   * Resolves only after `COMMIT`. Rejects on any failure, having rolled back every row; a
   * rejection must never be treated as a partially created document.
   */
  createDocumentWithOwner(input: CreateDocumentInput): Promise<void>;
}

/** True when `value` can create documents atomically (the SQLite store does). */
export function isDocumentCreationStore(value: unknown): value is DocumentCreationStore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof DocumentCreationStore, unknown>>;
  return typeof candidate.createDocumentWithOwner === 'function';
}

/**
 * True when `title` satisfies the metadata schema after trimming.
 *
 * The route calls this to turn a body violation into `400 invalid_request`; the store calls it
 * again as a last line of defence so a future caller cannot insert a title the read API cannot
 * represent.
 */
export function isValidDocumentTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length >= 1 && trimmed.length <= DOCUMENT_TITLE_MAX_LENGTH;
}
