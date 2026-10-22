/**
 * The `node:sqlite` adapter for the durable store.
 *
 * ## Representation (`docs/DECISIONS.md` D-042)
 *
 * One snapshot plus an append-only update log, with the Yjs binary state as the
 * authority:
 *
 * ```text
 * document        (document_id PK, snapshot BLOB, snapshot_seq INT, updated_at INT)
 * document_update (document_id, seq, update_bytes BLOB, created_at, PK(document_id, seq))
 * ```
 *
 * Restoring a document is `applyUpdate(snapshot)` followed by each log row in ascending
 * `seq`. **The rendered Markdown is never stored.** A Markdown string loses everything the
 * CRDT needs to merge correctly — client ids, clocks, deleted-item tombstones, formatting
 * marks — so reconstructing a `Y.Doc` from text would make two clients that were never
 * offline look like concurrent writers and would resurrect deleted content. Markdown stays
 * a projection (`docs/ARCHITECTURE.md` §0, §7.4).
 *
 * ## Durability and the two pragmas that set it
 *
 * `journal_mode = WAL` is what makes "replace snapshot + truncate log" a single crash-safe
 * transaction, and `synchronous = NORMAL` is the setting that matches the claim in
 * `docs/CONTRACTS.md` §14.2 exactly: a committed transaction survives **process** death,
 * but this is not an fsync-per-write promise about power loss. `FULL` would add an fsync
 * to every keystroke-sized append for a guarantee nobody asked for and could not get from
 * the rest of the stack.
 *
 * ## Sequence allocation (`docs/CONTRACTS.md` §14.7, `docs/DECISIONS.md` D-052)
 *
 * `append` allocates `MAX(seq) + 1` for the document, writes the row and returns the
 * sequence **inside one `BEGIN IMMEDIATE` transaction**. D-048 means two callers never
 * reach `append` concurrently for one document, but the store must hold the property on
 * its own: an invariant that depends on the caller's good behaviour turns into
 * "intermittent duplicate seq" the moment the pipeline is refactored.
 */
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { DocumentMeta } from '@insighthub/shared';

import type { AppUser, AppUserStore } from '../authz/app-user.js';
import type { VerifiedIdentity } from '../authz/session-verifier.js';
import { SQLITE_BUSY_TIMEOUT_MS } from './constants.js';
import { defaultDocumentTitle, type DocumentMetaStore } from './document-meta.js';
import { assertDatabaseIntegrity, assertSchemaSupported, ensureSchema } from './schema.js';
import { isSqliteCapabilityError, toUint8Array, type SqliteModule } from './sqlite-runtime.js';
import { runInTransaction } from './transaction.js';
import {
  StoreClosedError,
  StoreOperationError,
  type DocumentStore,
  type StoredDocument,
  type StoredUpdate,
} from './types.js';

/** File name of the durable database inside `INSIGHTHUB_DATA_PATH`. */
export const DATABASE_FILE_NAME = 'insighthub.db';

/** An empty snapshot: a document that has never had content. */
const EMPTY = new Uint8Array(0);

type Db = InstanceType<SqliteModule['DatabaseSync']>;
type Stmt = ReturnType<Db['prepare']>;

