import type { AiEditSuggestion } from '@insighthub/shared';

import {
  buildSuggestion,
  throwIfAborted,
  type AiOperationDraft,
  type AiProvider,
  type AiSuggestInput,
} from './provider.js';

/**
 * The **deterministic local provider** (M3 round 1).
 *
 * ## What this is — and what it is not
 *
 * It is a small, explicit **instruction → intent** table plus plain string operations. It is
 * **not** a language model and it is not "AI wired up": `docs/DECISIONS.md` D-075 §4 froze this
 * round as client-side only, with no network, no credentials and no new dependency. The value it
 * delivers is the pipeline: a real proposal with real anchors, a real unified diff, and a real
 * apply/undo path for the Diff Preview to consume. Replacing it with a model integration is a
 * separate owner decision and only requires another `AiProvider`.
 *
 * Nothing here sends a request, reads a file or touches a document. Every output is a function of
 * the input.
 *
 * ## The intent table (authoritative; tests pin every row)
 *
 * | instruction (case-insensitive, trimmed) | target | operations produced |
 * | --- | --- | --- |
 * | `uppercase` | selection, else whole document | one `replace` (`length > 0`) |
 * | `trim-trailing-space` | selection, else whole document | one `replace` (`length > 0`, `text: ""`) per line with trailing whitespace |
 * | `add-todo` | lines starting inside the selection, else whole document | one `insert` (`"- [ ] "`) per non-blank, not-already-a-task line |
 * | `replace-selection: <text>` | the selection (required, non-empty) | one `replace` (`length > 0`) |
 * | `delete-selection` | the selection (required, non-empty) | one `replace` with `text: ""` |
 *
 * Everything else throws {@link LocalProviderError} with `kind: 'unknown-instruction'`: an
 * unrecognized instruction must never be turned into a made-up suggestion.
 *
 * A selection with `from === to` is treated as **no selection** (the whole document) for the
 * region intents; the two selection-only intents reject it instead of silently editing the whole
 * document. The `replace-selection` payload has one optional space after `:` stripped, so
 * `replace-selection: x` and `replace-selection:x` mean the same thing.
 *
 * ## Why it is deterministic
 *
 * 1. The intent is a total, literal string match — no fuzzy matching, no heuristics.
 * 2. Every operation is derived from `input.text` by pure string arithmetic; operations are
 *    emitted in ascending index order, so the same input yields the same list.
 * 3. Anchors come from `createOperationAnchor` against the **same** live `Y.Text`, so the encoded
 *    `RelativePosition` JSON is identical across calls for one document.
 * 4. The id is an FNV-1a hash of the request (`deterministicSuggestionId`), not a random UUID.
 * 5. `createdAt` is the only wall-clock value, and the clock is injectable: with a fixed clock the
 *    **entire** suggestion object is reproducible (pinned by `provider.test.ts`).
 *
 * A "no change" result is an error (`kind: 'no-change'`), not an empty suggestion: the shared
 * schema requires at least one operation, and a diff that changes nothing is not a proposal.
 */

/** Intent identifiers. Exported so a UI can render help/autocomplete from one source. */
export const LOCAL_INTENTS = [
  'uppercase',
  'trim-trailing-space',
  'add-todo',
  'replace-selection',
  'delete-selection',
] as const;

export type LocalIntent = (typeof LOCAL_INTENTS)[number];

/** The literal prefix `add-todo` inserts. */
export const TODO_PREFIX = '- [ ] ';

export type LocalProviderFailure =
  | 'unknown-instruction'
  | 'invalid-instruction'
  | 'selection-required'
  | 'invalid-selection'
  | 'no-change';

/**
 * An instruction the local provider cannot fulfil.
 *
 * Thrown (not returned): an unknown or no-op instruction is a caller/UX condition with no
 * sensible fallback, and inventing a suggestion would be the dishonest alternative. `kind` is
 * stable so A2 can map it to a message without string matching.
 */
export class LocalProviderError extends Error {
  readonly kind: LocalProviderFailure;

  constructor(kind: LocalProviderFailure, message: string) {
    super(message);
    this.name = 'LocalProviderError';
    this.kind = kind;
  }
}

export interface LocalProviderOptions {
  /**
   * Clock for `createdAt`.
   *
   * Defaults to the real wall clock (a proposal should carry the time it was proposed). A test or
   * a replay harness injects a fixed clock to make the whole suggestion byte-for-byte
   * reproducible.
   */
  now?: () => Date;
}

