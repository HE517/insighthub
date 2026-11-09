/**
 * The one durable thing authorization owns: **document membership** (`documentId`, `userId`,
 * `role`).
 *
 * ## Where it lives now (M4 B12.5, `docs/DECISIONS.md` D-084 method C)
 *
 * Membership used to live in its own SQLite file, `authz.db` (D-061 §5). That decision has been
 * **overturned** for one concrete reason: B12.5 requires "document row + metadata row + owner
 * membership" to commit atomically, and SQLite has no cross-database transaction in WAL mode.
 * The table therefore lives in `insighthub.db` as `authz_document_membership`, and
 * `SqliteDocumentStore.createDocumentWithOwner` writes all three rows in one
 * `BEGIN IMMEDIATE … COMMIT`.
 *
 * Consequences, stated plainly rather than hidden:
 *
 * - The table is still **owned by the authorization domain** (name prefix `authz_`), even though
 *   its file is the document database. `persistence/schema.ts` owns the DDL/migration because it
 *   owns the file; `authz/**` owns every decision made from the rows.
 * - The runtime opens `insighthub.db` here on a **separate read connection**, so an authorization
 *   check stays a single synchronous decision and does not wait behind the document write path.
 *   SQLite's WAL mode allows one writer plus concurrent readers; both connections use the same
 *   busy timeout.
 * - **`authz.db` is never opened at runtime.** It is read only by the v1 → v2 migration inside
 *   `schema.ts`, read-only, and is kept for audit/recovery. There is no dual-write or dual-read:
 *   a row that remains only in the legacy file grants nothing.
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
import { assertSchemaSupported, ensureSchema } from '../persistence/schema.js';
import { loadSqliteModule, type SqliteModule } from '../persistence/sqlite-runtime.js';
import { DATABASE_FILE_NAME } from '../persistence/sqlite-store.js';
import { runInTransaction } from '../persistence/transaction.js';

/** One membership row. The durable unit of the authorization decision. */
export interface MembershipRow {
  readonly documentId: string;
  readonly userId: string;
  readonly role: DocumentRole;
}

/**
 * The roles an Owner may hand out directly.
 *
 * `owner` is deliberately **not** in the list: `docs/agent-governance/P0-2-MEMBERS.md` says
 * ownership only moves through the transfer operation, which is the only operation that keeps
 * "exactly one owner" true inside a transaction. An invite/`PATCH` body carrying `owner` is a
 * validation error (`400 invalid_request`), not a quiet `editor`.
 */
export const ASSIGNABLE_MEMBER_ROLES = ['viewer', 'commenter', 'editor'] as const;

export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];

/** True when `value` is a role a member operation may assign directly. */
export function isAssignableMemberRole(value: unknown): value is AssignableMemberRole {
  return (
    value === 'viewer' ||
    value === 'commenter' ||
    value === 'editor'
  );
}

/**
 * Why a membership write was refused.
 *
 * These are **domain** codes, mapped to HTTP by `app.ts`. Keeping them out of the store's error
 * payload is what lets the HTTP layer own status/body mapping while the transaction owns the
 * invariant. `member_not_found` is distinct from `not_found` on purpose: the first means "the
 * document is yours but the target row is not", the second is the non-disclosing "no access".
 */
export type MembershipWriteErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'member_not_found'
  | 'already_owner'
  | 'owner_role_immutable'
  | 'owner_requires_transfer'
  | 'last_owner'
  | 'invalid_role'
  | 'invariant_violation';

/** One refused membership write. Carries only the domain code, never a row or an SQL string. */
export class MembershipWriteError extends Error {
  readonly code: MembershipWriteErrorCode;