export class SqliteDocumentStore implements DocumentStore, DocumentMetaStore, AppUserStore {
  readonly #db: Db;
  readonly #statements: {
    selectDocument: Stmt;
    selectUpdatesAfter: Stmt;
    selectMaxSequence: Stmt;
    selectSnapshotSequence: Stmt;
    insertDocumentIfMissing: Stmt;
    replaceSnapshot: Stmt;
    insertUpdate: Stmt;
    deleteUpdatesThrough: Stmt;
    deleteUpdates: Stmt;
    deleteDocument: Stmt;
    insertMetaIfMissing: Stmt;
    selectMeta: Stmt;
    listMeta: Stmt;
    touchMeta: Stmt;
    deleteMeta: Stmt;
    selectHighestSequence: Stmt;
    selectAppUserByClerkId: Stmt;
    selectAppUserById: Stmt;
    insertAppUser: Stmt;
    updateAppUserProfile: Stmt;
  };
  #closed = false;

  private constructor(db: Db) {
    this.#db = db;
    this.#statements = {
      selectDocument: db.prepare(
        'SELECT snapshot, snapshot_seq FROM document WHERE document_id = ?',
      ),
      selectUpdatesAfter: db.prepare(
        'SELECT seq, update_bytes FROM document_update WHERE document_id = ? AND seq > ? ORDER BY seq ASC',
      ),
      selectMaxSequence: db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM document_update WHERE document_id = ?',
      ),
      selectSnapshotSequence: db.prepare('SELECT snapshot_seq FROM document WHERE document_id = ?'),
      insertDocumentIfMissing: db.prepare(
        'INSERT OR IGNORE INTO document (document_id, snapshot, snapshot_seq, updated_at) VALUES (?, ?, 0, ?)',
      ),
      replaceSnapshot: db.prepare(
        'UPDATE document SET snapshot = ?, snapshot_seq = ?, updated_at = ? WHERE document_id = ?',
      ),
      insertUpdate: db.prepare(
        'INSERT INTO document_update (document_id, seq, update_bytes, created_at) VALUES (?, ?, ?, ?)',
      ),
      deleteUpdatesThrough: db.prepare(
        'DELETE FROM document_update WHERE document_id = ? AND seq <= ?',
      ),
      deleteUpdates: db.prepare('DELETE FROM document_update WHERE document_id = ?'),
      deleteDocument: db.prepare('DELETE FROM document WHERE document_id = ?'),
      // ---- document_meta (M2 Phase 2) ----
      // `OR IGNORE` is what makes creation write-once: the first creator's `owner_id` stands,
      // so a later joiner (or a restart) cannot take ownership by arriving first.
      insertMetaIfMissing: db.prepare(
        'INSERT OR IGNORE INTO document_meta (document_id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ),
      selectMeta: db.prepare(
        'SELECT document_id, title, owner_id, created_at, updated_at FROM document_meta WHERE document_id = ?',
      ),
      listMeta: db.prepare(
        'SELECT document_id, title, owner_id, created_at, updated_at FROM document_meta ORDER BY document_id ASC',
      ),
      touchMeta: db.prepare('UPDATE document_meta SET updated_at = ? WHERE document_id = ?'),
      deleteMeta: db.prepare('DELETE FROM document_meta WHERE document_id = ?'),
      selectHighestSequence: db.prepare(
        `SELECT
           COALESCE((SELECT MAX(seq) FROM document_update WHERE document_id = ?), 0) AS log_seq,
           COALESCE((SELECT snapshot_seq FROM document WHERE document_id = ?), 0) AS snapshot_seq`,
      ),
      // ---- app_user (M4 B1) ----
      // `clerk_user_id` is UNIQUE in the schema, so this lookup is the idempotency key.
      selectAppUserByClerkId: db.prepare(
        'SELECT id, clerk_user_id, email, display_name, created_at, updated_at FROM app_user WHERE clerk_user_id = ?',
      ),
      selectAppUserById: db.prepare(
        'SELECT id, clerk_user_id, email, display_name, created_at, updated_at FROM app_user WHERE id = ?',
      ),
      insertAppUser: db.prepare(
        'INSERT OR IGNORE INTO app_user (id, clerk_user_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      // `COALESCE` keeps a previously known profile field when a later verification does not
      // carry it: a Clerk user whose name is not returned this time must not lose the name.
      updateAppUserProfile: db.prepare(
        'UPDATE app_user SET email = COALESCE(?, email), display_name = COALESCE(?, display_name), updated_at = ? WHERE id = ?',
      ),
    };
  }

  /**
   * Open (or create) the store in `dataPath`.
   *
   * Order matters, and it is the M4 B6 order:
   *
   * ```text
   * busy_timeout  →  quick_check  →  schema-supported  →  WAL/durability  →  create/migrate
   * ```
   *
   * The integrity check runs **before** the first write so a corrupt file is refused instead of
   * being "repaired" into an empty store; the version check runs before WAL because WAL is a
   * write and a newer file must not be touched at all. Create/migrate is one transaction, so a
   * crash leaves either the old version or the new one, never a half-written schema.
   *
   * Synchronous because `DatabaseSync` is; the public seam is still `Promise`-returning so
   * an async adapter can replace this one without changing a caller (`docs/CONTRACTS.md`
   * §14.6).
   */
  static open(sqlite: SqliteModule, dataPath: string): SqliteDocumentStore {
    mkdirSync(dataPath, { recursive: true });
    const db = new sqlite.DatabaseSync(join(dataPath, DATABASE_FILE_NAME));

    try {
      // Busy timeout first: everything after it can wait on a lock instead of failing.
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

      // M4 B6: verify the file before touching it. A corrupt database is a startup refusal
      // (`DATA_INTEGRITY_FAILED`), never an empty store — hydrating from a corrupt file and
      // then persisting that state would overwrite the only recoverable copy (D-051).
      assertDatabaseIntegrity(db, dataPath);

      // Refuse a file written by a newer binary **before** the first write. Establishing WAL
      // below is a write, and a version-2 file must not be modified by a binary that cannot
      // understand it (`DATA_SCHEMA_TOO_NEW`).
      assertSchemaSupported(db, dataPath);

      // WAL is what makes compaction's replace-snapshot-and-truncate-log atomic across a
      // crash. If a filesystem refuses it, that is a startup-level problem, so it is not
      // silently tolerated here — `assertSqliteCapability` already proved it works.
      db.exec('PRAGMA journal_mode = WAL');
      // Matches the stated durability claim exactly (see the file header).
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA foreign_keys = ON');

      // M4 B6: create a new schema or migrate a pre-B6 one in a single transaction. The object
      // definitions live in `schema.ts`, shared by creation and migration.
      ensureSchema(db, dataPath);
    } catch (error) {
      // Release the handle before propagating. A corrupt database makes the first *statement*
      // fail (not the constructor, `docs/DECISIONS.md` D-041), so without this the opened file
      // handle would leak — and on Windows it would keep the file locked, which is how a
      // "failed to start" turns into "cannot even delete the bad file".
      try {
        db.close();
      } catch {
        // Already unusable; the original error is the one worth reporting.
      }
      // A schema/integrity/capability refusal already carries the stable startup code the
      // entrypoint prints; wrapping it in `StoreOperationError` would hide the code.
      if (isSqliteCapabilityError(error)) throw error;
      throw new StoreOperationError('open', error);
    }

    return new SqliteDocumentStore(db);
  }

  /** The absolute-or-relative directory this store was opened against. */
  get closed(): boolean {
    return this.#closed;
  }

  async load(documentId: string): Promise<StoredDocument | null> {
    return this.#guard('load', () => {
      const row = this.#statements.selectDocument.get(documentId);
      // `null` means "never stored", not "empty document" (`docs/CONTRACTS.md` §14.1).
      if (row === undefined) return null;

      const snapshot = toUint8Array(row['snapshot']) ?? EMPTY;
      const snapshotSequence = readInteger(row['snapshot_seq']);

      const updates: StoredUpdate[] = [];
      for (const raw of this.#statements.selectUpdatesAfter.all(documentId, snapshotSequence)) {
        const bytes = toUint8Array(raw['update_bytes']);
        if (bytes === null) {
          // A row whose BLOB is not bytes means the file is corrupt. Failing loudly is the
          // only safe option: silently skipping it would hydrate a document that is
          // missing edits and then persist that truncated state over the good one.
          throw new StoreOperationError('load', new Error('log row is not a BLOB'));
        }
        updates.push({ sequence: readInteger(raw['seq']), update: bytes });
      }

      return { snapshot, snapshotSequence, updates };
    });
  }

  async append(documentId: string, update: Uint8Array): Promise<number> {
    return this.#guard('append', () =>
      this.#transaction(() => {
        // A document that has never been written gets its row here, which is what makes
        // "a join for an unknown document persists on first write" true without a
        // separate create step (`docs/ARCHITECTURE.md` §7.3).
        this.#statements.insertDocumentIfMissing.run(documentId, EMPTY, Date.now());

        const maxRow = this.#statements.selectMaxSequence.get(documentId);
        const snapshotRow = this.#statements.selectSnapshotSequence.get(documentId);

        // `MAX(seq) + 1` is not enough after a compaction: compaction *deletes* the log rows
        // it folded in, so `MAX(seq)` drops back to 0 and the next append would reuse
        // sequence 1 — below `snapshot_seq`. Two consequences, both defects: the sequence
        // would stop being strictly increasing (`docs/CONTRACTS.md` §14.7), and `load`
        // filters `seq > snapshot_seq`, so the new rows would be silently skipped and the
        // edit lost. Taking the snapshot pointer into account keeps the sequence monotonic
        // for the life of the document.
        const highestLogSequence = readInteger(maxRow?.['max_seq']);
        const snapshotSequence = readInteger(snapshotRow?.['snapshot_seq']);
        const sequence = Math.max(highestLogSequence, snapshotSequence) + 1;

        this.#statements.insertUpdate.run(documentId, sequence, update, Date.now());
        return sequence;
      }),
    );
  }

  async compact(documentId: string, snapshot: Uint8Array, throughSequence: number): Promise<void> {
    await this.#guard('compact', () =>
      this.#transaction(() => {
        this.#statements.insertDocumentIfMissing.run(documentId, EMPTY, Date.now());
        this.#statements.replaceSnapshot.run(snapshot, throughSequence, Date.now(), documentId);
        // Snapshot replacement and log truncation are one statement pair in one
        // transaction, so a crash cannot leave a snapshot ahead of its log (§14.7).
        this.#statements.deleteUpdatesThrough.run(documentId, throughSequence);
      }),
    );
  }

  async delete(documentId: string): Promise<void> {
    // Idempotent: deleting an unknown document is a no-op, not an error (§14.1).
    await this.#guard('delete', () =>
      this.#transaction(() => {
        this.#statements.deleteUpdates.run(documentId);
        this.#statements.deleteDocument.run(documentId);
        // Metadata describes the document that no longer exists; leaving the row behind would
        // make the document API list a document whose content cannot be loaded.
        this.#statements.deleteMeta.run(documentId);
      }),
    );
  }

  /* ---------------------------------------------------------------- *
   * document_meta (M2 Phase 2) — the read side of the document API
   * ---------------------------------------------------------------- */

  async ensureDocumentMeta(documentId: string, ownerId: string): Promise<void> {
    await this.#guard('append', () => {
      const now = Date.now();
      // `OR IGNORE`: write-once. The creator recorded first stays the owner, so neither a later
      // joiner nor a restart re-assigns it.
      this.#statements.insertMetaIfMissing.run(
        documentId,
        defaultDocumentTitle(documentId),
        ownerId,
        now,
        now,
      );
    });
  }

  async documentMeta(documentId: string): Promise<DocumentMeta | null> {
    return await this.#guard('load', () => {
      const row = this.#statements.selectMeta.get(documentId);
      if (row === undefined) return null;
      const sequence = this.#statements.selectHighestSequence.get(documentId, documentId);
      return toDocumentMeta(
        row,
        readInteger(sequence?.['log_seq']),
        readInteger(sequence?.['snapshot_seq']),
      );
    });
  }

  async listDocumentMeta(): Promise<readonly DocumentMeta[]> {
    return await this.#guard('load', () => {
      const documents: DocumentMeta[] = [];
      for (const row of this.#statements.listMeta.all()) {
        const documentId = String(row['document_id']);
        const sequence = this.#statements.selectHighestSequence.get(documentId, documentId);
        documents.push(
          toDocumentMeta(
            row,
            readInteger(sequence?.['log_seq']),
            readInteger(sequence?.['snapshot_seq']),
          ),
        );
      }
      return documents;
    });
  }

  async touchDocumentMeta(documentId: string): Promise<void> {
    await this.#guard('append', () => {
      // Never creates a row: a document with content but no metadata row is a state only a
      // pre-Phase-2 store can be in, and inventing an owner here would be worse than leaving it
      // to `ensureDocumentMeta`, which has a real identity to record.
      this.#statements.touchMeta.run(Date.now(), documentId);
    });
  }

  /* ---------------------------------------------------------------- *
   * app_user (M4 B1) — mapping only, never a session
   * ---------------------------------------------------------------- */

  /**
   * Map a verified Clerk identity to one internal id.
   *
   * `clerk_user_id` is UNIQUE and the insert is `OR IGNORE`, so two racing first requests can
   * never create two rows: the loser's insert is ignored and the following SELECT returns the
   * winner's id. The common path is a read only — a profile `UPDATE` runs only when Clerk
   * actually supplies a changed email/name, which keeps a per-request authentication check
   * from turning into a write on every request.
   *
   * The id is generated here (`randomUUID`) and never derived from the Clerk `sub`: the
   * internal id is the server's, so a recreated Clerk user cannot silently inherit
   * memberships.
   */
  async upsertByClerkUserId(identity: VerifiedIdentity): Promise<string> {
    return this.#guard('append', () => {
      const existing = this.#statements.selectAppUserByClerkId.get(identity.clerkUserId);
      if (existing !== undefined) {
        const id = String(existing['id']);
        const currentEmail = typeof existing['email'] === 'string' ? existing['email'] : null;
        const currentName =
          typeof existing['display_name'] === 'string' ? existing['display_name'] : null;
        const emailChanged = identity.email !== undefined && identity.email !== currentEmail;
        const nameChanged =
          identity.displayName !== undefined && identity.displayName !== currentName;
        if (emailChanged || nameChanged) {
          // `COALESCE` in the statement keeps a field Clerk did not return this time.
          this.#statements.updateAppUserProfile.run(
            identity.email ?? null,
            identity.displayName ?? null,
            Date.now(),
            id,
          );
        }
        return id;
      }

      const id = randomUUID();
      const now = Date.now();
      this.#statements.insertAppUser.run(
        id,
        identity.clerkUserId,
        identity.email ?? null,
        identity.displayName ?? null,
        now,
        now,
      );
      // If another connection won the race, `OR IGNORE` left its row in place. Re-reading by
      // the unique key is what makes the returned id the stored one, not the one we minted.
      const stored = this.#statements.selectAppUserByClerkId.get(identity.clerkUserId);
      if (stored === undefined) {
        throw new Error('app_user row disappeared immediately after insert');
      }
      return String(stored['id']);
    });
  }

  async findById(internalUserId: string): Promise<AppUser | null> {
    return this.#guard('load', () => {
      const row = this.#statements.selectAppUserById.get(internalUserId);
      return row === undefined ? null : toAppUser(row);
    });
  }

  async findByClerkUserId(clerkUserId: string): Promise<AppUser | null> {
    return this.#guard('load', () => {
      const row = this.#statements.selectAppUserByClerkId.get(clerkUserId);
      return row === undefined ? null : toAppUser(row);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      // Fold the WAL back into the main file so a copy of the directory is one file.
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // A failed checkpoint does not invalidate the data; `close` still must not throw
      // during shutdown.
    }
    try {
      this.#db.close();
    } catch {
      // Same reasoning: `close()` is documented as safe to call on a store that failed.
    }
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  #assertOpen(): void {
    if (this.#closed) throw new StoreClosedError();
  }

  /**
   * Run `fn`, translating failures into the two error shapes a caller distinguishes.
   *
   * `StoreClosedError` passes through unchanged: "the store is gone" is a lifecycle fact,
   * not a backend fault, and the room layer must not drive `UNHEALTHY` for it during
   * shutdown.
   */
  #guard<T>(operation: StoreOperationError['operation'], fn: () => T): T {
    this.#assertOpen();
    try {
      return fn();
    } catch (error) {
      if (error instanceof StoreClosedError) throw error;
      if (error instanceof StoreOperationError) throw error;
      throw new StoreOperationError(operation, error);
    }
  }

  /**
   * One `BEGIN IMMEDIATE` … `COMMIT` with a guaranteed `ROLLBACK` on failure.
   *
   * The primitive lives in `transaction.ts` because schema migration uses the same one; it is
   * `IMMEDIATE` (rather than the default deferred) so it takes the write lock up front, and the
   * read inside `append` (`MAX(seq)`) cannot race a writer that would invalidate it.
   */
  #transaction<T>(body: () => T): T {
    return runInTransaction(this.#db, body);
  }
}

