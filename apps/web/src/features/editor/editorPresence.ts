/**
 * Local presence publishing for the editor (M2-P0-2 step 2).
 *
 * ## What this module replaces
 *
 * The editor used to publish its caret by writing the raw awareness instance three times
 * per movement: one `setLocalStateField` call for `cursor`, one for `selection` and one
 * for `updatedAt`. That had three defects which the seam (`docs/CONTRACTS.md` §15)
 * removes:
 *
 * 1. **Three awareness updates, not one.** Each local-state-field write bumps the
 *    awareness clock and emits on every call, and the sync provider turns each emit into
 *    a frame, so one caret move cost three frames.
 * 2. **`updatedAt` was A2's bookkeeping.** The collaboration layer already owns that
 *    field; two owners meant it could be stale, skipped, or disagree with the layer.
 * 3. **The published shape was nobody's contract.** Only the read side was validated,
 *    so what this client wrote was whatever A2 happened to build.
 *
 * The literal old call syntax is deliberately not quoted in this comment: a reviewer
 * proving "zero bare awareness writes under `features/**`" with a grep should get zero
 * hits, not zero-hits-plus-comments.
 *
 * Presence now goes through exactly one call per update: `session.publishPresence`. The
 * seam validates the patch before writing, stamps `updatedAt` itself, and merges a
 * partial patch instead of replacing the whole state.
 *
 * ## Why the patch lives in its own function
 *
 * `presencePatchForRange` is the pure half (a CodeMirror selection range becomes a
 * `PresencePatch`), so the collapsed/non-collapsed and reversed-anchor rules can be
 * asserted in a Node test. The component wiring is then a single call, and this module
 * imports nothing from CodeMirror or React, which is what lets it be tested at all -
 * `EditorView` needs a DOM.
 *
 * ## What this module must never do again
 *
 * - touch `session.awareness` (it is a binding input only: `AGENTS.md` R14);
 * - compute `updatedAt`;
 * - gate on `getLocalAwarenessState()`. The session already no-ops when it has no
 *   local state, and duplicating that check here would mean a caret movement produces
 *   zero seam calls instead of one, hiding a real wiring defect behind a guard.
 */
import type { CollaborativeSession, PresencePatch } from '@insighthub/shared';

/** The part of the session this module needs, stated as the only write path it has. */
export type PresencePublisher = Pick<CollaborativeSession, 'publishPresence'>;

/**
 * Build the presence patch for a CodeMirror selection range.
 *
 * `anchor`/`head` are kept as given (they encode direction), while `selection` is
 * normalised to `from <= to` because `awarenessSelectionSchema` requires it. A
 * collapsed cursor publishes `selection: null` rather than a zero-length range: `null`
 * is the contract's representation of "nothing selected", and an empty range would ask
 * every peer to render a zero-width selection.
 */
export function presencePatchForRange(range: {
  readonly anchor: number;
  readonly head: number;
}): PresencePatch {
  const from = Math.min(range.anchor, range.head);
  const to = Math.max(range.anchor, range.head);
  return {
    cursor: { anchor: range.anchor, head: range.head },
    selection: from === to ? null : { from, to },
  };
}

/**
 * Publish the local caret and selection in one seam call.
 *
 * Deliberately not defensive: the session owns the "no local state yet" and "already
 * destroyed" cases, so an invalid range or a dead session surfaces as the seam's own
 * behaviour instead of being silently swallowed here.
 */
export function publishEditorPresence(
  session: PresencePublisher,
  range: { readonly anchor: number; readonly head: number },
): void {
  session.publishPresence(presencePatchForRange(range));
}
