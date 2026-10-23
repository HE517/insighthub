/**
 * The durable document-metadata source behind `GET /api/documents` and
 * `GET /api/documents/:id` (`docs/CONTRACTS.md` §12, §17.4).
 *
 * ## The gap this closes
 *
 * `authz/documents.ts` takes its `DocumentCatalog` as an **injected seam** precisely because a
 * membership row says *who may read what* but carries no title, owner or revision. Until this
 * file existed the seam was served by `DemoDocumentCatalog` — a labelled fixture. Now the store
 * that actually holds the documents answers for them, and `index.ts` swaps it in at the one
 * construction site (`createAuthz({ documents })`).
 *
 * ## Read-only, in the sense that matters
 *
 * The catalog itself only reads: `get` and `list` issue SELECTs and never mutate. Creation is
 * separate: a socket's first write still calls `ensureDocumentMeta` (with the id as the default
 * title), and since B12.5 an explicit `POST /api/documents` writes document + metadata + owner
 * membership atomically through `createDocumentWithOwner`. Keeping the read surface pure is what
 * lets `DocumentCatalog` stay a query seam (§17.4).
 *
 * ## Where each `DocumentMeta` field comes from, and why
 *
 * | Field | Source | Note |
 * | --- | --- | --- |
 * | `id` | `document.document_id` | |
 * | `revision` | highest durably committed sequence for the document | server-owned and monotonic (§1); it is the same counter `append` returns, not a second one |
 * | `createdAt` / `updatedAt` | the metadata row's timestamps | written at creation / refreshed on append |
 * | `title` | the row's title | The socket-first creation path defaults to the document id; B12.5's `POST /api/documents` stores a user-supplied title (default `Untitled document`) |
 * | `ownerId` | the identity that first made the document durable | Phase-2 attribution only. It is **not** an authorization input: every decision comes from the membership table (`apps/server/src/authz/**`), and this field is display metadata |
 *
 * The `ownerId` row is the one judgement call here, and it is recorded as such rather than
 * buried: a demo document's seeded membership names an `owner`, while this field names whoever
 * created the durable row. The two agree whenever the seeded owner opens their own document
 * first, and they can differ otherwise. Reconciling them would mean composing this catalog with
 * A5's fixture, which needs a fixture export that does not exist (`docs/TASKS.md` M2 Phase 2
 * ownership keeps `authz/**` private) — raised as a decision in the M2 Phase 2 P1 A3 report
 * instead of being papered over here.
 */
import type { DocumentMeta } from '@insighthub/shared';

import type { DocumentCatalog } from '../authz/public.js';

/** `DocumentMeta.title` is capped at 200 characters (`document.ts`). */
const TITLE_MAX_LENGTH = 200;

/**
 * The metadata half of the durable store.
 *
 * Separate from the frozen `DocumentStore` seam (`docs/CONTRACTS.md` §14.1) on purpose: that
 * interface is about *content* — snapshot plus append-only log — and adding metadata methods to
 * it would be a contract change for something §14 does not cover. This is an adjacent capability
 * that only the catalog and the creation path need.
 */
export interface DocumentMetaStore {
  /**
   * Record a document's existence, once.
   *
   * Idempotent and **write-once**: the first caller's `ownerId` wins, so a later joiner cannot
   * become the owner by arriving first after a restart.
   */
  ensureDocumentMeta(documentId: string, ownerId: string): Promise<void>;

  /** The metadata for one document, or `null` when the store has never seen it. */
  documentMeta(documentId: string): Promise<DocumentMeta | null>;

  /** Every durable document, ordered by id so a response never depends on row order. */
  listDocumentMeta(): Promise<readonly DocumentMeta[]>;

  /** Refresh `updatedAt` after a committed append. Never creates a row. */
  touchDocumentMeta(documentId: string): Promise<void>;
}

/** True when `value` can serve document metadata (the SQLite store does). */
export function isDocumentMetaStore(value: unknown): value is DocumentMetaStore {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof DocumentMetaStore, unknown>>;
  return (
    typeof candidate.ensureDocumentMeta === 'function' &&
    typeof candidate.documentMeta === 'function' &&
    typeof candidate.listDocumentMeta === 'function' &&
    typeof candidate.touchDocumentMeta === 'function'
  );
}

/**
 * `DocumentCatalog` backed by the durable store.
 *
 * `null` for an unknown id is what makes the non-disclosure rule work (§17.4): "unknown
 * document", "not a member" and "no `canRead`" must all leave through the same `404`, and a
 * catalog that invented an entry for an unknown id would break that from the inside.
 */
export class StoreDocumentCatalog implements DocumentCatalog {
  readonly #store: DocumentMetaStore;

  constructor(store: DocumentMetaStore) {
    this.#store = store;
  }

  async get(documentId: string): Promise<DocumentMeta | null> {
    if (documentId.length === 0) return null;
    return await this.#store.documentMeta(documentId);
  }

  async list(): Promise<readonly DocumentMeta[]> {
    return await this.#store.listDocumentMeta();
  }
}

/**
 * The default title for a durable document.
 *
 * The id, because the socket-first creation path has no title to record. Truncated to the
 * schema's limit rather than throwing: a long document id is a legitimate id, and refusing to
 * describe the document because its *default title* is too long would make the document
 * invisible to the API for a cosmetic reason. `POST /api/documents` does not use this default;
 * it stores `Untitled document` when the client omits a title (D-084).
 */
export function defaultDocumentTitle(documentId: string): string {
  if (documentId.length <= TITLE_MAX_LENGTH) return documentId;
  return documentId.slice(0, TITLE_MAX_LENGTH);
}