/** SQLite may report an INTEGER as `number` or `bigint`; normalise to `number`. */
function readInteger(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

/**
 * Map one `app_user` row.
 *
 * A NULL `email`/`display_name` becomes `null`, not `''`: Clerk may genuinely not know the
 * value, and an empty string would make the identity look like it had one.
 */
function toAppUser(row: Record<string, unknown>): AppUser {
  const email = row['email'];
  const displayName = row['display_name'];
  return {
    id: String(row['id']),
    clerkUserId: String(row['clerk_user_id']),
    email: typeof email === 'string' ? email : null,
    displayName: typeof displayName === 'string' ? displayName : null,
    createdAt: readInteger(row['created_at']),
    updatedAt: readInteger(row['updated_at']),
  };
}

/**
 * Map one `document_meta` row plus the document's committed sequences to `DocumentMeta`.
 *
 * `revision` is the highest durably committed sequence — the same number `append` returns, and
 * monotonic because compaction advances `snapshot_seq` rather than resetting it
 * (`docs/DECISIONS.md` D-052). Using it means the API's revision cannot drift from the log's
 * actual position.
 */
function toDocumentMeta(
  row: Record<string, unknown>,
  highestLogSequence: number,
  snapshotSequence: number,
): DocumentMeta {
  return {
    id: String(row['document_id']),
    title: String(row['title']),
    revision: Math.max(highestLogSequence, snapshotSequence),
    ownerId: String(row['owner_id']),
    createdAt: new Date(readInteger(row['created_at'])).toISOString(),
    updatedAt: new Date(readInteger(row['updated_at'])).toISOString(),
  };
}
