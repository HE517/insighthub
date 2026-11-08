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

/** Extra facts about one append that the frozen two-argument form cannot express. */
export interface AppendOptions {
  /**
   * Whether this update changes the document **body text**.
   *
   * `document_meta.content_revision` is the D-RC1 comparison number and must advance only
   * when the text changes: a join's `SyncStep2` append is a 2-byte empty update that advances
   * the log but not the body, and counting it would make every preview stale the moment a
   * collaborator joins (A7 P1-6). The room layer computes this from the `Y.Text` delta of the
   * apply, because that is the only layer that has a document.
   *
   * Omitted means "assume the update changes the body": a caller that does not know is
   * assumed to be appending content, which is the safe direction for a revision *guard* (it
   * can only cause a re-preview, never a silent overwrite).
   */
  readonly contentChanged?: boolean;
}

/**
 * One row of `restore_operation` (`docs/agent-governance/P0-1-CONTRACTS.md` C3).
 *
 * Exists so a retried restore is answered from the original result instead of applying twice.
 *
 * **Retention (C3):** rows are kept for **30 days**, which is longer than any retry window the
 * client is allowed to use. A future cleanup job must not delete a row earlier than that; no
 * cleanup job exists in this batch.
 */
export interface RestoreOperationRecord {
  readonly operationId: string;
  /** Hash of the request the operation first executed; a mismatch is `operation_conflict`. */
  readonly requestHash: string;
  /** The `restored` version row the first attempt created (the response's `versionId`). */
  readonly versionId: string;
  /** That version row's `sequence` (the content revision after the restore). */
  readonly sequence: number;
}

/**
 * Everything one restore must commit atomically (C1).
 *
 * The two version states are encoded `Y.Doc` states, not deltas: `preRestoreState` is captured
 * **before** the update is applied, `restoredState` after. Both must be self-contained so they
 * survive log compaction (T10).
 */
export interface AppendRestoreInput {
  readonly documentId: string;
  /** Client-supplied idempotency key, unique per document. */
  readonly operationId: string;
  /** Hash of `(documentId, versionId, baseRevision, actorId)`; see `versions/restore.ts`. */
  readonly requestHash: string;
  /** The content revision the client previewed. Compared **inside** the transaction. */
  readonly expectedRevision: number;
  /** Restore initiator (the Owner); recorded on both version rows. */
  readonly authorId: string;
  /** Title to record on the version rows (today: the document's metadata title). */
  readonly title: string;
  /** Full encoded state captured before `restoreUpdate` is applied. */
  readonly preRestoreState: Uint8Array;
  /** The forward update computed from the current text and the selected version. */
  readonly restoreUpdate: Uint8Array;
  /** Full encoded state after `restoreUpdate` is applied. */
  readonly restoredState: Uint8Array;
  readonly now: number;
}

/**
 * Outcome of {@link DocumentStore.appendRestore}.
 *
 * `sequence` is the **version** sequence (the content revision after the restore), i.e. the
 * number `GET /versions` reports and the client uses to mark the new version; `logSequence`
 * is the append-log position the restore update was written at, which only the room's
 * compaction accounting needs. They are different counters and conflating them would make
 * compaction fold the log through the wrong position.
 *
 * `stale` / `operation_conflict` / `replayed` are **not errors**: they are the transaction
 * declining to write and telling the caller why, having written nothing.
 */
export type AppendRestoreOutcome =
  | {
      readonly kind: 'committed';
      readonly versionId: string;
      readonly sequence: number;
      readonly logSequence: number;
    }
  | { readonly kind: 'replayed'; readonly versionId: string; readonly sequence: number }
  | { readonly kind: 'stale'; readonly currentRevision: number }
  | { readonly kind: 'operation_conflict' };

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
  append(documentId: string, update: Uint8Array, options?: AppendOptions): Promise<number>;

  /**
   * Commit one version restore in **one** `BEGIN IMMEDIATE … COMMIT` (P0-1 C1).
   *
   * The sequence inside the transaction is the contract:
   *
   * ```text
   * ensure document/meta → op-id lookup (returns replayed/conflict, 0 rows)
   *   → content-revision compare (returns stale, 0 rows)
   *   → insert pre-restore version
   *   → append restore update (sequence = max(MAX(seq), snapshot_seq) + 1)
   *   → content_revision += 1
   *   → insert restored version (sequence = new content_revision)
   *   → insert restore_operation
   * ```
   *
   * A four-row success is the accounting T4 asserts. It cannot be composed from `append`:
   * that method opens its own transaction, and SQLite has no nested `BEGIN IMMEDIATE`
   * (A7 Q1-2). A throw rolls all four back; the caller then treats the room as unhealthy.
   *
   * `content_revision` is **not** incremented when `restoreUpdate` is empty (restoring the
   * current text): the body did not change, so a preview must not become stale.
   */
  appendRestore(input: AppendRestoreInput): Promise<AppendRestoreOutcome>;

  /**
   * Look up a previously committed restore operation, **scoped to its document**.
   *
   * The unique key is `(document_id, operation_id)` (C3): reusing an operation id on a
   * different document is an independent operation and must never expose the other
   * document's result.
   */
  findRestoreOperation(
    documentId: string,
    operationId: string,
  ): Promise<RestoreOperationRecord | null>;

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
  readonly operation:
    | 'open'
    | 'load'
    | 'append'
    | 'restore'
    | 'compact'
    | 'delete'
    | 'close';

  constructor(operation: StoreOperationError['operation'], cause: unknown) {
    super(`document store ${operation} failed`);
    this.name = 'StoreOperationError';
    this.operation = operation;
    // Kept for the server log only. The transport must never serialise this to a client.
    this.cause = cause;
  }
}