  constructor(code: MembershipWriteErrorCode) {
    super(`membership write refused: ${code}`);
    this.name = 'MembershipWriteError';
    this.code = code;
  }
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
  /** Every row for one document, for `GET /api/documents/:id/members`. */
  rowsForDocument(documentId: string): readonly MembershipRow[];
  /** Insert rows, ignoring ones that already exist. Returns how many were inserted. */
  seed(rows: readonly MembershipRow[]): number;
  /** Total rows. Used by the startup log and by tests; never by a decision. */
  count(): number;
  close(): void;

  /*
   * ---- P0-2 member management (every one is a single transaction) ----
   *
   * Each write re-checks "the actor is still the Owner" **inside** the transaction, because the
   * HTTP layer's check happened before body parsing. Two requests can both pass that check and
   * then serialise on `BEGIN IMMEDIATE`; the loser must be refused on the state it now finds,
   * not on the state it arrived with. The methods throw {@link MembershipWriteError} for every
   * domain refusal — a returned value always means the row committed.
   */

  /** Owner invites (or re-roles) a member. Never assigns `owner`. */
  invite(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
    role: AssignableMemberRole,
  ): MembershipRow;
  /** Owner changes a non-owner member's role. The target owner is immutable via this call. */
  changeRole(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
    role: AssignableMemberRole,
  ): MembershipRow;
  /** Owner removes a non-owner member. */
  remove(documentId: string, actorUserId: string, targetUserId: string): void;
  /** Owner transfers ownership atomically (demote actor, promote target). */
  transferOwner(documentId: string, actorUserId: string, targetUserId: string): MembershipRow;
  /** A member removes their own row; an Owner must transfer first. */
  leave(documentId: string, actorUserId: string): void;
}

type Db = InstanceType<SqliteModule['DatabaseSync']>;
type Stmt = ReturnType<Db['prepare']>;

