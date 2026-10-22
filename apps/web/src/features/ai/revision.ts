import type * as Y from 'yjs';

import { TRANSACTION_ORIGINS } from '@insighthub/shared';

/**
 * The client-local revision counter the AI apply path needs — **the one file A2 is allowed to
 * add to A4's directory** (A0-approved named ownership exception; M3 round 1).
 *
 * ## Why this file exists at all
 *
 * `applySuggestion(port, suggestion, currentRevision)` (`./apply.ts`) validates three things before
 * it writes (`docs/CONTRACTS.md` §11.1). Check #1 is `baseRevision === currentRevision`, and
 * `AiEditSuggestion.baseRevision` is just a number: something has to *produce* those two numbers.
 * A4's orchestration layer deliberately does not own time or state — its provider is pure — and
 * nothing in the repository counted revisions yet. So the UI layer supplies the counter.
 *
 * ## Why an origin filter, not "every update"
 *
 * This is the load-bearing part, and the reason the file is not two lines long. §11.1 makes the
 * pair a **client-local** counter that counts *this client's own* document updates:
 *
 * | origin | counted? | why |
 * | --- | --- | --- |
 * | `TRANSACTION_ORIGINS.local` | yes | the user typed — their document moved on, so the proposal's premise is gone |
 * | `TRANSACTION_ORIGINS.ai` | yes | an earlier accepted AI edit is also this client's own edit |
 * | `TRANSACTION_ORIGINS.remote` | **no** | a peer's edit is judged by check #2/#3 (anchor + `expectedText`), never by check #1 |
 * | `TRANSACTION_ORIGINS.persistence` | **no** | the IndexedDB replica replaying history on startup is not a new edit |
 * | anything else | **no** | unknown origins must not be able to make a proposal look stale |
 *
 * Counting every update would make **any** remote edit fail check #1, which breaks the M3
 * acceptance criterion D-075 §6 **D** ("a peer edits outside the region → the suggestion still
 * applies") in the most common case. It also hides the interesting failure behind the wrong reason:
 * a peer deleting the anchored text would report `revision` instead of `text-mismatch`.
 *
 * The reverse mistake — not counting `local` — would apply a proposal whose premise the user
 * themselves destroyed by typing, which is the stale-write the whole anchoring layer exists to
 * prevent.
 *
 * ## Lifetime (and the one thing this counter must not be used for)
 *
 * A tracker is created for one document session and lives as long as the proposal it serves: the
 * Diff Preview panel creates it when it mounts and disposes it when it unmounts. `get()` therefore
 * answers "how many of *my* edits have landed in this `Y.Doc` since the proposal was generated?"
 * It **must not** be persisted, sent over the wire, or compared against a number produced by
 * another tracker — the values are per-tracker and start at `0` (`docs/CONTRACTS.md` §11.1: "a
 * suggestion must not be shared across clients as if its `baseRevision` meant the same thing for
 * everyone").
 *
 * ## Why subscribe instead of reading a Yjs field
 *
 * Yjs has no global revision number. `doc.store` internals are private and unstable, and Yjs
 * transactions do not carry an ordinal. A `doc.on('update')` subscription is the only public hook
 * that every applied update passes through, and it receives the origin — exactly the two pieces of
 * information the filter needs.
 *
 * Note that one `doc.transact(fn, origin)` call emits one `update` event, so one accepted
 * suggestion moves the counter by exactly one. An **undo does not**: `UndoManager.undo()`
 * re-applies the change with the `UndoManager` itself as origin, which is not in
 * `REVISION_COUNTED_ORIGINS`, so the counter stays put. That is fail-closed rather than a
 * gap — the text did change, and the anchor + `expectedText` checks then reject a proposal
 * that no longer matches it (a `text-mismatch`, which is the accurate reason). Do not
 * "fix" this by counting the undo origin: it would report a local `revision` stale for an
 * edit the author did not make either. The counter is monotonic (never decremented):
 * "the document moved on" is the question, not "is the content equal".
 */

/** Origins that count as **this client's own** document updates (`docs/CONTRACTS.md` §11.1). */
export const REVISION_COUNTED_ORIGINS = [
  TRANSACTION_ORIGINS.local,
  TRANSACTION_ORIGINS.ai,
] as const;

/** The counter handed to `applySuggestion` as `currentRevision` and to `AiSuggestInput`. */
export interface LocalRevisionTracker {
  /** Number of local/AI-origin updates applied to the document since this tracker was created. */
  get(): number;
  /**
   * Stop observing the document. Idempotent; `get()` keeps returning the last value (the number
   * is not a live resource, only the subscription is).
   */
  dispose(): void;
}

/**
 * Subscribe to `doc` and count only `local` / `ai` transactions.
 *
 * Usage (the panel's shape, see `features/editor/AiSuggestPanel.tsx`):
 *
 * ```ts
 * const tracker = createLocalRevisionTracker(session.doc);
 * const baseRevision = tracker.get();                       // into AiSuggestInput
 * applySuggestion(session, suggestion, tracker.get());      // at Accept time
 * tracker.dispose();                                        // panel unmount
 * ```
 */
export function createLocalRevisionTracker(doc: Y.Doc): LocalRevisionTracker {
  let revision = 0;

  const onUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (!isCountedOrigin(origin)) return;
    revision += 1;
  };

  doc.on('update', onUpdate);

  return {
    get(): number {
      return revision;
    },
    dispose(): void {
      doc.off('update', onUpdate);
    },
  };
}

/**
 * Whether an update origin belongs to this client.
 *
 * Written as an explicit membership test over `REVISION_COUNTED_ORIGINS` rather than
 * `origin !== remote` so an unknown origin defaults to **not counted**: a new origin added to the
 * shared table later must be opted into revision counting on purpose, not by omission.
 */
function isCountedOrigin(origin: unknown): boolean {
  return (REVISION_COUNTED_ORIGINS as readonly unknown[]).includes(origin);
}
