/**
 * Turning stored bytes into a ready `Y.Doc` (`docs/ARCHITECTURE.md` §7.2, §7.6).
 *
 * ## What this owns, and what it must never own
 *
 * `DocumentHydrator` owns **replay order and Yjs application**. It does not own
 * membership, policy, the room state machine, or the `Y.Doc` instance itself — the caller
 * passes the document in, so a room keeps sole ownership of its replica. It also never
 * sees a socket.
 *
 * ## Why replay applies rather than merges
 *
 * `Y.applyUpdate` is the only operation used. Yjs updates are commutative and idempotent
 * (structs are identified by `(clientID, clock)`), so replay order does not affect the
 * converged result; `sequence` exists to make the order *deterministic and testable*, not
 * to carry business meaning (`docs/DECISIONS.md` D-042).
 *
 * ## Why a failure here must not degrade to an empty document
 *
 * If the snapshot is corrupt or replay throws, the caller marks the room `UNHEALTHY` and
 * refuses to serve it (`docs/DECISIONS.md` D-043 point 6). Falling back to "empty document"
 * would present "we could not read your document" as "your document is empty" — the worst
 * form of data loss, because the next successful append would then persist that emptiness
 * over the real history.
 */
import { TRANSACTION_ORIGINS } from '@insighthub/shared';
import * as Y from 'yjs';

import type { DocumentStore, StoredDocument } from './types.js';

/** What a successful hydration actually loaded, for logging and tests. */
export interface HydrationResult {
  /** `false` when the store has never seen this document (`load` returned `null`). */
  readonly existed: boolean;
  /** Highest sequence covered by the snapshot plus replayed log rows. */
  readonly sequence: number;
  /** Number of log rows applied after the snapshot. */
  readonly appliedUpdates: number;
  /** Payload bytes of those rows: the starting point for compaction accounting. */
  readonly logBytes: number;
}

/** An empty document's hydration result: nothing stored, nothing to replay. */
export const EMPTY_HYDRATION: HydrationResult = {
  existed: false,
  sequence: 0,
  appliedUpdates: 0,
  logBytes: 0,
};

export class DocumentHydrator {
  readonly #store: DocumentStore;

  constructor(store: DocumentStore) {
    this.#store = store;
  }

  /**
   * Load and replay `documentId` into `doc`.
   *
   * Returns `EMPTY_HYDRATION` for a document the store has never seen — which is a normal
   * first-open, not an error: a join for an unknown document creates a fresh empty
   * document and persists it on first write (`docs/ARCHITECTURE.md` §7.3).
   */
  async hydrate(documentId: string, doc: Y.Doc): Promise<HydrationResult> {
    const stored = await this.#store.load(documentId);
    if (stored === null) return EMPTY_HYDRATION;

    return applyStoredDocument(stored, doc);
  }
}

/**
 * Replay one `StoredDocument` into `doc`, in sequence order.
 *
 * Exported because the store's own tests need the same replay without constructing a
 * hydrator around a stub store, and because keeping exactly one replay implementation is
 * the point: two copies would be two answers to "what does restore mean".
 */
export function applyStoredDocument(stored: StoredDocument, doc: Y.Doc): HydrationResult {
  // An empty snapshot is a real state (a document whose first write created its row but
  // has no compacted state yet). `Y.applyUpdate` on zero bytes throws, so it is skipped
  // explicitly rather than caught.
  if (stored.snapshot.byteLength > 0) {
    Y.applyUpdate(doc, stored.snapshot, TRANSACTION_ORIGINS.persistence);
  }

  // Sort defensively: the SQLite adapter already returns `ORDER BY seq`, but an adapter is
  // replaceable and this is the one place that must not depend on a backend's row order.
  const rows = [...stored.updates].sort((left, right) => left.sequence - right.sequence);

  let sequence = stored.snapshotSequence;
  let logBytes = 0;
  for (const row of rows) {
    // Rows at or below the snapshot are already folded in; replaying them is harmless but
    // would misreport `logBytes` for compaction accounting.
    if (row.sequence <= stored.snapshotSequence) continue;
    if (row.update.byteLength > 0) {
      Y.applyUpdate(doc, row.update, TRANSACTION_ORIGINS.persistence);
    }
    sequence = Math.max(sequence, row.sequence);
    logBytes += row.update.byteLength;
  }

  return { existed: true, sequence, appliedUpdates: rows.length, logBytes };
}
