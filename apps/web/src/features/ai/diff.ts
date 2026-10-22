/**
 * Dependency-free unified diff, computed line by line with an LCS.
 *
 * ## Why not a library
 *
 * `docs/DECISIONS.md` D-075 §4 freezes M3 round 1 as "no new runtime dependency" and `AGENTS.md`
 * R3 requires Supervisor approval for one. A diff is also a *display* concern for the Diff
 * Preview: the authority for what gets applied is the `AiEditOperation[]` plus its anchors
 * (`docs/CONTRACTS.md` §11.1), never this text. So the smallest honest implementation wins.
 *
 * ## What it produces
 *
 * A standard unified diff (`---` / `+++` headers, `@@ -a,b +c,d @@` hunks, 3 lines of context
 * by default). Two properties are load-bearing:
 *
 * - **Pure and deterministic**: the same two strings always produce the same text. No clock, no
 *   locale, no environment.
 * - **Display-only**: nothing here decides what an accepted suggestion does. `applySuggestion`
 *   in `apply.ts` re-derives every index from the anchors.
 *
 * ## Line model (deliberate simplifications, all display-side)
 *
 * - Lines are split on `\n`; `\r\n` and a lone `\r` are normalised to `\n`.
 * - A trailing newline terminates the last line, so `"a\n"` is one line, not two.
 * - The `\ No newline at end of file` marker is not emitted. A preview that ends a line is
 *   already unambiguous, and omitting the marker keeps a missing final newline from looking like
 *   a content change.
 * - If the changed middle of two very large documents would exceed {@link MAX_LCS_CELLS} table
 *   cells, the middle is emitted as one delete-all/insert-all hunk instead of an LCS. That is
 *   still a correct description of the transformation; it is simply not minimal.
 */

/** Lines of unchanged context kept around each change (the usual `git diff` default). */
export const DEFAULT_CONTEXT_LINES = 3;

/**
 * Upper bound on `middleBefore.length * middleAfter.length` LCS cells. ~2M cells is a few MB of
 * `Uint32Array`; beyond that the fallback hunk is preferable to a multi-hundred-MB allocation on
 * a UI thread.
 */
const MAX_LCS_CELLS = 2_000_000;

export interface UnifiedDiffOptions {
  /** Unchanged lines kept before/after each change. Defaults to {@link DEFAULT_CONTEXT_LINES}. */
  context?: number;
  /** Header label for the "before" side. Defaults to `original`. */
  beforeLabel?: string;
  /** Header label for the "after" side. Defaults to `proposed`. */
  afterLabel?: string;
}

type ScriptKind = 'equal' | 'delete' | 'insert';

interface ScriptEntry {
  kind: ScriptKind;
  text: string;
  /** How many "before" lines were consumed *before* this entry (0-based). */
  beforeLine: number;
  /** How many "after" lines were consumed *before* this entry (0-based). */
  afterLine: number;
}

/**
 * The unified diff turning `before` into `after`.
 *
 * Returns `''` when the two strings are identical after line normalisation (an empty diff means
 * "no visible change"), so a caller never renders an empty hunk header.
 */
