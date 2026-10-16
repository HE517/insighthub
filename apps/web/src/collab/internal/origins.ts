import { TRANSACTION_ORIGINS, type TransactionOrigin } from '@insighthub/shared';

/**
 * Transaction origins used inside `apps/web/src/collab/**` (A1 private).
 *
 * `docs/CONTRACTS.md` §6.5 freezes the vocabulary; this module only re-exports it
 * under names that read well at each call site, so a local edit is never stamped
 * with a hand-written string literal that could drift from the frozen set.
 *
 * Why the origin matters (frozen rules R12/R13):
 *
 * - `Y.UndoManager` is constructed with `trackedOrigins: UNDO_TRACKED_ORIGINS`
 *   (`local`, `ai`). A remote update stamped `remote` can therefore never be
 *   reverted by a local undo.
 * - The IndexedDB provider does its own bookkeeping with its own origin, and
 *   `persistence` marks the replay of already-persisted updates at startup, which
 *   must not be re-broadcast as if the user had just typed them.
 */
export const LOCAL_ORIGIN: TransactionOrigin = TRANSACTION_ORIGINS.local;
export const REMOTE_ORIGIN: TransactionOrigin = TRANSACTION_ORIGINS.remote;
export const PERSISTENCE_ORIGIN: TransactionOrigin = TRANSACTION_ORIGINS.persistence;
export const AI_ORIGIN: TransactionOrigin = TRANSACTION_ORIGINS.ai;

/** The undo-tracked subset, taken from shared so it can never be re-declared locally. */
export { UNDO_TRACKED_ORIGINS } from '@insighthub/shared';