/** Create the default provider. Safe to call once per app; it holds no state. */
export function createLocalProvider(options: LocalProviderOptions = {}): AiProvider {
  const now = options.now ?? ((): Date => new Date());

  return {
    async suggest(input: AiSuggestInput): Promise<AiEditSuggestion> {
      throwIfAborted(input.signal);

      const { intent, payload } = parseLocalInstruction(input.instruction);
      const drafts = draftsFor(intent, payload, input);

      // An abort that lands while we were computing must not produce a proposal the caller has
      // already dismissed (R9).
      throwIfAborted(input.signal);

      return buildSuggestion({
        input,
        summary: summaryFor(intent, drafts, explicitSelection(input) !== undefined),
        drafts,
        now: now(),
        idPrefix: 'local',
      });
    },
  };
}

/**
 * Parse an instruction into an intent plus optional payload, or throw.
 *
 * Exported for tests and for a UI that wants to explain what it accepts; `LOCAL_INTENTS` is the
 * same table in list form.
 */
export function parseLocalInstruction(instruction: string): {
  intent: LocalIntent;
  payload?: string;
} {
  const trimmed = instruction.trim();
  if (trimmed === '') {
    throw new LocalProviderError('invalid-instruction', 'The instruction is empty.');
  }

  const normalized = trimmed.toLowerCase();

  if (normalized === 'uppercase') return { intent: 'uppercase' };
  if (normalized === 'trim-trailing-space') return { intent: 'trim-trailing-space' };
  if (normalized === 'add-todo') return { intent: 'add-todo' };
  if (normalized === 'delete-selection') return { intent: 'delete-selection' };

  if (normalized === 'replace-selection' || normalized.startsWith('replace-selection:')) {
    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      throw new LocalProviderError(
        'invalid-instruction',
        'replace-selection needs replacement text, e.g. "replace-selection: new wording".',
      );
    }
    const payload = trimmed.slice(separator + 1).replace(/^ /, '');
    if (payload === '') {
      throw new LocalProviderError(
        'invalid-instruction',
        'replace-selection needs non-empty replacement text after ":".',
      );
    }
    return { intent: 'replace-selection', payload };
  }

  throw new LocalProviderError(
    'unknown-instruction',
    `Unknown instruction "${trimmed.slice(0, 80)}". Supported: ${LOCAL_INTENTS.join(', ')} ` +
      '(replace-selection takes a "<text>" payload after ":").',
  );
}

/* ---------------------------------------------------------------------- *
 * Draft construction
 * ---------------------------------------------------------------------- */

function draftsFor(
  intent: LocalIntent,
  payload: string | undefined,
  input: AiSuggestInput,
): AiOperationDraft[] {
  switch (intent) {
    case 'uppercase':
      return uppercaseDrafts(input);
    case 'trim-trailing-space':
      return trimTrailingSpaceDrafts(input);
    case 'add-todo':
      return addTodoDrafts(input);
    case 'replace-selection':
      return replaceSelectionDrafts(input, payload ?? '');
    case 'delete-selection':
      return replaceSelectionDrafts(input, '');
  }
}

function uppercaseDrafts(input: AiSuggestInput): AiOperationDraft[] {
  const { from, to } = regionOf(input);
  if (from === to) throw noChange('The document is empty; there is nothing to uppercase.');

  const source = input.text.slice(from, to);
  const replacement = source.toUpperCase();
  if (replacement === source) {
    throw noChange('The target text is already uppercase; the suggestion would change nothing.');
  }
  return [{ kind: 'replace', index: from, length: source.length, text: replacement }];
}

function trimTrailingSpaceDrafts(input: AiSuggestInput): AiOperationDraft[] {
  const { from, to } = regionOf(input);
  const drafts: AiOperationDraft[] = [];

  for (const line of regionLines(input.text, from, to)) {
    // "Trailing whitespace" means at the end of the *line*, not at the end of the selection. When
    // the selected range stops mid-line, trimming there would edit text the user did not select,
    // so the line is skipped (and reported as `no-change` if nothing else qualifies).
    const newline = input.text.indexOf('\n', line.start);
    const lineEnd = newline === -1 ? input.text.length : newline;
    if (lineEnd > to) continue;

    let contentEnd = line.contentEnd;
    while (contentEnd > line.start && isWhitespace(input.text[contentEnd - 1])) {
      contentEnd -= 1;
    }
    if (contentEnd === line.contentEnd) continue;
    drafts.push({
      kind: 'replace',
      index: contentEnd,
      length: line.contentEnd - contentEnd,
      text: '',
    });
  }

  if (drafts.length === 0) {
    throw noChange('No line in the target range has trailing whitespace.');
  }
  return drafts;
}

