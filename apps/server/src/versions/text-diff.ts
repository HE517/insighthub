/**
 * The **one** text-diff used by version restore (P0-1, `docs/ui/P0-RESTORE-DECISIONS.md`
 * §3.1 step 1; A7 Q5/P1-7).
 *
 * ## Why a diff at all instead of "apply the version's Yjs state"
 *
 * A stored version's `yjs_state` is a *state*, not a delta from the current document. Applying
 * it directly, or computing `encodeStateAsUpdate(versionDoc, stateVector(currentDoc))`, yields
 * an **empty update** whenever the version is an ancestor of the current state: the current
 * document already contains every struct the version has, so nothing is deleted and the
 * restore silently does nothing (A7 Q1-7). Restore must therefore be expressed as a *forward*
 * edit of the current text, computed from text, and only then encoded as a Yjs update against
 * the current state vector.
 *
 * ## Why code points rather than UTF-16 code units
 *
 * `String.prototype.length` counts UTF-16 code units, so a naive prefix/suffix comparison can
 * cut a surrogate pair in half. A lone surrogate is not valid text; it is the defect the
 * experiment found (`docs/ui/VERSION-RESTORE-EXPERIMENT.md`). Splitting at code-point
 * boundaries cannot produce one: the common prefix/suffix are computed over
 * `Array.from(text)`, and only then converted back to a UTF-16 index with `.length` of the
 * joined prefix.
 *
 * ## Known limitation (accepted, not hidden): grapheme clusters
 *
 * The boundary is a **code point**, not a grapheme cluster. A family emoji
 * (`👨‍👩‍👧`, three code points joined by ZWJ) or a flag (`🇨🇳`, two regional indicators) can
 * therefore be deleted or inserted *partially*, and a remote cursor anchored inside the
 * cluster may render oddly for one frame. The final text is still **character-for-character
 * equal** to the target (the edit covers exactly the differing code points), which is the only
 * property restore promises. `Intl.Segmenter` is deliberately not used in V1: it would change
 * collaboration granularity, not correctness, and it is not available in every runtime the
 * server supports.
 */

/** One replacement in a text: delete `deleteLength` UTF-16 units at `index`, insert `insert`. */
export interface TextEdit {
  /** UTF-16 code-unit offset into the current text. Always a code-point boundary. */
  readonly index: number;
  /** Number of UTF-16 code units to delete at `index` (0 for a pure insertion). */
  readonly deleteLength: number;
  /** Text to insert at `index` after the deletion ('' for a pure deletion). */
  readonly insert: string;
}

/**
 * Compute the forward edit that turns `current` into `target`.
 *
 * Returns `[]` when the texts are already equal. Otherwise exactly one edit: the middle span
 * between the longest common code-point prefix and suffix. One edit rather than a minimal diff
 * is deliberate — the restore is a single logical replacement, and a shorter edit script would
 * be harder to reason about while producing the same final text.
 */
export function restoreTextDiff(current: string, target: string): TextEdit[] {
  if (current === target) return [];

  const from = Array.from(current);
  const to = Array.from(target);

  let prefix = 0;
  const maxPrefix = Math.min(from.length, to.length);
  while (prefix < maxPrefix && from[prefix] === to[prefix]) prefix += 1;

  // Never overlap the prefix: a suffix that reached into it would delete text the texts agree on.
  let suffix = 0;
  while (
    suffix < from.length - prefix &&
    suffix < to.length - prefix &&
    from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = from.slice(prefix, from.length - suffix).join('');
  const inserted = to.slice(prefix, to.length - suffix).join('');
  // Convert the code-point offset back to a UTF-16 index. `from.slice(0, prefix)` is exactly the
  // shared prefix, so its `.length` can never land inside a surrogate pair.
  const index = from.slice(0, prefix).join('').length;

  return [{ index, deleteLength: removed.length, insert: inserted }];
}

/**
 * Apply `edits` to `text` in one Yjs transaction.
 *
 * The caller supplies a `transaction` function rather than importing `Y.Doc` here, so this
 * module stays a pure text helper (and stays trivially testable). Edits are applied from the
 * end so an earlier edit cannot shift a later one's index; `restoreTextDiff` returns at most one
 * edit today, but the loop is written for the general case instead of encoding that assumption.
 *
 * Returns `true` when at least one edit actually changed the text.
 */
export function applyTextEdits(
  edits: readonly TextEdit[],
  text: { delete(index: number, length: number): void; insert(index: number, value: string): void },
  transaction: (body: () => void) => void,
): boolean {
  if (edits.length === 0) return false;
  let changed = false;
  transaction(() => {
    for (const edit of [...edits].sort((left, right) => right.index - left.index)) {
      if (edit.deleteLength > 0) {
        text.delete(edit.index, edit.deleteLength);
        changed = true;
      }
      if (edit.insert.length > 0) {
        text.insert(edit.index, edit.insert);
        changed = true;
      }
    }
  });
  return changed;
}
