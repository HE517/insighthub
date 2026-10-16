import { z } from 'zod';

/**
 * Awareness contract (frozen by M1-A0).
 *
 * Awareness is **ephemeral presence**: who is in the document and where their
 * cursor/selection is. It is:
 *
 * - NEVER persisted to IndexedDB as document data;
 * - NEVER merged into `Y.Text` or any `Y.Doc` shared type;
 * - NEVER used as a source of truth for document content.
 *
 * If a client disconnects, its awareness entry must be removed rather than kept:
 * the server broadcasts the departure and every peer drops the entry (see
 * `docs/CONTRACTS.md` §5 for the exact cleanup rules). A stale cursor belonging
 * to a user who already left is a bug, not a cosmetic issue.
 *
 * Awareness data crosses the wire as untrusted JSON embedded in a binary
 * awareness frame. Because it is rendered directly (another user's name and
 * cursor position in the editor), it must be validated before use — use
 * `isAwarenessState` / `awarenessStateSchema` rather than casting.
 */

/** UTF-16 offset into the document text, as Yjs relative positions resolve to. */
export const awarenessCursorSchema = z.object({
  anchor: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
});

export type AwarenessCursor = z.infer<typeof awarenessCursorSchema>;

/** A range the user has selected, if any. `null` means "no selection". */
export const awarenessSelectionSchema = z
  .object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
  .refine((range) => range.from <= range.to, {
    message: 'selection.from must be <= selection.to',
  });

export type AwarenessSelection = z.infer<typeof awarenessSelectionSchema>;

/** Identity of the person behind a cursor. */
export const awarenessUserSchema = z.object({
  /** Stable user id from the auth layer (M2). */
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  /** Deterministic colour for this user's cursor, assigned client-side. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #rrggbb hex string')
    .optional(),
});

export type AwarenessUser = z.infer<typeof awarenessUserSchema>;

/** The full local awareness state this client publishes about itself. */
export const awarenessStateSchema = z.object({
  user: awarenessUserSchema,
  cursor: awarenessCursorSchema.nullable(),
  selection: awarenessSelectionSchema.nullable(),
  /** Wall-clock ms of the last local update; peers may use it to order presence. */
  updatedAt: z.number().int().nonnegative(),
});

export type AwarenessState = z.infer<typeof awarenessStateSchema>;

/** Validate untrusted awareness state from a peer. Never throws. */
export function isAwarenessState(value: unknown): value is AwarenessState {
  return awarenessStateSchema.safeParse(value).success;
}

/**
 * `awareness.getStates()` is an untrusted `Map<clientId, unknown>`: entries are
 * whatever peers sent. This collects only the entries that satisfy the contract.
 */
export function collectValidAwarenessStates(
  states: ReadonlyMap<number, unknown>,
): Map<number, AwarenessState> {
  const valid = new Map<number, AwarenessState>();
  for (const [clientId, state] of states) {
    if (isAwarenessState(state)) {
      valid.set(clientId, state);
    }
  }
  return valid;
}

/** How many entries one awareness update may mention, to bound fan-out cost. */
export const MAX_AWARENESS_CLIENTS_PER_UPDATE = 512;
