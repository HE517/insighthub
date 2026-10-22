import * as Y from 'yjs';

import {
  isSuggestionStale,
  type AiEditOperation,
  type AiEditSuggestion,
  type AiOperationAnchor,
} from './ai-suggestion.js';
import { DOCUMENT_TEXT_KEY } from './binary-frame.js';

/**
 * M3 anchoring + validation helpers (A1).
 *
 * `docs/CONTRACTS.md` §11.1 is the normative spec; `docs/DECISIONS.md` D-075
 * explains why the shape exists. This module is pure: it never mutates a
 * suggestion and never writes to a document. Applying an accepted suggestion is
 * A4's job, inside `session.transact(..., TRANSACTION_ORIGINS.ai)`.
 *
 * ## Why a RelativePosition is not enough
 *
 * Yjs keeps deleted content reachable long enough for a `RelativePosition` to
 * resolve: `Y.createAbsolutePositionFromRelativePosition` does not return
 * `null` merely because the anchored characters were deleted. It returns a
 * neighbouring index instead (the start of the deletion). A suggestion whose
 * range was deleted therefore still has "valid" anchors — resolving them and
 * writing would corrupt unrelated text. `expectedText` is the second half of
 * the guard: resolution answers "where", the exact string compare answers
 * "is this still the text the user reviewed". Both are mandatory.
 *
 * ## Association direction (measured against Yjs 13.6.33, not assumed)
 *
 * `assoc >= 0` associates a position with the character *after* it;
 * `assoc < 0` associates it with the character *before* it. For an anchored
 * range we want text typed exactly at either boundary to stay **outside** the
 * range, otherwise a single inserted character would change the resolved text
 * and stale an otherwise applicable suggestion (`D-075` acceptance D: edits
 * outside the region must not invalidate it).
 *
 * | boundary | assoc | insertion exactly at the boundary |
 * | --- | --- | --- |
 * | start | `0`  | outside the range (start follows the insertion) |
 * | end   | `-1` | outside the range (end stays before the insertion) |
 *
 * The brief for this round suggested `assoc >= 0` for the end. Measured
 * behaviour shows that is inverted: `0` there absorbs trailing text into the
 * range, so `["The quick" …]` becomes `"quickYY"` after a peer types `YY` at
 * the boundary and the suggestion is rejected as stale. `END_ASSOC` below is
 * therefore `-1`; it is the association that actually satisfies the frozen
 * acceptance criterion. The start uses `0`, which is inside the brief's
 * `assoc <= 0` bound.
 */

/** Start association: sticks to the first character of the range. */
const START_ASSOC = 0;

/**
 * End association: sticks to the last character of the replaced range, so an
 * insertion at the exclusive end index is not absorbed. See the module comment.
 */
const END_ASSOC = -1;

/**
 * Encode a Yjs `RelativePosition` as a JSON string.
 *
 * Yjs's `RelativePosition` has no instance `toJSON()` in 13.6.33; the package
 * exports `relativePositionToJSON` / `createRelativePositionFromJSON`, which are
 * the canonical JSON form (`docs/CONTRACTS.md` §11.1 calls it
 * `RelativePosition.toJSON()`). We deliberately use that pair instead of
 * `Y.encodeRelativePosition` (a `Uint8Array` wire encoding): the contract asks
 * for JSON, and one encoding is enough.
 */
export function encodeRelativePosition(position: Y.RelativePosition): string {
  if (position.item == null && position.tname == null && position.type == null) {
    throw new TypeError('encodeRelativePosition: position has no item, tname or type');
  }
  return JSON.stringify(Y.relativePositionToJSON(position));
}

/**
 * Decode an anchor string produced by {@link encodeRelativePosition}.
 *
 * Returns `null` — never throws — when the value is not JSON, is not a JSON
 * object, has no `item` / `tname` / `type` source at all, or carries fields of
 * the wrong type. `createRelativePositionFromJSON` would otherwise
 * build a position that throws inside Yjs when it is resolved (`unexpectedCase`
 * when all three sources are absent), turning malformed input into an
 * exception at the worst possible moment.
 */
