/**
 * Collaborative editor binding: `Y.Text` <-> an editor surface.
 *
 * ## The one rule this file exists to enforce
 *
 * Document content has exactly one source of truth: `Y.Text`. The editor holds a
 * *view* of it, never a second copy. Concretely:
 *
 * - nothing here stores the document text;
 * - nothing here calls `setState` / `dispatch` with the text;
 * - a remote change is applied to the editor inside a guard, and marked as derived
 *   state, so the surface's own change listener cannot report it back as a local
 *   edit.
 *
 * ## Why an explicit binding object instead of a React effect
 *
 * The binding owns an observer on `Y.Text` (an external subscription) and a
 * surface that must be destroyed. If that lived inside a component effect that
 * re-ran on unrelated renders, a collaborator joining, a connection-status flip or
 * a collaborator-list update could rebind, remounting the editor or duplicating
 * the observer - precisely the re-render storm M1-A2 must not have. The binding is
 * therefore created **once per session** and torn down **once per session**; React
 * only decides when that is.
 *
 * ## Feedback loop prevention
 *
 * ```
 * editor -> Y.Text : handleLocalChanges() transacts immediately
 * Y.Text -> editor : observer reconciles inside an `applyingRemote` guard
 * ```
 *
 * Three independent mechanisms close the loop, because one is not enough:
 *
 * 1. **Origin check.** Our own writes are stamped with `localOriginToken`, and the
 *    observer returns early for them. This keeps a local edit from being reapplied
 *    to the editor (which would move the caret and could trip a surface-level
 *    change listener).
 * 2. **Re-entrancy guard.** Every surface mutation performed *because* of `Y.Text`
 *    runs inside a counter, so a nested Yjs transaction cannot be misread as a
 *    fresh remote change.
 * 3. **Derived-change marker** (`REMOTE_SYNC_ORIGIN`). Every transaction the
 *    binding dispatches carries it, so the adapter's update listener can tell "the
 *    editor changed because the truth changed" from "the user typed". Without it,
 *    `session.undo()` would mutate `Y.Text`, the editor would follow, the change
 *    would be misread as local, and the undone text would be reinserted as a new
 *    undo-tracked edit - undo would work once and then never again.
 *
 * Without all three, the loop is: apply remote text -> editor fires its change
 * listener -> binding writes the text back into `Y.Text`. Yjs absorbs an identical
 * re-insert as a no-op most of the time, but not always: content that changed
 * between the two reads is a genuine local edit, it enters undo history, and it
 * can duplicate text. Undo also becomes untrustworthy, because the replayed remote
 * text is now recorded as *our* edit.
 *
 * ## Remote changes are reconciled, not delta-translated
 *
 * See `reconcileFromText` for why the `Y.TextEvent.delta` is deliberately ignored
 * in favour of diffing the authoritative content against what the editor shows.
 *
 * This file is deliberately ASCII-only: it has already been corrupted once by
 * tooling that rewrote it through a non-UTF-8 codepage, and an editor binding is
 * not the place to discover an encoding problem.
 */
import * as Y from 'yjs';

import { TRANSACTION_ORIGINS, type TransactionOrigin } from '@insighthub/shared';

import type { EditorTextSurface } from './editorTextSurface.js';
import { REMOTE_SYNC_ORIGIN } from './syncOrigin.js';
import { singleRangeChange, type TextChange } from './textDiff.js';

/*
 * ## Delivery rule: one editor update, one transaction, immediately
 *
 * `Y.Text` is the document. An edit that has not reached it does not exist: peers
 * never see it, nothing persists it, and a remote update reconciled in the
 * meantime is diffed against content that is missing the user's keystrokes. So a
 * local change is written before `handleLocalChanges` returns - no queue, no
 * threshold, no timer.
 *
 * Batching survives where it is real: CodeMirror reports every change of one
 * update (multi-cursor input, IME commit, paste) in a single call, and those are
 * merged into one Yjs transaction - one update, one network frame. Separate
 * updates are separate transactions, which is also what `Y.UndoManager` expects:
 * its own capture window, not a queue here, decides where an undo step ends.
 */

/** The seam between `Y.Text` and whatever is rendering it. */
export interface CollabTextTarget {
  /** The CRDT text that owns the content. */
  readonly text: Y.Text;
  /** The document the text belongs to (`RelativePosition` resolution needs it). */
  readonly doc: Y.Doc;
  /**
   * Apply a local edit inside a Yjs transaction stamped with the undo-tracked
   * local origin. Passing `session.transact` here is what keeps undo working and
   * what makes the transaction origin recognisable to the observer.
   */
  transact(fn: (text: Y.Text) => void, origin?: TransactionOrigin): void;
}

