/**
 * The document-metadata source behind `GET /api/documents` and `GET /api/documents/:id`.
 *
 * ## Why this is an injected seam and not a direct table read
 *
 * The memberships say *who may read what*; they do not carry a title, an owner or a revision.
 * `DocumentMeta` (§1) has to come from somewhere, and in Phase 2 the durable documents source
 * is A3's (`apps/server/src/persistence/**` — the next leg adds a read-only documents source
 * there, `docs/TASKS.md` M2 Phase 2 ownership).
 *
 * So authorization takes the catalog as an **injected dependency**:
 *
 * ```text
 * createAuthz({ dataPath, documents })   // ← the only place a real source is wired in
 * ```
 *
 * Until then `DemoDocumentCatalog` serves the labelled demo fixture. Replacing it later touches
 * one construction site, not `authz/**`.
 *
 * `get` is `Promise`-returning even though the demo implementation is synchronous: the real
 * source will read the durable store, and a seam whose shape changes when the backing store
 * arrives is not a seam.
 */
import type { DocumentMeta } from '@insighthub/shared';

import { DEMO_DOCUMENTS } from './demo-fixture.js';

export interface DocumentCatalog {
  /** Metadata for one document, or `null` when the server has never heard of it. */
  get(documentId: string): Promise<DocumentMeta | null>;
}

/**
 * The demo catalog: fixed metadata from `demo-fixture.ts`.
 *
 * It never invents an entry for an unknown id — `null` is what makes `GET /api/documents/:id`
 * answer the same `404` for "unknown" and "not yours" (§17.4).
 */
export class DemoDocumentCatalog implements DocumentCatalog {
  readonly #documents: ReadonlyMap<string, DocumentMeta>;

  constructor(documents: readonly DocumentMeta[] = DEMO_DOCUMENTS) {
    const byId = new Map<string, DocumentMeta>();
    for (const document of documents) {
      // Frozen so no caller can mutate the fixture through a response object that aliases it.
      byId.set(document.id, Object.freeze({ ...document }));
    }
    this.#documents = byId;
  }

  get(documentId: string): Promise<DocumentMeta | null> {
    return Promise.resolve(this.#documents.get(documentId) ?? null);
  }
}
