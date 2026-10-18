/**
 * The one durable thing authorization owns: **document membership** (`documentId`, `userId`,
 * `role`).
 *
 * ## Why this is a second SQLite file rather than a table in the document store
 *
 * `docs/DECISIONS.md` D-061 §5 says membership is persisted in an **A5-owned table**. Two
 * candidate homes were considered:
 *
 * | Option | Why it was rejected / chosen |
 * | --- | --- |
 * | a table inside `insighthub.db` (A3's `DocumentStore`) | the store's schema, migrations and lifecycle belong to A3 (`apps/server/src/persistence/**` is theirs, and `authz/**` must not edit it). Adding tables to somebody else's database file also puts membership writes on the same connection as every keystroke's `append`. |
 * | its own file, `authz.db` | **chosen.** No schema coupling, no write contention with the hot document path, and "delete the document store" cannot silently orphan an authorization decision. |
 *
 * The consequence is stated plainly instead of hidden: `DocumentStore.delete(documentId)` does
 * **not** cascade into these rows. That is recorded as an integration note for A3 in the task
 * report; with a demo fixture and no deletion endpoint in Phase 2 it cannot be reached today.
 *
 * ## Why the seam is synchronous while the document store's is not
 *
 * `DocumentStore` is `Promise`-returning because per-document FIFO ordering must survive an
 * async adapter (`docs/CONTRACTS.md` §14.6). Authorization has the opposite requirement: a
 * capability check on a WebSocket frame must be a **single, non-interleaving** decision. An
 * `await` between "who is this" and "may they write" is a window in which the answer can
 * change. So `roleFor`/`can` are synchronous and return the decision the durable row holds at
 * the moment of the call.
 *
 * ## Fail closed on a row nobody can parse
 *
 * A stored role that is not a `DocumentRole` (hand-edited file, future vocabulary, corruption)
 * is treated as **no membership**, which produces the `404` path — never as a default role. The
 * alternative (falling back to `viewer`) would turn file corruption into a quiet capability
 * grant.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { isDocumentRole, type DocumentRole } from '@insighthub/shared';

import { SQLITE_BUSY_TIMEOUT_MS } from '../persistence/constants.js';
import { loadSqliteModule, type SqliteModule } from '../persistence/sqlite-runtime.js';

/** File name of the A5-owned authorization database inside `INSIGHTHUB_DATA_PATH`. */
export const AUTHZ_DATABASE_FILE_NAME = 'authz.db';

/** One membership row. The durable unit of the authorization decision. */
export interface MembershipRow {
  readonly documentId: string;
  readonly userId: string;
  readonly role: DocumentRole;
}

/**
 * What the decision core needs from storage.
 *
 * An interface rather than a class so the core can be tested against a double without a
 * database — and so "authorization reads a table" stays a replaceable detail instead of
 * becoming the architecture.
 */
export interface MembershipStore {
  /** The caller's role on one document, or `null` when there is no usable row. */
  roleFor(documentId: string, userId: string): DocumentRole | null;
  /** Every row for one user, for `GET /api/documents`. */
  rowsForUser(userId: string): readonly MembershipRow[];
  /** Insert rows, ignoring ones that already exist. Returns how many were inserted. */
  seed(rows: readonly MembershipRow[]): number;
  /** Total rows. Used by the startup log and by tests; never by a decision. */
  count(): number;
  close(): void;
}

type Db = InstanceType<SqliteModule['DatabaseSync']>;
type Stmt = ReturnType<Db['prepare']>;

