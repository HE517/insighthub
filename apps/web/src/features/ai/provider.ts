import type * as Y from 'yjs';

import {
  createOperationAnchor,
  type AiEditOperation,
  type AiEditSuggestion,
} from '@insighthub/shared';

import { unifiedDiff } from './diff.js';

/**
 * The AI provider seam (M3 round 1, `docs/DECISIONS.md` D-075 §4).
 *
 * A provider turns a human instruction plus a document snapshot into an `AiEditSuggestion` — a
 * **proposal**, never document state (`docs/ARCHITECTURE.md` §3). It is the only thing that will
 * ever differ when a real model replaces the deterministic local implementation: proposal
 * generation, anchoring and application are separate layers.
 *
 * ## Why `anchorText` exists, and why it is required
 *
 * The draft shape in the round brief carries `text: string` and nothing else. That is enough to
 * *decide* an edit, but it is not enough to *anchor* one. `docs/CONTRACTS.md` §11.1 requires every
 * operation to carry an encoded Yjs `RelativePosition`, and `createOperationAnchor` can only mint
 * a resolvable position from the **live** `Y.Text` the suggestion will later be validated
 * against.
 *
 * Anchors minted against any other `Y.Text` — including a fresh `Y.Doc` seeded with the same
 * string — carry unknown client ids, so `createAbsolutePositionFromRelativePosition` returns
 * `null` against the real document and every suggestion would fail as `anchor-unresolved`
 * (`apply.test.ts` pins that this is exactly what happens). Hand-writing the JSON is forbidden
 * by the round brief and would be a private encoding of a Yjs structure.
 *
 * So the seam takes both halves explicitly:
 *
 * | field | used for |
 * | --- | --- |
 * | `text` | deciding the edit and rendering the diff (a plain snapshot) |
 * | `anchorText` | minting `RelativePosition` anchors, via `createOperationAnchor` |
 *
 * `buildSuggestion` refuses to run when they disagree: anchoring one string while describing
 * another is a silent corruption, not a user error.
 *
 * ## What a provider must not do
 *
 * - No document writes. Everything here is pure computation over the input.
 * - No Redux/React writes, no awareness writes, no `CollaborativeSession` mutation.
 * - No network. M3 round 1 has no external AI service; only `tools.listDocuments` may use HTTP.
 */

/** One request to a provider. */
export interface AiSuggestInput {
  /** Document the suggestion belongs to (`AiEditSuggestion.documentId`). */
  documentId: string;
  /** What the user asked for, verbatim. Intent interpretation is provider-specific. */
  instruction: string;
  /** Document text snapshot the edit is decided from. Must equal `anchorText.toString()`. */
  text: string;
  /** Optional UTF-16 selection; `from === to` is treated as "no selection" by the local provider. */
  selection?: { from: number; to: number };
  /** Revision of the snapshot. Becomes `AiEditSuggestion.baseRevision` (staleness guard #1). */
  baseRevision: number;
  /** Cancellation for R9. A provider must stop before returning a suggestion once aborted. */
  signal?: AbortSignal;
  /**
   * The **live** `Y.Text` the anchors are created from.
   *
   * Session-scoped: pass `session.text`, never a temporary document. See the module comment for
   * why this field cannot be derived from `text`.
   */
  anchorText: Y.Text;
}

/** The one interface a real model integration has to satisfy. */
export interface AiProvider {
  suggest(input: AiSuggestInput): Promise<AiEditSuggestion>;
}

/** Operations before anchoring; what a provider actually has to reason about. */
export type AiOperationDraft =
  | { kind: 'replace'; index: number; length: number; text: string }
  | { kind: 'insert'; index: number; text: string };

/** Stable module path consumers (A2) may import the types from. */
export const AI_PROVIDER_SEAM = 'apps/web/src/features/ai/provider.ts';

/**
 * Abort guard for R9.
 *
 * Rethrows the abort reason when it is an `Error` (so a caller's own `AbortController.abort(err)`
 * survives), otherwise a standard `AbortError` `DOMException`. Deterministic providers have no
 * I/O to interrupt, but they still must not hand back a suggestion the caller already cancelled.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal === undefined || !signal.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException('The suggestion request was aborted.', 'AbortError');
}

/**
 * Mint one anchor per draft with `createOperationAnchor` — the only anchor construction path this
 * codebase allows (`docs/CONTRACTS.md` §11.1).
 *
 * A replace passes `length` (so the anchor carries `end`); an insert omits it (the anchor has no
 * `end`, which the shared schema enforces with `.strict()`). Out-of-range drafts throw
 * `RangeError` from the shared helper: that is a provider bug, not a staleness condition.
 */
