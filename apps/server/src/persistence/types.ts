/**
 * The durable persistence seam for M2-P0-1 (`docs/ARCHITECTURE.md` §7.3,
 * `docs/CONTRACTS.md` §14.1).
 *
 * ## Why this file exists as an interface rather than as SQLite calling code
 *
 * Persistence is reached through exactly one interface, so that no business layer
 * depends on a specific SQLite/file API and the backend stays replaceable. The frozen
 * rule that makes the layering testable (`docs/ARCHITECTURE.md` §7.2):
 *
 * > `DocumentStore` never sees a socket and `DocumentRoom` never sees a file.
 *
 * `RoomRegistry` is the only place that knows both exist.
 *
 * ## Durability claim, stated precisely (`docs/CONTRACTS.md` §14.2)
 *
 * `append` resolving means the update survives **process death**. It is not an
 * fsync-per-write promise about power loss, and it is not a replication promise.
 * Naming the weaker guarantee is deliberate: claiming "durable" without naming the
 * failure model is how persistence claims become marketing.
 *
 * ## Why every method is `Promise`-returning although the backend is synchronous
 *
 * `node:sqlite`'s `DatabaseSync` is synchronous, so the current implementation returns
 * already-resolved promises. The seam is still asynchronous because
 * `docs/ARCHITECTURE.md` §7.7 and `docs/CONTRACTS.md` §14.6 make the per-document FIFO
 * ordering an **adapter-independent** invariant: swapping in an async adapter must not
 * change observable ordering. A synchronous `void` seam would bake today's backend into
 * the contract and invite someone to interleave two appends later.
 */

/** One row of the append-only update log. */
export interface StoredUpdate {
  /** Strictly increasing within a document; the log's total order (`§14.7`). */
  readonly sequence: number;
  readonly update: Uint8Array;
}

/** Everything needed to reconstruct one document: a snapshot plus the log after it. */
export interface StoredDocument {
  /** Encoded Yjs state (`Y.encodeStateAsUpdate`). May be empty for a fresh document. */
  readonly snapshot: Uint8Array;
  /** The highest sequence the snapshot already covers. Never a future sequence. */
  readonly snapshotSequence: number;
  /** Log rows with `sequence > snapshotSequence`, in sequence order. */
  readonly updates: readonly StoredUpdate[];
}

/**
 * The durable store.
 *
 * `load` returning `null` means "never stored", **not** "empty document": a join for an
 * unknown document creates a fresh empty document and persists it on first write.
 */
export interface DocumentStore {
  /** Load the durable state, or `null` when this document has never been stored. */
  load(documentId: string): Promise<StoredDocument | null>;

  /**
   * Atomically allocate the next sequence, write the update, and return the committed
   * sequence.
   *
   * Resolves only once the bytes are durable; rejects on failure, and the caller must
   * not treat a rejection as a partial success.
   *
   * The frozen interface sketch in `docs/ARCHITECTURE.md` §7.3 writes this as
   * `Promise<void>`, while `docs/CONTRACTS.md` §14.7 (the normative seam) requires it to
   * "return the committed sequence". Returning the sequence satisfies both readings — a
   * caller that wants `void` simply ignores it — and `§14.7` is the normative text, so
   * this is what is implemented. Recorded in the M2-P0-1 report as a documentation
   * inconsistency rather than silently picking one.
   */
  append(documentId: string, update: Uint8Array): Promise<number>;

  /**
   * Replace the snapshot, advance `snapshot_seq` and delete the consumed log rows.
   *
   * Must be one transaction: a crash mid-compaction leaves either the old state or the
   * new one, never a snapshot ahead of its log (`docs/DECISIONS.md` D-052 point 4).
   */
  compact(documentId: string, snapshot: Uint8Array, throughSequence: number): Promise<void>;

  /**
   * Durably remove a document.
   *
   * A real removal, not a soft flag: callers must treat the document as gone. Frozen now
   * so no caller has to guess later (`docs/ARCHITECTURE.md` §7.3).
   */
  delete(documentId: string): Promise<void>;

  /** Flush and release the backend. Idempotent; safe on a store that failed to open. */
  close(): Promise<void>;
}

/**
 * Raised when a store operation is attempted after `close()`.
 *
 * A separate class rather than a bare `Error` so a caller can distinguish "the store is
 * gone" (programming error, or shutdown racing an in-flight mutation) from "the backend
 * failed" (an I/O condition that drives `UNHEALTHY`).
 */
export class StoreClosedError extends Error {
  constructor() {
    super('document store is closed');
    this.name = 'StoreClosedError';
  }
}

/**
 * Raised by `append`/`compact`/`load` when the underlying backend fails.
 *
 * The `operation` field exists so the room layer can log "which step failed" (D-044
 * point 6: log the detail, never send a stack, path or SQL to a client) without parsing
 * an error message.
 */
export class StoreOperationError extends Error {
  readonly operation: 'open' | 'load' | 'append' | 'compact' | 'delete' | 'close';

  constructor(operation: StoreOperationError['operation'], cause: unknown) {
    super(`document store ${operation} failed`);
    this.name = 'StoreOperationError';
    this.operation = operation;
    // Kept for the server log only. The transport must never serialise this to a client.
    this.cause = cause;
  }
}