export interface CollabTextBindingOptions {
  /**
   * Origin used for this binding's own transactions. Defaults to the shared local
   * origin, which is also what `UNDO_TRACKED_ORIGINS` contains, so undo keeps
   * working without a second origin tag.
   */
  origin?: TransactionOrigin;
  /** Diagnostic hook: called when the surface had to be resynced wholesale. */
  onResync?: (reason: string) => void;
}

export interface CollabTextBinding {
  /**
   * Report editor-originated changes. Offsets must be against the document as it
   * was when the editor update began, which is CodeMirror's own convention.
   *
   * The change is in `Y.Text` when this returns.
   */
  handleLocalChanges(changes: readonly TextChange[]): void;
  /**
   * Barrier meaning "everything the surface reported is in `Y.Text`". Kept because
   * teardown and callers use one explicit name for it; delivery is immediate, so
   * there is never anything pending to write.
   */
  flushLocalEdits(): void;
  /**
   * Re-align the surface with `Y.Text`. Used when the editor attaches to a
   * document that already has content, and as the explicit divergence fallback.
   */
  resync(reason?: string): void;
  /** Detach the `Y.Text` observer. Idempotent; the surface is not touched after. */
  destroy(): void;
  readonly destroyed: boolean;
}

export function createCollabTextBinding(
  target: CollabTextTarget,
  surface: EditorTextSurface,
  options: CollabTextBindingOptions = {},
): CollabTextBinding {
  const { text } = target;
  const localOriginToken = options.origin ?? TRANSACTION_ORIGINS.local;

  /**
   * Re-entrancy guard. Counts remote applications in flight rather than holding a
   * boolean, because a Yjs transaction can nest.
   */
  let applyingRemote = 0;

  let destroyed = false;

  const observer = (_event: Y.YTextEvent, transaction: Y.Transaction): void => {
    if (destroyed) return;
    // Mechanism 1: our own write. Reapplying it to the editor would move the
    // caret and could re-trigger the surface's change listener.
    if (transaction.origin === localOriginToken) return;
    // Mechanism 2: a nested update raised while we are already reconciling.
    // Skipping is safe because the reconcile reads the *current* content, so the
    // outer pass already picked up this change.
    if (applyingRemote > 0) return;

    reconcileFromText();
  };

  text.observe(observer);

  /**
   * Write one editor update into `Y.Text`, in exactly one transaction.
   *
   * Offsets in a single call are expressed against the document as it was when the
   * update began, so the merged changes are applied back to front; only then do
   * the earlier offsets stay valid. Nothing can interleave with this work: it is
   * synchronous, and no remote transaction can start mid-call.
   */
  function writeLocalChanges(changes: readonly TextChange[]): void {
    target.transact((target_) => {
      const merged = mergeAdjacentChanges(changes);
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        const change = merged[index]!;
        if (change.to > change.from) {
          target_.delete(change.from, change.to - change.from);
        }
        if (change.insert.length > 0) {
          target_.insert(change.from, change.insert);
        }
      }
    }, localOriginToken);
  }

  /**
   * Report an editor-originated change and put it in `Y.Text` before returning.
   *
   * See the delivery rule at the top of this file. There is deliberately no queue
   * and no threshold: a queue decouples "the editor shows X" from "the document
   * contains X", and the offsets it holds describe a document that a remote update
   * may already have moved.
   */
  const handleLocalChanges = (changes: readonly TextChange[]): void => {
    if (destroyed || changes.length === 0) return;
    writeLocalChanges(changes);
  };

  /**
   * Nothing is ever deferred, so this has nothing to write. It stays part of the
   * interface as the single named barrier teardown uses, so callers do not have to
   * know whether delivery is currently immediate or batched.
   */
  function flushLocalEdits(): void {
    // Intentionally empty: see the delivery rule above.
  }

  /**
   * Bring the editor in line with `Y.Text`.
   *
   * ## Why the delta is ignored
   *
   * The obvious implementation walks `Y.TextEvent.delta` and turns each op into an
   * editor change. Yjs expresses those offsets against the document as it was
   * *before* the transaction, in a mixed old/new coordinate space once a
   * transaction contains more than one operation (a delete followed by an insert
   * reads differently from an insert followed by a delete). Translating that by
   * hand is exactly the class of arithmetic that fails only for the rare
   * multi-operation transaction produced by a paste, a multi-cursor edit or a
   * remote merge - i.e. the case least likely to be covered by manual testing.
   *
   * So the authoritative content is compared with what the editor shows and the
   * minimal single-range change between them is applied. That is unconditionally
   * correct for any delta shape, needs no coordinate reasoning, and still produces
   * exactly **one** editor transaction per update: a one-character remote edit
   * becomes a one-character change, not a document rewrite (`singleRangeChange` on
   * a 5000-character body with one character replaced returns a 1-unit change).
   *
   * The cost is one comparison per remote update. Remote updates arrive at human
   * typing rates, and the comparison is skipped entirely when the surface already
   * holds the text, so the local keystroke path stays untouched.
   */
  function reconcileFromText(): void {
    const authoritative = text.toString();
    if (surface.hasText(authoritative)) return;

    applyingRemote += 1;
    try {
      // An embedded type is never used for the Markdown body. If one appears, the
      // string view and the CRDT structure disagree, so the surface is replaced
      // wholesale rather than patched at offsets computed from `toString()`.
      if (hasNonStringContent(text)) {
        surface.setText(authoritative, REMOTE_SYNC_ORIGIN);
        options.onResync?.('non-string-content');
        return;
      }

      const change = singleRangeChange(surface.getText(), authoritative);
      if (change === null) return;
      surface.applyDelta([change], REMOTE_SYNC_ORIGIN);
    } finally {
      applyingRemote -= 1;
    }
  }

  function resync(reason = 'explicit'): void {
    if (destroyed) return;
    const authoritative = text.toString();
    if (surface.hasText(authoritative)) return;

    applyingRemote += 1;
    try {
      surface.setText(authoritative, REMOTE_SYNC_ORIGIN);
      options.onResync?.(reason);
    } finally {
      applyingRemote -= 1;
    }
  }

  return {
    handleLocalChanges,
    flushLocalEdits,
    resync,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      text.unobserve(observer);
    },
    get destroyed(): boolean {
      return destroyed;
    },
  };
}

