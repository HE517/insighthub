/**
 * Compaction thresholds — **frozen** by `docs/DECISIONS.md` D-042 and proven by
 * acceptance scenario E.
 *
 * `COMPACTION_UPDATE_THRESHOLD` rows **or** `COMPACTION_LOG_BYTES_THRESHOLD` bytes,
 * whichever is reached first. Both are deterministic constants, not heuristics, so the
 * acceptance test can drive the crossing explicitly instead of hoping a workload lands
 * on it.
 *
 * ## Why these live here and not in the frozen contract
 *
 * They are operational policy, not protocol: no other agent's code can observe them, no
 * wire message carries them, and no `PROTOCOL_VERSION` is affected by changing them.
 * The value of a threshold and the *correctness* of compaction are decoupled — without
 * compaction the data is still correct, only slower to hydrate — which is what makes the
 * policy tunable without a contract change (`docs/DECISIONS.md` D-025 records the same
 * reasoning for the M1 operational limits).
 */

/** Compact once this many update rows have accumulated past the snapshot. */
export const COMPACTION_UPDATE_THRESHOLD = 200;

/**
 * Compact once this many *appended update payload bytes* have accumulated past the
 * snapshot.
 *
 * Deliberately measured as payload bytes, not as SQLite page/row overhead: the payload is
 * the part that grows with editing and the part a caller can reason about. Stating which
 * number is measured keeps the threshold checkable instead of folklore.
 */
export const COMPACTION_LOG_BYTES_THRESHOLD = 1024 * 1024;

/**
 * How long SQLite waits for a competing write lock before reporting `SQLITE_BUSY`.
 *
 * M2 is a single process with one connection, so a busy lock only arises from an
 * external reader (a diagnostic shell holding the WAL). Waiting briefly is friendlier
 * than failing a keystroke's persist, and it is bounded so a stuck lock cannot hang the
 * event loop indefinitely (`DatabaseSync` is synchronous).
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;