export function unifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (sameLines(beforeLines, afterLines)) return '';

  const context = normaliseContext(options.context);
  const script = lineScript(beforeLines, afterLines);
  const hunks = groupHunks(script, context);
  if (hunks.length === 0) return '';

  const beforeLabel = options.beforeLabel ?? 'original';
  const afterLabel = options.afterLabel ?? 'proposed';

  const out: string[] = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  for (const hunk of hunks) {
    out.push(formatHunkHeader(script, hunk));
    for (let index = hunk.start; index < hunk.end; index += 1) {
      out.push(`${diffPrefix(script[index].kind)}${script[index].text}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/* ---------------------------------------------------------------------- *
 * Line splitting
 * ---------------------------------------------------------------------- */

/** Split text into lines, normalising CRLF/CR and dropping the terminator of the last line. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  // "a\n" is one line ("a"), terminated by a newline — not two lines.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function normaliseContext(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONTEXT_LINES;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_CONTEXT_LINES;
  return Math.floor(value);
}

/* ---------------------------------------------------------------------- *
 * LCS
 * ---------------------------------------------------------------------- */

/**
 * Build the edit script for the two documents.
 *
 * Common prefix and suffix are stripped first: they are the overwhelming majority of a small
 * edit, and stripping them keeps the DP table proportional to the changed middle rather than to
 * the whole document.
 */
function lineScript(before: readonly string[], after: readonly string[]): ScriptEntry[] {
  const script: ScriptEntry[] = [];
  let beforeLine = 0;
  let afterLine = 0;

  const push = (kind: ScriptKind, text: string): void => {
    script.push({ kind, text, beforeLine, afterLine });
    if (kind !== 'insert') beforeLine += 1;
    if (kind !== 'delete') afterLine += 1;
  };

  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  for (let index = 0; index < prefix; index += 1) push('equal', before[index]);

  const middleBefore = before.slice(prefix, before.length - suffix);
  const middleAfter = after.slice(prefix, after.length - suffix);
  for (const op of lcsOperations(middleBefore, middleAfter)) push(op.kind, op.text);

  for (let index = before.length - suffix; index < before.length; index += 1) {
    push('equal', before[index]);
  }

  return script;
}

/**
 * LCS edit script for the changed middle.
 *
 * Ties resolve to "delete before insert", which makes the output stable for a given pair of
 * inputs (a different tie-break would produce a different but equally valid diff).
 */
function lcsOperations(
  before: readonly string[],
  after: readonly string[],
): Array<{ kind: ScriptKind; text: string }> {
  const n = before.length;
  const m = after.length;
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    // Fallback: the whole middle is replaced. Correct, just not minimal (see module doc).
    return [
      ...before.map((text) => ({ kind: 'delete' as const, text })),
      ...after.map((text) => ({ kind: 'insert' as const, text })),
    ];
  }

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number): number => i * width + j;

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        before[i] === after[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const operations: Array<{ kind: ScriptKind; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      operations.push({ kind: 'equal', text: before[i] });
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      operations.push({ kind: 'delete', text: before[i] });
      i += 1;
    } else {
      operations.push({ kind: 'insert', text: after[j] });
      j += 1;
    }
  }
  while (i < n) {
    operations.push({ kind: 'delete', text: before[i] });
    i += 1;
  }
  while (j < m) {
    operations.push({ kind: 'insert', text: after[j] });
    j += 1;
  }
  return operations;
}

/* ---------------------------------------------------------------------- *
 * Hunks
 * ---------------------------------------------------------------------- */

interface Hunk {
  /** Inclusive start index into the script. */
  start: number;
  /** Exclusive end index into the script. */
  end: number;
}

/** Merge change runs whose context windows touch, so one change does not produce two hunks. */
function groupHunks(script: readonly ScriptEntry[], context: number): Hunk[] {
  const changeIndexes: number[] = [];
  for (let index = 0; index < script.length; index += 1) {
    if (script[index].kind !== 'equal') changeIndexes.push(index);
  }
  if (changeIndexes.length === 0) return [];

  const hunks: Hunk[] = [];
  let start = Math.max(0, changeIndexes[0] - context);
  let end = Math.min(script.length, changeIndexes[0] + 1 + context);

  for (const changeIndex of changeIndexes.slice(1)) {
    const candidateStart = Math.max(0, changeIndex - context);
    const candidateEnd = Math.min(script.length, changeIndex + 1 + context);
    if (candidateStart <= end) {
      end = Math.max(end, candidateEnd);
    } else {
      hunks.push({ start, end });
      start = candidateStart;
      end = candidateEnd;
    }
  }
  hunks.push({ start, end });
  return hunks;
}

function formatHunkHeader(script: readonly ScriptEntry[], hunk: Hunk): string {
  let beforeCount = 0;
  let afterCount = 0;
  // The script entry carries how many lines of each side were consumed before it, so the hunk's
  // first line number is derived rather than tracked in a second parallel counter.
  const beforeConsumed = script[hunk.start].beforeLine;
  const afterConsumed = script[hunk.start].afterLine;

  for (let index = hunk.start; index < hunk.end; index += 1) {
    const kind = script[index].kind;
    if (kind !== 'insert') beforeCount += 1;
    if (kind !== 'delete') afterCount += 1;
  }

  // Unified-diff convention: a zero-length side names the line *before* the insertion point.
  const beforeStart = beforeCount === 0 ? beforeConsumed : beforeConsumed + 1;
  const afterStart = afterCount === 0 ? afterConsumed : afterConsumed + 1;

  return `@@ -${formatRange(beforeStart, beforeCount)} +${formatRange(afterStart, afterCount)} @@`;
}

function formatRange(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function diffPrefix(kind: ScriptKind): string {
  if (kind === 'delete') return '-';
  if (kind === 'insert') return '+';
  return ' ';
}
