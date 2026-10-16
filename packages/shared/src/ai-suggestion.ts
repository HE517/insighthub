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
 * Anchoring decision (M0, see docs/DECISIONS.md D-004):
 * operations carry plain UTF-16 `index` offsets plus `baseRevision`. A
 * suggestion whose `baseRevision` no longer matches the document revision is
 * stale and must be rejected/regenerated instead of being applied blindly.
 * M4 may upgrade this anchoring to Yjs RelativePosition.
 */

/** Replace `length` UTF-16 code units at `index` with `text` ("" = delete). */
export const aiReplaceOperationSchema = z.object({
  kind: z.literal('replace'),
  index: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  text: z.string(),
});

/** Insert `text` at `index` (before the existing code unit at `index`). */
export const aiInsertOperationSchema = z.object({
  kind: z.literal('insert'),
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
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
