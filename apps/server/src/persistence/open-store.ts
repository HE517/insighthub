/**
 * The one place the server turns a `INSIGHTHUB_DATA_PATH` into an open, capability-checked
 * `DocumentStore`.
 *
 * Both entry points use it — `apps/server/src/index.ts` at startup and the integration
 * test harness per suite — so "what does starting with durable storage mean" has exactly
 * one implementation. The order is deliberate and is the whole point of the function:
 *
 * ```text
 * load node:sqlite  →  capability probe  →  open the real database
 * ```
 *
 * A failure at any step throws `SqliteCapabilityError`, and `index.ts` turns that into a
 * startup failure **before** the server listens (`docs/DECISIONS.md` D-051). There is no
 * branch here that returns a memory-only store: that mode is exactly the M1 data-loss
 * behaviour this task removes.
 */
import {
  SqliteCapabilityError,
  assertSqliteCapability,
  isSqliteCapabilityError,
  loadSqliteModule,
} from './sqlite-runtime.js';
import { SqliteDocumentStore } from './sqlite-store.js';
import type { DocumentStore } from './types.js';

export interface OpenedDocumentStore {
  readonly store: DocumentStore;
  /** Directory that actually holds the database file. */
  readonly dataPath: string;
  /** Accepted SQLite journal mode; `wal` when the probe passed. */
  readonly journalMode: string;
}

/**
 * Open the durable store, verifying the runtime first.
 *
 * Async only because the `node:sqlite` import is dynamic (see `sqlite-runtime.ts`): a
 * static import of a missing built-in would throw during ESM evaluation, before any of
 * this could produce a diagnostic.
 */
export async function openDocumentStore(dataPath: string): Promise<OpenedDocumentStore> {
  const sqlite = await loadSqliteModule();
  const report = assertSqliteCapability(sqlite, dataPath);

  let store: DocumentStore;
  try {
    store = SqliteDocumentStore.open(sqlite, dataPath);
  } catch (error) {
    if (isSqliteCapabilityError(error)) throw error;
    // The capability probe proved the *runtime* is fine, so a failure here is about the data
    // itself — a corrupt or unreadable database file. It still has to be a startup failure
    // with a diagnostic rather than a stack trace, and it must never be converted into "start
    // empty" (`docs/DECISIONS.md` D-051, D-043 point 6).
    throw new SqliteCapabilityError(
      'STORE_OPEN_FAILED',
      `the durable database could not be opened in ${dataPath}`,
      'The runtime passed its capability check, so the file itself is unusable (corruption, permissions or a foreign file). Move it aside to start with an empty store — do not delete it before checking whether it can be recovered.',
      error,
    );
  }

  return { store, dataPath: report.dataPath, journalMode: report.journalMode };
}
