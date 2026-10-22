import { z } from 'zod';

import { documentRoleSchema } from './permission.js';

/**
 * An AI-proposed edit to a document.
 *
 * IMPORTANT ARCHITECTURE RULE (see docs/ARCHITECTURE.md):
 * a suggestion is a *proposal*, never document state. Accepting a suggestion
 * must be applied through a Yjs transaction (`Y.Doc.transact`) so that it is a
 * real CRDT edit. The AI module must never write the final document content by
 * dispatching into React/Redux state.
 *
 * Anchoring (M3, see docs/DECISIONS.md D-075 and docs/CONTRACTS.md §11.1):
 * every operation carries an `anchor` — an encoded Yjs `RelativePosition` for
 * its start (plus one for a replace's end) and the exact `expectedText` the
 * operation was generated from. `baseRevision` is still the first staleness
 * guard; the anchor and `expectedText` are what let a suggestion survive
 * concurrent edits *outside* its range while rejecting one whose range changed.
 *
 * `index`/`length` remain in the shape because the Diff Preview renders from
 * them and they are the readable form of the range. They are **not** the
 * authority when the suggestion is applied: the anchor is (`ai-anchor.ts`).
 *
 * M0 deliberately deferred RelativePosition to M4 (`docs/DECISIONS.md` D-004);
 * M3 supersedes that with this additive but required field — a
 * `SHARED_CONTRACT_VERSION` 7 → 8 change. `PROTOCOL_VERSION` does not move:
 * suggestions travel over the HTTP/in-memory layer, not the WebSocket wire.
 */

/**
 * The anchor of one operation (M3).
 *
 * `start` and `end` are JSON strings produced by Yjs's own
 * `relativePositionToJSON` — the same JSON shape `RelativePosition.toJSON()`
 * names in `docs/CONTRACTS.md` §11.1. They are not a private encoding.
 *
 * `end` is present **iff** the operation is a `replace`; an `insert` has no
 * replaced range. The per-operation schemas below enforce that with two
 * different object shapes rather than one optional field that a caller must
 * remember to omit.
 */
export const aiOperationAnchorSchema = z.object({
  /** Encoded RelativePosition for the inclusive start of the range. */
  start: z.string().min(1),
  /** Encoded RelativePosition for the exclusive end of a replaced range. */
  end: z.string().min(1).optional(),
  /** The exact text this operation expects at its range when it is applied. */
  expectedText: z.string(),
});

export type AiOperationAnchor = z.infer<typeof aiOperationAnchorSchema>;

/** A replace must carry both ends; `end` is required here. */
const aiReplaceAnchorSchema = aiOperationAnchorSchema.extend({
  end: z.string().min(1),
});

/**
 * An insert has a zero-length range, so it must not carry an `end` at all.
 * `.strict()` matters: without it Zod would silently strip a stray `end`, and
 * a caller would believe it anchored a range that the contract says cannot
 * exist.
 */
const aiInsertAnchorSchema = aiOperationAnchorSchema.omit({ end: true }).strict();

/** Replace `length` UTF-16 code units at `index` with `text` ("" = delete). */
export const aiReplaceOperationSchema = z.object({
  kind: z.literal('replace'),
  index: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  text: z.string(),
  anchor: aiReplaceAnchorSchema,
});

/** Insert `text` at `index` (before the existing code unit at `index`). */
export const aiInsertOperationSchema = z.object({
  kind: z.literal('insert'),
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
  anchor: aiInsertAnchorSchema,
});

export const aiEditOperationSchema = z.discriminatedUnion('kind', [
  aiReplaceOperationSchema,
  aiInsertOperationSchema,
]);

export type AiEditOperation = z.infer<typeof aiEditOperationSchema>;
export type AiReplaceOperation = z.infer<typeof aiReplaceOperationSchema>;
export type AiInsertOperation = z.infer<typeof aiInsertOperationSchema>;

export const AI_SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected', 'stale'] as const;
export const aiSuggestionStatusSchema = z.enum(AI_SUGGESTION_STATUSES);
export type AiSuggestionStatus = z.infer<typeof aiSuggestionStatusSchema>;

export const aiEditSuggestionSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  /** Document revision the suggestion was generated against (staleness guard). */
  baseRevision: z.number().int().nonnegative(),
  /** Short human-readable explanation shown in the Diff Preview header. */
  summary: z.string().min(1).max(500),
  operations: z.array(aiEditOperationSchema).min(1),
  /** Unified diff text rendered by the Diff Preview. */
  diff: z.string(),
  status: aiSuggestionStatusSchema,
  createdAt: z.string().datetime(),
});

export type AiEditSuggestion = z.infer<typeof aiEditSuggestionSchema>;

/** Minimal request shape the editor sends when asking for a suggestion. */
export const aiSuggestRequestSchema = z.object({
  documentId: z.string().min(1),
  instruction: z.string().min(1).max(2000),
  /** Revision of the content the user is looking at when asking. */
  baseRevision: z.number().int().nonnegative(),
  /** Content sent for context; capped to keep the MVP payload bounded. */
  content: z.string().max(200_000),
});

export type AiSuggestRequest = z.infer<typeof aiSuggestRequestSchema>;

/** Who may accept an AI edit. Reuses the shared RBAC vocabulary. */
export const aiAcceptRequiredRole = documentRoleSchema.exclude(['viewer', 'commenter']);

/**
 * A suggestion is stale when the document moved on since it was generated.
 * Used by both server (reject) and client (grey out Accept button).
 */
export function isSuggestionStale(
  suggestion: Pick<AiEditSuggestion, 'baseRevision'>,
  currentRevision: number,
): boolean {
  return suggestion.baseRevision !== currentRevision;
}