/**
 * Whether `Y.Text` contains anything other than a contiguous string: an embedded
 * `Y.Map` / `Y.Array` / `Y.XmlFragment` inserted as a single unit.
 *
 * The Markdown body is plain text, so this should always be `false`. If it ever is
 * not (a hostile or buggy peer), the string view and the CRDT structure disagree
 * and the only safe response is a wholesale resync: an offset-based change computed
 * against `toString()` would corrupt the embedded content.
 */
export function hasNonStringContent(text: Y.Text): boolean {
  let found = false;
  // `toDelta()` is the structural view; a string-only `Y.Text` yields exactly one
  // `{ insert: string }` entry.
  for (const op of text.toDelta() as { insert?: unknown }[]) {
    if (typeof op.insert !== 'string') {
      found = true;
      break;
    }
  }
  return found;
}

/**
 * Merge changes that land on the same offsets into one replacement.
 *
 * CodeMirror reports a multi-character insertion as a single change already, but
 * IME composition and multi-cursor input can emit several - including several at
 * the identical offset, where applying them one by one is order-dependent. Merging
 * collapses those into one unambiguous replacement.
 *
 * Contiguous-but-distinct offsets (0->0 then 1->1, i.e. typing `ab`) are *not*
 * merged: they are already valid against the pre-change document and are applied
 * back to front by `writeLocalChanges`, which is cheaper and does not risk
 * mis-joining two genuinely separate edits.
 */
export function mergeAdjacentChanges(changes: readonly TextChange[]): TextChange[] {
  if (changes.length <= 1) return [...changes];

  const sorted = [...changes].sort((a, b) => a.from - b.from);
  const merged: TextChange[] = [];

  for (const change of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && change.from < last.to) {
      // Genuinely overlapping: extend rather than emit an invalid range.
      merged[merged.length - 1] = {
        from: last.from,
        to: Math.max(last.to, change.to),
        insert: last.insert + change.insert,
      };
      continue;
    }
    if (last !== undefined && change.from === last.from && change.to === last.to) {
      // Two edits of the same replaced range (e.g. delete then insert at one
      // offset): concatenating keeps a deterministic order.
      merged[merged.length - 1] = {
        from: last.from,
        to: last.to,
        insert: last.insert + change.insert,
      };
      continue;
    }
    merged.push({ ...change });
  }

  return merged;
}

/**
 * Resolve a `Y.RelativePosition` to a current offset, or `null` if it points at a
 * deleted position. Kept next to the binding because A4 needs the same primitive
 * for suggestion anchoring in M3 rather than a second implementation.
 */
export function resolveRelativePosition(rpos: Y.RelativePosition, doc: Y.Doc): number | null {
  const absolute = Y.createAbsolutePositionFromRelativePosition(rpos, doc);
  return absolute === null ? null : absolute.index;
}

/**
 * The single change that turns `editorText` into `collabText`. Exposed for the
 * attach path (which needs one change, not a whole-document replace) and tests.
 */
export function pendingEditorChange(editorText: string, collabText: string): TextChange | null {
  return singleRangeChange(editorText, collabText);
}
