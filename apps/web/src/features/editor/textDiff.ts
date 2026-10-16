/**
 * Minimal single-range text diff used by the Y.Text ↔ editor binding.
 *
 * ## Why a diff at all
 *
 * Local editor changes are shipped to `Y.Text` as deltas (cheap, no diff). The
 * reverse direction normally arrives as a delta too, but two cases have no delta:
 *
 * 1. the editor attaches to a document that already has content (persisted or
 *    remote) — the binding needs the change that turns an empty buffer into it;
 * 2. a fallback full resync after a divergence.
 *
 * In both cases the correct change is the *smallest* replacement that turns
 * `before` into `after`. Diffing the whole body into a full-document replace
 * would throw away the editor's own selection/undo/history mapping and would be
 * O(document) even when one character changed.
 *
 * ## What this deliberately is not
 *
 * This is **not** a general-purpose diff. It computes exactly one replaced range
 * (common prefix + common suffix), which is all either case needs, and it never
 * tries to find the "prettiest" edit script. A Myers diff would return a smaller
 * edit script for moved text but costs far more on the hot path for no benefit
 * here.
 *
 * Offsets are UTF-16 code units, matching both `Y.Text.length` and CodeMirror's
 * `Text.length`, so no unit conversion is needed anywhere.
 */

export interface TextChange {
  /** UTF-16 offset where the replaced range starts. */
  from: number;
  /** UTF-16 offset just past the replaced range. */
  to: number;
  /** Replacement text: `''` means a pure deletion. */
  insert: string;
}

/**
 * The single-range change turning `before` into `after`.
 *
 * Returns `null` when the strings are identical, so callers can skip an empty
 * transaction instead of dispatching a no-op.
 */
export function singleRangeChange(before: string, after: string): TextChange | null {
  if (before === after) return null;

  const beforeLength = before.length;
  const afterLength = after.length;
  const shortest = Math.min(beforeLength, afterLength);

  let start = 0;
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) {
    start += 1;
  }

  // The suffix must not overlap the prefix already consumed, otherwise a change
  // like 'ab' -> 'aab' would produce a negative-length replaced range.
  let suffix = 0;
  while (
    suffix < shortest - start &&
    before.charCodeAt(beforeLength - 1 - suffix) === after.charCodeAt(afterLength - 1 - suffix)
  ) {
    suffix += 1;
  }

  return {
    from: start,
    to: beforeLength - suffix,
    insert: after.slice(start, afterLength - suffix),
  };
}
