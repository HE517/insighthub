import type * as Y from 'yjs';

import {
  TRANSACTION_ORIGINS,
  validateSuggestionAgainstDocument,
  type AiEditSuggestion,
  type CollaborativeSession,
  type ResolvedRange,
  type ValidationFailureReason,
} from '@insighthub/shared';

/**
 * Applying an accepted suggestion — the only write path in the AI feature.
 *
 * ## The rule
 *
 * An `AiEditSuggestion` is a proposal until the user accepts it. Accepting applies it as one
 * **Yjs transaction** stamped `TRANSACTION_ORIGINS.ai` (`docs/ARCHITECTURE.md` §3, R8/R13), so:
 *
 * - other clients receive it as an ordinary CRDT edit;
 * - IndexedDB persists it;
 * - a local undo can take it back (`UNDO_TRACKED_ORIGINS` contains `ai`), while remote edits stay
 *   untouched.
 *
 * This module never touches Redux, React state, awareness or the `CollaborativeSession` seam. It
 * takes the narrowest possible port (`doc` + `transact`) so it is testable against a real
 * `Y.Doc` with a three-line port, and so it cannot accidentally grow a UI dependency.
 *
 * ## Validation is not optional
 *
 * `validateSuggestionAgainstDocument` (`docs/CONTRACTS.md` §11.1) runs **before** any write and
 * its three checks run in a fixed order: revision → anchor resolution → exact `expectedText`.
 * A failure is returned verbatim and **nothing** is applied — there is no partial application.
 *
 * ## Why descending order
 *
 * `AiEditOperation.index` / `length` are coordinates in the document the suggestion was generated
 * from, but the applied operations mutate that document as they run. Applying ascending would
 * shift every later range by the length delta of the earlier ones. Applying from the highest
 * index down means an edit can never move a range that has not been applied yet. For equal
 * indexes the **later-listed** operation is applied first, so the listed order is preserved in the
 * resulting text (`[A, B]` at one index yields `AB`).
 *
 * Ranges are the **resolved anchor** ranges, not the suggestion's `index`/`length`: those remain
 * in the shape for rendering only.
 */

export type ApplyResult =
  { ok: true; applied: number } | { ok: false; reason: ValidationFailureReason };

/**
 * The narrow port `applySuggestion` needs.
 *
 * Structural on purpose: the real `CollaborativeSession` satisfies it, and so does a test double
 * that wraps a real `Y.Doc` — no mock of Yjs is involved.
 *
 * `documentId` is part of the port because a proposal is **bound to one document**: an
 * `insert` at the end of a document (or any insert into an empty one) anchors at a *type-level*
 * position whose `expectedText` is `''`, so it can resolve against a different document and pass
 * all three text checks. Comparing the id here refuses that at the write path instead of relying
 * on the UI only ever passing the matching document.
 */
export type AiApplyPort = Pick<CollaborativeSession, 'doc' | 'transact' | 'documentId'>;

interface PlannedOperation {
  operation: AiEditSuggestion['operations'][number];
  range: ResolvedRange;
  /** Position in `suggestion.operations`; only used to break equal-index ties deterministically. */
  order: number;
}

/**
 * Validate and apply a suggestion.
 *
 * Returns `{ ok: false, reason }` for all four contract failures, with the document byte-for-byte
 * unchanged:
 *
 * | reason | returned by |
 * | --- | --- |
 * | `revision` | check 1, `baseRevision !== currentRevision` |
 * | `anchor-unresolved` | check 2, an anchor does not resolve against this `Y.Text` |
 * | `text-mismatch` | check 3, the resolved text is not the reviewed `expectedText` |
 * | `malformed` | the anchor/operation shape is unusable, or two operations address overlapping ranges |
 *
 * The overlap case is not reachable from a provider that anchors each draft independently, but it
 * is reachable by hand-crafting operations. It is rejected as `malformed` instead of applied
 * because overlapping ranges cannot be applied atomically — the second write would land inside
 * text the first just replaced.
 *
 * Throws only if `port.transact` itself throws; that is a broken port, not a stale suggestion.
 */
export function applySuggestion(
  port: AiApplyPort,
  suggestion: AiEditSuggestion,
  currentRevision: number,
): ApplyResult {
  // A proposal belongs to the document it was generated for (see `AiApplyPort.documentId`).
  // `malformed` is the honest reason: the request itself is inconsistent, not stale.
  if (suggestion.documentId !== port.documentId) return { ok: false, reason: 'malformed' };

  const validation = validateSuggestionAgainstDocument(suggestion, port.doc, currentRevision);
  if (!validation.ok) return { ok: false, reason: validation.reason };

  const planned: PlannedOperation[] = suggestion.operations.map((operation, order) => ({
    operation,
    range: validation.ranges[order],
    order,
  }));

  for (let left = 0; left < planned.length; left += 1) {
    for (let right = left + 1; right < planned.length; right += 1) {
      if (rangesConflict(planned[left].range, planned[right].range)) {
        return { ok: false, reason: 'malformed' };
      }
    }
  }

  const ordered = [...planned].sort(
    (left, right) => right.range.index - left.range.index || right.order - left.order,
  );

  // One transaction for the whole suggestion: all operations land together or, if Yjs throws
  // mid-way, the transaction is still a single unit of history for undo.
  port.transact((text: Y.Text) => {
    for (const { operation, range } of ordered) {
      if (operation.kind === 'replace') {
        text.delete(range.index, range.length);
        if (operation.text !== '') text.insert(range.index, operation.text);
      } else {
        text.insert(range.index, operation.text);
      }
    }
  }, TRANSACTION_ORIGINS.ai);

  return { ok: true, applied: ordered.length };
}

/**
 * Whether two resolved ranges cannot be executed independently in the original coordinates.
 *
 * Two inserts at one index **do not** conflict: the tie-break makes their order deterministic.
 * Everything else does. In particular an insert exactly at a replaced range's **start** is
 * rejected: applying the insert first moves the replaced range, applying the replace first
 * swallows the inserted text, so the two orders produce different documents — a suggestion that
 * cannot be applied unambiguously is malformed, not "best effort". An insert at the range's
 * exclusive end is fine and is not reported.
 */
function rangesConflict(left: ResolvedRange, right: ResolvedRange): boolean {
  if (left.length === 0 && right.length === 0) return false;

  const leftEnd = left.index + left.length;
  const rightEnd = right.index + right.length;

  if (left.length === 0) return left.index >= right.index && left.index < rightEnd;
  if (right.length === 0) return right.index >= left.index && right.index < leftEnd;

  return left.index < rightEnd && right.index < leftEnd;
}