export class SqliteMembershipStore implements MembershipStore {
  readonly #db: Db;
  readonly #statements: {
    selectRole: Stmt;
    selectByUser: Stmt;
    selectByDocument: Stmt;
    insertIgnore: Stmt;
    upsertRole: Stmt;
    updateRole: Stmt;
    deleteMembership: Stmt;
    count: Stmt;
    countOwners: Stmt;
    selectOwnerId: Stmt;
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
      // Deterministic order, so the member list response cannot depend on SQLite row order.
      selectByDocument: db.prepare(
        'SELECT document_id, user_id, role FROM authz_document_membership WHERE document_id = ? ORDER BY user_id ASC',
      ),
      insertIgnore: db.prepare(
        'INSERT OR IGNORE INTO authz_document_membership (document_id, user_id, role) VALUES (?, ?, ?)',
      ),
      // One statement makes "invite an existing member" an idempotent role update (P0-2): the
      // composite primary key is the conflict target, so there is no read-then-write window.
      upsertRole: db.prepare(
        `INSERT INTO authz_document_membership (document_id, user_id, role)
         VALUES (?, ?, ?)
         ON CONFLICT(document_id, user_id) DO UPDATE SET role = excluded.role`,
      ),
      updateRole: db.prepare(
        'UPDATE authz_document_membership SET role = ? WHERE document_id = ? AND user_id = ?',
      ),
      deleteMembership: db.prepare(
        'DELETE FROM authz_document_membership WHERE document_id = ? AND user_id = ?',
      ),
      count: db.prepare('SELECT COUNT(*) AS total FROM authz_document_membership'),
      countOwners: db.prepare(
        "SELECT COUNT(*) AS total FROM authz_document_membership WHERE document_id = ? AND role = 'owner'",
      ),
      selectOwnerId: db.prepare(
        "SELECT user_id FROM authz_document_membership WHERE document_id = ? AND role = 'owner' ORDER BY user_id ASC LIMIT 1",
      ),
    };
  }

  /**
   * Open a membership read connection against `insighthub.db` in `dataPath`.
   *
   * Synchronous for the same reason the seam is: the table is tiny and a read must not be
   * deferred behind an `await` in an authorization path.
   *
   * `ensureSchema` runs here as well as in `SqliteDocumentStore.open`, for the callers that
   * build authorization without opening the document store first (the authz unit suites and
   * `createAuthz` itself). It is idempotent: on an already-current file it only verifies the
   * objects and returns.
   */
  static open(sqlite: SqliteModule, dataPath: string): SqliteMembershipStore {
    mkdirSync(dataPath, { recursive: true });
    const db = new sqlite.DatabaseSync(join(dataPath, DATABASE_FILE_NAME));

    try {
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      // Version before WAL: establishing WAL is a write, and a future schema must not be touched.
      assertSchemaSupported(db, dataPath);
      // WAL keeps a crash from leaving a half-written table. `synchronous = NORMAL` matches the
      // rest of the server: a committed row survives process death, and no stronger claim is
      // made (`docs/CONTRACTS.md` §14.2, D-060 §2).
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      // The v1 → v2 migration (including the read-only legacy `authz.db` import) runs inside
      // `ensureSchema`; it is a no-op on a schema-2 file.
      ensureSchema(db, dataPath, sqlite);
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

  rowsForDocument(documentId: string): readonly MembershipRow[] {
    this.#assertOpen();
    return this.#readRowsForDocument(documentId);
  }

  /* ---------------------------------------------------------------- *
   * P0-2 member writes — one transaction each
   * ---------------------------------------------------------------- */

  invite(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
    role: AssignableMemberRole,
  ): MembershipRow {
    this.#assertOpen();
    if (!isAssignableMemberRole(role)) throw new MembershipWriteError('invalid_role');
    return runInTransaction(this.#db, () => {
      this.#assertOwner(documentId, actorUserId);
      // An existing owner can only be the actor (the single-owner invariant), but checking the
      // target row rather than the id keeps this correct if that invariant is ever violated by
      // data written outside this class.
      if (this.#readRole(documentId, targetUserId) === 'owner') {
        throw new MembershipWriteError('already_owner');
      }
      this.#statements.upsertRole.run(documentId, targetUserId, role);
      this.#assertSingleOwner(documentId);
      return { documentId, userId: targetUserId, role };
    });
  }

  changeRole(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
    role: AssignableMemberRole,
  ): MembershipRow {
    this.#assertOpen();
    if (!isAssignableMemberRole(role)) throw new MembershipWriteError('invalid_role');
    return runInTransaction(this.#db, () => {
      this.#assertOwner(documentId, actorUserId);
      const targetRole = this.#readRole(documentId, targetUserId);
      if (targetRole === null) throw new MembershipWriteError('member_not_found');
      if (targetRole === 'owner') throw new MembershipWriteError('owner_role_immutable');
      this.#statements.updateRole.run(role, documentId, targetUserId);
      this.#assertSingleOwner(documentId);
      return { documentId, userId: targetUserId, role };
    });
  }

  remove(documentId: string, actorUserId: string, targetUserId: string): void {
    this.#assertOpen();
    runInTransaction(this.#db, () => {
      this.#assertOwner(documentId, actorUserId);
      const targetRole = this.#readRole(documentId, targetUserId);
      if (targetRole === null) throw new MembershipWriteError('member_not_found');
      if (targetRole === 'owner') throw new MembershipWriteError('owner_requires_transfer');
      this.#statements.deleteMembership.run(documentId, targetUserId);
      this.#assertSingleOwner(documentId);
    });
  }

  transferOwner(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
  ): MembershipRow {
    this.#assertOpen();
    return runInTransaction(this.#db, () => {
      this.#assertOwner(documentId, actorUserId);
      const targetRole = this.#readRole(documentId, targetUserId);
      if (targetRole === null) throw new MembershipWriteError('member_not_found');
      if (targetRole === 'owner') throw new MembershipWriteError('already_owner');
      // The invariant the transfer exists to preserve, checked before any row is written.
      this.#assertSingleOwner(documentId);

      // Demote first, then promote: a crash between the two statements is rolled back by the
      // surrounding transaction, so no committed state ever has two owners. (Demoting first also
      // means an injected failure on the promote statement leaves the pre-transfer state after
      // the rollback, which is what the regression test asserts.)
      this.#statements.updateRole.run('editor', documentId, actorUserId);
      this.#statements.updateRole.run('owner', documentId, targetUserId);

      // Read back inside the transaction: counts and the owner id are the committed truth.
      const ownerId = this.#readOwnerId(documentId);
      if (ownerId !== targetUserId) throw new MembershipWriteError('invariant_violation');
      this.#assertSingleOwner(documentId);
      return { documentId, userId: targetUserId, role: 'owner' };
    });
  }

  leave(documentId: string, actorUserId: string): void {
    this.#assertOpen();
    runInTransaction(this.#db, () => {
      const role = this.#readRole(documentId, actorUserId);
      if (role === null) throw new MembershipWriteError('not_found');
      // An Owner leaving would leave the document without an owner; the contract requires a
      // transfer first, so this is a refusal, not an automatic promotion.
      if (role === 'owner') throw new MembershipWriteError('last_owner');
      this.#statements.deleteMembership.run(documentId, actorUserId);
      this.#assertSingleOwner(documentId);
    });
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
      // Best effort: another connection may be using the WAL at shutdown, in which case a
      // checkpoint is simply skipped. Committed rows are not affected either way.
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

  /** The raw role read, without `#assertOpen`; only call inside a transaction or a public read. */
  #readRole(documentId: string, userId: string): DocumentRole | null {
    const row = this.#statements.selectRole.get(documentId, userId);
    if (row === undefined) return null;
    const role = row['role'];
    return isDocumentRole(role) ? role : null;
  }

  #readRowsForDocument(documentId: string): readonly MembershipRow[] {
    const rows: MembershipRow[] = [];
    for (const raw of this.#statements.selectByDocument.all(documentId)) {
      const storedDocumentId = raw['document_id'];
      const userId = raw['user_id'];
      const role = raw['role'];
      if (typeof storedDocumentId !== 'string' || typeof userId !== 'string') continue;
      if (!isDocumentRole(role)) continue;
      rows.push({ documentId: storedDocumentId, userId, role });
    }
    return rows;
  }

  /**
   * The actor must be the document's Owner, decided inside the write transaction.
   *
   * `not_found` for "no membership" is the non-disclosure branch the HTTP layer also produces; a
   * membership that is not Owner is `forbidden`. Reading the row here (rather than trusting the
   * caller) is what makes a revocation that lands while a request is in flight effective.
   */
  #assertOwner(documentId: string, actorUserId: string): void {
    const role = this.#readRole(documentId, actorUserId);
    if (role === null) throw new MembershipWriteError('not_found');
    if (role !== 'owner') throw new MembershipWriteError('forbidden');
  }

  /** Exactly one `owner` row for the document. Called after every mutation, inside its transaction. */
  #assertSingleOwner(documentId: string): void {
    const total = this.#readCount(this.#statements.countOwners.get(documentId));
    if (total !== 1) throw new MembershipWriteError('invariant_violation');
  }

  #readOwnerId(documentId: string): string | null {
    const row = this.#statements.selectOwnerId.get(documentId);
    const userId = row?.['user_id'];
    return typeof userId === 'string' ? userId : null;
  }

  #readCount(row: Record<string, unknown> | undefined): number {
    const total = row?.['total'];
    if (typeof total === 'number') return total;
    if (typeof total === 'bigint') return Number(total);
    return 0;
  }
}

/** Open the membership store, verifying the SQLite runtime first. */
export async function openMembershipStore(dataPath: string): Promise<SqliteMembershipStore> {
  const sqlite = await loadSqliteModule();
  return SqliteMembershipStore.open(sqlite, dataPath);
}