function addTodoDrafts(input: AiSuggestInput): AiOperationDraft[] {
  const { from, to } = regionOf(input);
  const drafts: AiOperationDraft[] = [];

  for (const line of regionLines(input.text, from, to)) {
    const content = input.text.slice(line.start, line.contentEnd);
    // Blank lines get no checkbox, and a line that already is a task is left alone so running the
    // instruction twice is a no-op (reported as `no-change`) instead of stacked markers.
    if (content.trim() === '') continue;
    if (content.startsWith(TODO_PREFIX)) continue;
    drafts.push({ kind: 'insert', index: line.start, text: TODO_PREFIX });
  }

  if (drafts.length === 0) {
    throw noChange('No non-blank untagged line in the target range.');
  }
  return drafts;
}

function replaceSelectionDrafts(input: AiSuggestInput, replacement: string): AiOperationDraft[] {
  const selection = explicitSelection(input);
  if (selection === undefined) {
    throw new LocalProviderError(
      'selection-required',
      'This instruction needs a non-empty selection; none was provided.',
    );
  }
  const { from, to } = selection;

  if (input.text.slice(from, to) === replacement) {
    throw noChange('The selection already contains that text.');
  }
  return [{ kind: 'replace', index: from, length: to - from, text: replacement }];
}

/* ---------------------------------------------------------------------- *
 * Ranges
 * ---------------------------------------------------------------------- */

interface Range {
  from: number;
  to: number;
}

/** The instruction's target: the explicit selection, else the whole document. */
function regionOf(input: AiSuggestInput): Range {
  const selection = explicitSelection(input);
  if (selection !== undefined) return selection;
  return { from: 0, to: input.text.length };
}

/**
 * The non-empty selection, or `undefined`.
 *
 * Validates hard: a selection outside `0..text.length` or with `from > to` is a caller bug that
 * would otherwise mint anchors for a range the document does not have.
 */
function explicitSelection(input: AiSuggestInput): Range | undefined {
  const selection = input.selection;
  if (selection === undefined) return undefined;

  const { from, to } = selection;
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to > input.text.length ||
    from > to
  ) {
    throw new LocalProviderError(
      'invalid-selection',
      `Selection ${from}..${to} is outside the document (length ${input.text.length}) or inverted.`,
    );
  }
  return from === to ? undefined : { from, to };
}

interface LineSlice {
  /** Index of the first character of the line. */
  start: number;
  /** Index just past the last non-terminator character (excludes a CRLF's `\r`). */
  contentEnd: number;
}

/**
 * The lines whose content intersects `[from, to)`.
 *
 * A line is attributed to the region by its **start** index, so a selection beginning mid-line
 * does not rewrite the earlier part of that line. `\r` of a CRLF is excluded from `contentEnd` so
 * trimming whitespace never turns CRLF into LF.
 */
function regionLines(text: string, from: number, to: number): LineSlice[] {
  const lines: LineSlice[] = [];
  let start = from;

  while (start < to) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 || newline >= to ? to : newline;
    const contentEnd = end > start && text[end - 1] === '\r' ? end - 1 : end;
    lines.push({ start, contentEnd });
    if (end === to) break;
    start = end + 1;
  }

  return lines;
}

/* ---------------------------------------------------------------------- *
 * Summary + errors
 * ---------------------------------------------------------------------- */

function summaryFor(
  intent: LocalIntent,
  drafts: readonly AiOperationDraft[],
  usedSelection: boolean,
): string {
  switch (intent) {
    case 'uppercase':
      return usedSelection ? 'Uppercase the selection' : 'Uppercase the document';
    case 'trim-trailing-space': {
      const lines = plural(drafts.length, 'line');
      return `Trim trailing whitespace on ${lines}`;
    }
    case 'add-todo': {
      const lines = plural(drafts.length, 'line');
      return `Prefix ${lines} with a task checkbox`;
    }
    case 'replace-selection':
      return 'Replace the selection with the requested text';
    case 'delete-selection':
      return 'Delete the selection';
  }
}

function plural(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\v' || character === '\f';
}

function noChange(message: string): LocalProviderError {
  return new LocalProviderError('no-change', message);
}
