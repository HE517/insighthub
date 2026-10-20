/**
 * Read and (deliberately) interfere with the server's durable store from outside.
 *
 * The browser suite proves what a user sees; this module proves what is actually on
 * disk. It exists because "the browser shows the right text" is not evidence that
 * the server persisted anything — the client has its own IndexedDB replica, so a
 * page can look perfect while the server's store is empty.
 *
 * Two capabilities, both reached purely through the store's own file:
 *
 * - **inspect / reconstruct** — open `insighthub.db` read-only and rebuild a `Y.Doc`
 *   from `snapshot` + `document_update`, exactly as `DocumentHydrator` would. This
 *   gives the *server-side* truth without asking the server.
 * - **acquireWriteLock** — hold SQLite's write lock so the server's next `append`
 *   fails. That is the only way to make a real persist failure happen without
 *   touching `apps/**`: the store's own `busy_timeout` is 5 s (`persistence/
 *   constants.ts`), after which SQLite reports `SQLITE_BUSY` and the room must go
 *   `UNHEALTHY` (`docs/DECISIONS.md` D-044).
 *
 * Schema (frozen, `docs/ARCHITECTURE.md` §7.4):
 *
 * ```text
 * document        (document_id PK, snapshot BLOB, snapshot_seq INT, updated_at INT)
 * document_update (document_id, seq, update_bytes BLOB, created_at, PK(document_id, seq))
 * ```
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadYjs } from './deps.mjs';

/** File name the store uses inside `INSIGHTHUB_DATA_PATH` (`persistence/sqlite-store.ts`). */
export const DATABASE_FILE_NAME = 'insighthub.db';

export function databaseFilePath(dataPath) {
  return join(dataPath, DATABASE_FILE_NAME);
}

let sqliteModulePromise;
async function loadSqlite() {
  sqliteModulePromise ??= import('node:sqlite');
  return sqliteModulePromise;
}

/**
 * Open one SQLite file from outside the server.
 *
 * The **single** place the harness decides how an external connection is opened and how long
 * its handle lives, so `authz-fixture.mjs` (`authz.db`) and this module (`insighthub.db`)
 * cannot drift into two connection-management conventions.
 *
 * Not `readOnly`: a WAL database that a crashed process left behind has to be recovered on
 * open, and SQLite will not do that read-only. `busy_timeout` is kept short so an inspection
 * can never look like a hang.
 */
export async function openDatabaseFile(file, { busyTimeoutMs = 2_000 } = {}) {
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  return db;
}

async function openInspector(dataPath, { busyTimeoutMs = 2_000 } = {}) {
  return await openDatabaseFile(databaseFilePath(dataPath), { busyTimeoutMs });
}

/** True when the store has ever been created in this directory. */
export function durableStoreExists(dataPath) {
  return dataPath !== null && existsSync(databaseFilePath(dataPath));
}