export function anchorDrafts(
  anchorText: Y.Text,
  drafts: readonly AiOperationDraft[],
): AiEditOperation[] {
  return drafts.map((draft) => {
    if (draft.kind === 'replace') {
      return {
        kind: 'replace' as const,
        index: draft.index,
        length: draft.length,
        text: draft.text,
        anchor: createOperationAnchor(anchorText, { index: draft.index, length: draft.length }),
      };
    }
    return {
      kind: 'insert' as const,
      index: draft.index,
      text: draft.text,
      anchor: createOperationAnchor(anchorText, { index: draft.index }),
    };
  });
}

/**
 * Apply drafts to a plain string, in the same order `applySuggestion` uses: **descending index**,
 * and for equal indexes the later draft first (so operations listed `[A, B]` at one index end up
 * `A B` in the text).
 *
 * This exists so the diff is computed from the exact post-application text — "the preview must
 * match what Accept does" is an invariant, not a nicety (A4 brief §4.5). It is pure and only used
 * for rendering; it is never the write path.
 */
export function projectText(text: string, drafts: readonly AiOperationDraft[]): string {
  // Ascending sort (stable, so equal indexes keep the order the provider listed them in), then
  // walk backwards: that is exactly "descending index, later draft first for a tie".
  const ordered = [...drafts].sort((left, right) => left.index - right.index);
  let projected = text;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const draft = ordered[index];
    if (draft.kind === 'replace') {
      projected =
        projected.slice(0, draft.index) + draft.text + projected.slice(draft.index + draft.length);
    } else {
      projected = projected.slice(0, draft.index) + draft.text + projected.slice(draft.index);
    }
  }
  return projected;
}

export interface BuildSuggestionOptions {
  input: AiSuggestInput;
  /** Human-readable line for the Diff Preview header (1..500 chars, shared schema). */
  summary: string;
  drafts: readonly AiOperationDraft[];
  /**
   * Timestamp stamped into `createdAt`.
   *
   * Injected rather than read from the wall clock so a test can pin the **whole** suggestion
   * object: the edit itself is a pure function of the input, and this is the only nondeterministic
   * field otherwise. A production caller passes `new Date()`.
   */
  now: Date;
  /** Prefix for the deterministic id. Defaults to `sug`. */
  idPrefix?: string;
  /** Diff header labels. */
  labels?: { before?: string; after?: string };
}

/**
 * Assemble a schema-valid `AiEditSuggestion` from drafts.
 *
 * Ordering guarantee: `operations[i]` corresponds to `drafts[i]`, all anchored against
 * `input.anchorText`, and `diff` is the unified diff from `input.text` to the projected result.
 *
 * Throws `TypeError` for programming errors (empty drafts, an invalid timestamp, or a `text`
 * snapshot that does not match `anchorText`). Those are bugs in the caller, not staleness.
 */
export function buildSuggestion(options: BuildSuggestionOptions): AiEditSuggestion {
  const { input, summary, drafts, now } = options;

  if (drafts.length === 0) {
    throw new TypeError('buildSuggestion: a suggestion needs at least one operation');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('buildSuggestion: `now` must be a valid Date');
  }

  const liveText = input.anchorText.toString();
  if (liveText !== input.text) {
    throw new TypeError(
      'buildSuggestion: `text` is a stale snapshot — it does not match `anchorText`. ' +
        'Anchors would point into text the operations do not describe.',
    );
  }

  const projected = projectText(input.text, drafts);
  const diff = unifiedDiff(input.text, projected, {
    beforeLabel: options.labels?.before ?? 'current',
    afterLabel: options.labels?.after ?? 'proposed',
  });

  return {
    id: deterministicSuggestionId(input, options.idPrefix ?? 'sug'),
    documentId: input.documentId,
    baseRevision: input.baseRevision,
    summary,
    operations: anchorDrafts(input.anchorText, drafts),
    diff,
    status: 'pending',
    createdAt: now.toISOString(),
  };
}

/**
 * A deterministic suggestion id derived from the request.
 *
 * Same request → same id, which makes the local provider reproducible and makes an accidental
 * duplicate request idempotent rather than producing two "different" proposals for one intent.
 * The hash is FNV-1a over the request fields (including the document text), formatted as 8 hex
 * digits. It is an identity aid, not a security primitive.
 */
export function deterministicSuggestionId(input: AiSuggestInput, prefix = 'sug'): string {
  const selection =
    input.selection === undefined ? '' : `${input.selection.from}:${input.selection.to}`;
  const seed = [
    input.documentId,
    String(input.baseRevision),
    input.instruction,
    selection,
    input.text,
  ].join('\u0000');
  return `${prefix}-${fnv1aHex(seed)}`;
}

/** FNV-1a (32-bit) as 8 lowercase hex digits. */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