export function decodeRelativePosition(encoded: string): Y.RelativePosition | null {
  if (typeof encoded !== 'string' || encoded.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const hasItem = parsed.item !== undefined && parsed.item !== null;
  const hasTname = parsed.tname !== undefined && parsed.tname !== null;
  const hasType = parsed.type !== undefined && parsed.type !== null;

  // Yjs's canonical JSON carries `item` plus the containing type (`tname` for a
  // root text like "content", `type` for a nested one), so more than one source
  // is normal. What is not usable is *no* source: `{}` would otherwise make
  // Yjs throw `unexpectedCase` when the position is resolved.
  if (!hasItem && !hasTname && !hasType) return null;

  if (hasItem && !isId(parsed.item)) return null;
  if (hasType && !isId(parsed.type)) return null;
  if (hasTname && (typeof parsed.tname !== 'string' || parsed.tname.length === 0)) return null;
  if (
    parsed.assoc !== undefined &&
    parsed.assoc !== null &&
    (typeof parsed.assoc !== 'number' || !Number.isInteger(parsed.assoc))
  ) {
    return null;
  }

  try {
    return Y.createRelativePositionFromJSON(parsed);
  } catch {
    // Defensive: JSON that passes the checks above is accepted by Yjs today, but
    // decoding must never be the thing that throws in a stale-check path.
    return null;
  }
}

/**
 * Create the anchor for one operation at `range` in the **current** `text`.
 *
 * - `length` given → replace anchor: `end` is included.
 * - `length` omitted → insert anchor: no `end`, and `expectedText` is `""`
 *   because a zero-length range contains no text.
 *
 * `expectedText` is read from the same snapshot the positions are created from,
 * so the two cannot disagree at generation time.
 *
 * Out-of-range input throws `RangeError`: an anchor with an index past the end
 * of the document cannot be created honestly. This is a programming error in
 * the caller (A4), not a staleness condition.
 */
export function createOperationAnchor(
  text: Y.Text,
  range: { index: number; length: number },
): AiOperationAnchor & { end: string };
export function createOperationAnchor(
  text: Y.Text,
  range: { index: number; length?: number },
): AiOperationAnchor;
export function createOperationAnchor(
  text: Y.Text,
  range: { index: number; length?: number },
): AiOperationAnchor {
  const { index, length } = range;

  if (!Number.isInteger(index) || index < 0 || index > text.length) {
    throw new RangeError(
      `createOperationAnchor: index ${index} is outside the document (0..${text.length})`,
    );
  }
  if (length !== undefined) {
    if (!Number.isInteger(length) || length < 0 || index + length > text.length) {
      throw new RangeError(
        `createOperationAnchor: length ${length} does not fit at index ${index} (document length ${text.length})`,
      );
    }
  }

  const documentText = text.toString();
  const start = Y.createRelativePositionFromTypeIndex(text, index, START_ASSOC);
  const expectedText = documentText.slice(index, index + (length ?? 0));

  if (length === undefined) {
    return { start: encodeRelativePosition(start), expectedText };
  }

  const end = Y.createRelativePositionFromTypeIndex(text, index + length, END_ASSOC);
  return {
    start: encodeRelativePosition(start),
    end: encodeRelativePosition(end),
    expectedText,
  };
}

/** One operation's range in the **current** document, derived from its anchors. */
export interface ResolvedRange {
  /** UTF-16 index in the current `Y.Text` where the operation starts. */
  index: number;
  /** UTF-16 length of the resolved range. Always `0` for an insert. */
  length: number;
}

/**
 * Why a suggestion cannot be applied.
 *
 * - `revision` — `baseRevision` no longer matches; checked first and alone.
 * - `anchor-unresolved` — an anchor cannot be resolved against this document
 *   (unknown item/type, wrong `Y.Text`, or an index outside `0..length`).
 * - `text-mismatch` — the anchors resolved, but the text there is not the
 *   `expectedText` the user reviewed. This is also what a **deleted** range
 *   reports, because Yjs keeps a deleted position resolvable (see module doc).
 * - `malformed` — the anchor itself is unusable (not JSON, wrong shape,
 *   `end` missing on a replace, `end` present on an insert, or `end < start`).
 */
export type ValidationFailureReason =
  'revision' | 'anchor-unresolved' | 'text-mismatch' | 'malformed';

/**
 * Outcome of the three-stage check.
 *
 * On success `ranges[i]` belongs to `suggestion.operations[i]`; the array is
 * 1:1 with the operations and in the same order, so an applier can zip them.
 */
export type ValidationResult =
  { ok: true; ranges: ResolvedRange[] } | { ok: false; reason: ValidationFailureReason };

/**
 * Validate a suggestion against the **current** document (M3, CONTRACTS §11.1).
 *
 * The first failure wins; a failed check never partially applies anything:
 *
 * 1. `baseRevision === currentRevision` (the existing `isSuggestionStale`).
 * 2. Every anchor resolves against the current `Y.Text` (`anchor-unresolved`).
 * 3. The resolved text is **exactly** `expectedText` (`text-mismatch`).
 *
 * `index` / `length` on the operations are ignored here on purpose: the Diff
 * Preview renders from them, but the anchors are the application authority.
 */
export function validateSuggestionAgainstDocument(
  suggestion: AiEditSuggestion,
  doc: Y.Doc,
  currentRevision: number,
): ValidationResult {
  // A caller that bypassed the schema (untyped JS, a cast) must get `malformed`,
  // not a TypeError from reading `baseRevision` off null.
  if (!isPlainObject(suggestion)) return failure('malformed');

  // Check 1, and it runs before any anchor work so a moved document reports
  // `revision` even when the anchors are also unusable.
  if (isSuggestionStale(suggestion, currentRevision)) return failure('revision');

  if (!Array.isArray(suggestion.operations) || suggestion.operations.length === 0) {
    return failure('malformed');
  }

  const text = doc.getText(DOCUMENT_TEXT_KEY);
  const documentText = text.toString();
  const ranges: ResolvedRange[] = [];

  for (const operation of suggestion.operations) {
    const resolution = resolveOperation(operation, doc, text, documentText);
    if (!resolution.ok) return failure(resolution.reason);
    ranges.push(resolution.range);
  }

  return { ok: true, ranges };
}

/* ---------------------------------------------------------------------- *
 * Internals
 * ---------------------------------------------------------------------- */

type OperationResolution =
  { ok: true; range: ResolvedRange } | { ok: false; reason: ValidationFailureReason };

function failure(reason: ValidationFailureReason): { ok: false; reason: ValidationFailureReason } {
  return { ok: false, reason };
}

function resolveOperation(
  operation: AiEditOperation,
  doc: Y.Doc,
  text: Y.Text,
  documentText: string,
): OperationResolution {
  if (!isPlainObject(operation)) return failure('malformed');

  const kind = operation.kind;
  if (kind !== 'replace' && kind !== 'insert') return failure('malformed');

  const anchor = operation.anchor;
  if (!isPlainObject(anchor)) return failure('malformed');

  const expectedText = anchor.expectedText;
  if (typeof expectedText !== 'string') return failure('malformed');

  // Structural checks first: a malformed anchor stays `malformed` even if the
  // positions it does have would fail to resolve.
  if (kind === 'insert' && Object.prototype.hasOwnProperty.call(anchor, 'end')) {
    return failure('malformed');
  }

  const startPosition = decodeAnchorField(anchor.start);
  if (startPosition === null) return failure('malformed');

  let endPosition: Y.RelativePosition | null = null;
  if (kind === 'replace') {
    // `anchor` is a union of the replace/insert shapes after the guard above;
    // read the replace-only field through the plain record view.
    endPosition = decodeAnchorField((anchor as Record<string, unknown>).end);
    if (endPosition === null) return failure('malformed');
  }

  // Check 2: resolution against the live document.
  const start = resolveIndex(startPosition, doc, text);
  if (start === null) return failure('anchor-unresolved');

  if (kind === 'insert') {
    // A zero-length range contains no text; this keeps the same exact-compare
    // rule as a replace instead of treating an insert as a special case.
    if (documentText.slice(start, start) !== expectedText) return failure('text-mismatch');
    return { ok: true, range: { index: start, length: 0 } };
  }

  const end = endPosition === null ? null : resolveIndex(endPosition, doc, text);
  if (end === null) return failure('anchor-unresolved');

  // Anchors are ordered by construction; an inverted pair is corrupt input, not
  // a document state a peer can produce.
  if (end < start) return failure('malformed');

  // Check 3: exact string compare, UTF-16 code unit for code unit.
  if (documentText.slice(start, end) !== expectedText) return failure('text-mismatch');

  return { ok: true, range: { index: start, length: end - start } };
}

/**
 * Resolve one position to an index in **this** `Y.Text`, or `null` when it does
 * not belong to it / falls outside it. `null` from Yjs (unknown client clock,
 * unknown nested type, GC'd struct) and an out-of-range index are both
 * `anchor-unresolved` for the caller.
 */
function resolveIndex(position: Y.RelativePosition, doc: Y.Doc, text: Y.Text): number | null {
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, doc);
  if (absolute === null) return null;
  if (absolute.type !== text) return null;
  if (!Number.isInteger(absolute.index) || absolute.index < 0 || absolute.index > text.length) {
    return null;
  }
  return absolute.index;
}

function decodeAnchorField(value: unknown): Y.RelativePosition | null {
  return typeof value === 'string' ? decodeRelativePosition(value) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    Number.isInteger(value.client) &&
    (value.client as number) >= 0 &&
    Number.isInteger(value.clock) &&
    (value.clock as number) >= 0
  );
}