export class SqliteMembershipStore implements MembershipStore {
  readonly #db: Db;
  readonly #statements: {
    selectRole: Stmt;
    selectByUser: Stmt;
    insertIgnore: Stmt;
    count: Stmt;
  };
  #closed = false;

  private constructor(db: Db) {
    this.#db = db;
    this.#statements = {
      selectRole: db.prepare(
        'SELECT role FROM authz_document_membership WHERE document_id = ? AND user_id = ?',
      ),
      selectByUser: db.prepare(
        'SELECT document_id, user_id, role FROM authz_document_membership WHERE user_id = ? ORDER BY document_id ASC',
      ),
      insertIgnore: db.prepare(
        'INSERT OR IGNORE INTO authz_document_membership (document_id, user_id, role) VALUES (?, ?, ?)',
      ),
      count: db.prepare('SELECT COUNT(*) AS total FROM authz_document_membership'),
    };
  }

  /**
   * Open (or create) the membership database in `dataPath`.
   *
   * Synchronous for the same reason the seam is: the table is tiny and a read must not be
   * deferred behind an `await` in an authorization path.
   */
  static open(sqlite: SqliteModule, dataPath: string): SqliteMembershipStore {
    mkdirSync(dataPath, { recursive: true });
    const db = new sqlite.DatabaseSync(join(dataPath, AUTHZ_DATABASE_FILE_NAME));

    try {
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      // WAL keeps a crash from leaving a half-written table. `synchronous = NORMAL` matches the
      // rest of the server: a committed row survives process death, and no stronger claim is
      // made (`docs/CONTRACTS.md` §14.2, D-060 §2).
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      // The table name carries the word "authz" and the fixture is labelled demo data; nothing
      // here models a general-purpose user or membership-management product (§17.3).
      db.exec(`
        CREATE TABLE IF NOT EXISTS authz_document_membership (
          document_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          PRIMARY KEY (document_id, user_id)
        )
      `);
    } catch (error) {
      // Release the handle before propagating: on Windows a leaked handle keeps the file
      // locked, which turns "failed to start" into "cannot even move the bad file aside".
      try {
        db.close();
      } catch {
        // The original error is the informative one.
      }
      throw error;
    }

    return new SqliteMembershipStore(db);
  }

  roleFor(documentId: string, userId: string): DocumentRole | null {
    this.#assertOpen();
    const row = this.#statements.selectRole.get(documentId, userId);
    if (row === undefined) return null;
    const role = row['role'];
    // Fail closed: an unparseable role is "no membership", never a default grant.
    return isDocumentRole(role) ? role : null;
  }

  rowsForUser(userId: string): readonly MembershipRow[] {
    this.#assertOpen();
    const rows: MembershipRow[] = [];
    for (const raw of this.#statements.selectByUser.all(userId)) {
      const documentId = raw['document_id'];
      const storedUserId = raw['user_id'];
      const role = raw['role'];
      if (typeof documentId !== 'string' || typeof storedUserId !== 'string') continue;
      // Same fail-closed rule as `roleFor`: a row that cannot be understood is skipped rather
      // than widened, so the list endpoint can never show a document the decision core denies.
      if (!isDocumentRole(role)) continue;
      rows.push({ documentId, userId: storedUserId, role });
    }
    return rows;
  }

  seed(rows: readonly MembershipRow[]): number {
    this.#assertOpen();
    let inserted = 0;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        // `isDocumentRole` runs before the write: a typo in the fixture must fail here, not
        // become a row that `roleFor` silently ignores.
        if (!isDocumentRole(row.role)) {
          throw new Error(`invalid demo membership role for ${row.documentId}/${row.userId}`);
        }
        const result = this.#statements.insertIgnore.run(row.documentId, row.userId, row.role);
        inserted += Number(result.changes);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // The transaction may already be gone; the original error is what matters.
      }
      throw error;
    }
    return inserted;
  }

  count(): number {
    this.#assertOpen();
    const row = this.#statements.count.get();
    const total = row?.['total'];
    if (typeof total === 'number') return total;
    if (typeof total === 'bigint') return Number(total);
    return 0;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // A failed checkpoint does not invalidate committed rows.
    }
    try {
      this.#db.close();
    } catch {
      // `close()` must not throw during shutdown.
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('the authorization membership store is closed');
  }
}

/** Open the membership store, verifying the SQLite runtime first. */
export async function openMembershipStore(dataPath: string): Promise<SqliteMembershipStore> {
  const sqlite = await loadSqliteModule();
  return SqliteMembershipStore.open(sqlite, dataPath);
}