function readInteger(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function readBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/**
 * Summarise every document in the store.
 *
 * Returns `{ exists, documents: [{ documentId, snapshotBytes, snapshotSequence,
 * updateRows, updateBytes }] }`. A store that has never been written reports
 * `exists: false` rather than throwing, because "nothing was persisted" is itself a
 * result a scenario needs to assert.
 */
export async function inspectDurableStore(dataPath) {
  if (!durableStoreExists(dataPath)) {
    return { exists: false, dataPath, documents: [] };
  }
  const db = await openInspector(dataPath);
  try {
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT d.document_id AS id,
                  LENGTH(d.snapshot) AS snapshot_bytes,
                  d.snapshot_seq AS snapshot_seq,
                  (SELECT COUNT(*) FROM document_update u WHERE u.document_id = d.document_id) AS update_rows,
                  (SELECT COALESCE(SUM(LENGTH(u.update_bytes)), 0) FROM document_update u WHERE u.document_id = d.document_id) AS update_bytes
             FROM document d
            ORDER BY d.document_id ASC`,
        )
        .all();
    } catch {
      // No tables yet: the store was created but nothing was written.
      return { exists: true, dataPath, documents: [] };
    }
    return {
      exists: true,
      dataPath,
      documents: rows.map((row) => ({
        documentId: String(row['id']),
        snapshotBytes: readInteger(row['snapshot_bytes']),
        snapshotSequence: readInteger(row['snapshot_seq']),
        updateRows: readInteger(row['update_rows']),
        updateBytes: readInteger(row['update_bytes']),
      })),
    };
  } finally {
    try {
      db.close();
    } catch {
      /* inspection is best effort */
    }
  }
}

/** One document's row, or `null` when the document has never been stored. */
export async function inspectDocument(dataPath, documentId) {
  const report = await inspectDurableStore(dataPath);
  return report.documents.find((document) => document.documentId === documentId) ?? null;
}

/**
 * Rebuild the server-side `Y.Doc` from `snapshot` + the update log.
 *
 * This mirrors `DocumentHydrator` (`apps/server/src/persistence/hydrator.ts`) on
 * purpose: the assertion is about what the *stored bytes* mean, so it must not go
 * through the server that produced them.
 */
export async function reconstructDurableDocument(dataPath, documentId) {
  const Y = await loadYjs();
  if (!durableStoreExists(dataPath)) {
    return { found: false, doc: null, text: null, updateRows: 0, snapshotSequence: 0 };
  }

  const db = await openInspector(dataPath);
  try {
    let row;
    let rows;
    try {
      row = db
        .prepare('SELECT snapshot, snapshot_seq FROM document WHERE document_id = ?')
        .get(documentId);
      if (row === undefined) {
        return { found: false, doc: null, text: null, updateRows: 0, snapshotSequence: 0 };
      }
      rows = db
        .prepare(
          'SELECT seq, update_bytes FROM document_update WHERE document_id = ? AND seq > ? ORDER BY seq ASC',
        )
        .all(documentId, readInteger(row['snapshot_seq']));
    } catch {
      return { found: false, doc: null, text: null, updateRows: 0, snapshotSequence: 0 };
    }

    const doc = new Y.Doc();
    const remote = 'a6:durable-inspection';
    const snapshot = readBytes(row['snapshot']);
    if (snapshot !== null && snapshot.byteLength > 0) {
      Y.applyUpdate(doc, snapshot, remote);
    }
    for (const updateRow of rows) {
      const bytes = readBytes(updateRow['update_bytes']);
      if (bytes !== null) Y.applyUpdate(doc, bytes, remote);
    }

    const text = doc.getText('content').toString();
    const stateVector = Y.encodeStateVector(doc);
    const stateUpdate = Y.encodeStateAsUpdate(doc);
    return {
      found: true,
      doc,
      text,
      updateRows: rows.length,
      snapshotSequence: readInteger(row['snapshot_seq']),
      // Byte-comparable identity of the CRDT state — the "Y.Doc assertion" the
      // compaction scenario needs next to the rendered text (`M2-P0-1` E).
      stateVectorBase64: Buffer.from(stateVector).toString('base64'),
      stateUpdateLength: stateUpdate.byteLength,
      stateUpdateSha: sha256(stateUpdate),
    };
  } finally {
    try {
      db.close();
    } catch {
      /* best effort */
    }
  }
}

function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * Wait until the store's document satisfies `predicate`.
 *
 * A condition wait, not a fixed sleep: persistence is asynchronous relative to what
 * the browser shows, so a scenario must observe the row rather than assume it.
 */
export async function waitForDurableDocument(
  dataPath,
  documentId,
  predicate,
  { timeoutMs = 20_000, label = 'the document to be persisted', intervalMs = 100 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await inspectDocument(dataPath, documentId);
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label}; last durable row: ` +
          JSON.stringify(last),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Hold SQLite's write lock on the durable store.
 *
 * While this is held, the server's `BEGIN IMMEDIATE` in `append` cannot proceed. Its
 * connection has a 5 s `busy_timeout`, so the append fails with `SQLITE_BUSY` and the
 * room must follow `docs/DECISIONS.md` D-044: `UNHEALTHY`, `INTERNAL_ERROR`, close
 * with 1011, and — the part that matters — the update is **not** broadcast.
 *
 * `BEGIN IMMEDIATE` alone takes the write lock, so no row is written; `release()`
 * rolls back and closes. Nothing is left behind either way.
 */
export async function acquireWriteLock(dataPath, { timeoutMs = 10_000 } = {}) {
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(databaseFilePath(dataPath));
  // No waiting on our side: if the server is mid-write we want to fail loudly here
  // rather than block the scenario.
  db.exec('PRAGMA busy_timeout = 0');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      db.exec('BEGIN IMMEDIATE');
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        throw new Error(`could not acquire the store write lock: ${String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  let released = false;
  return {
    get held() {
      return !released;
    },
    release() {
      if (released) return;
      released = true;
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction may already be gone */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}
