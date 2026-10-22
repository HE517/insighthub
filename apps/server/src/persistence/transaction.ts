/**
 * One SQLite write transaction with a guaranteed rollback — the primitive shared by the
 * mutation pipeline (`append`, `compact`, `delete`) and schema setup/migration.
 *
 * `BEGIN IMMEDIATE` (rather than the default deferred) takes the write lock up front, so a
 * read taken inside the body (e.g. `MAX(seq)`) cannot be invalidated by a writer that
 * acquires the lock in between.
 *
 * `body` is synchronous on purpose: `DatabaseSync` is, and an `await` inside
 * `BEGIN IMMEDIATE … COMMIT` would let another task run while this connection holds the
 * write lock.
 */
import type { SqliteModule } from './sqlite-runtime.js';

type Db = InstanceType<SqliteModule['DatabaseSync']>;

export function runInTransaction<T>(db: Db, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction may already be gone (e.g. SQLite rolled it back itself); the
      // original error is the one worth reporting.
    }
    throw error;
  }
}
