/**
 * Remote cursor presence, derived from awareness but never rendered raw.
 *
 * ## The rule this file implements (AGENTS.md R14, CONTRACTS §9.2)
 *
 * `awareness.getStates()` is a `Map<number, unknown>` filled with whatever peers
 * sent over the wire. It is **not** a UI data source: rendering it directly means
 * rendering an unvalidated, possibly hostile peer payload as another user's name
 * and cursor.
 *
 * So presence is derived in two steps, and this module is the only place that
 * combines them:
 *
 * 1. the awareness entry is validated against `awarenessStateSchema`
 *    (`collectValidAwarenessStates`), and
 * 2. the display identity (name, colour) comes from
 *    `session.getCollaborators()`, which is already schema-validated.
 *
 * An entry that fails validation produces **no cursor at all** rather than a
 * partially rendered one — a malformed payload must never reach the UI. An entry
 * whose client is absent from the validated collaborator list is likewise dropped:
 * it cannot be attributed to a known user.
 *
 * The raw `Awareness` instance is still handed to the CodeMirror extension as a
 * *binding* input (it is the live object that fires change events), which is the
 * single exception the contract allows. The offsets read from it are numbers —
 * untrusted, but bounded and clamped before use — and every string shown to a
 * user comes from the validated collaborator list.
 */
import {
  collectValidAwarenessStates,
  type AwarenessState,
  type CollaboratorInfo,
} from '@insighthub/shared';

/** Minimal structural view of a Yjs `Awareness`; a real instance satisfies it. */
export interface AwarenessView {
  readonly clientID: number;
  getStates(): ReadonlyMap<number, unknown>;
  on(eventName: string, eventHandler: (...args: never[]) => void): void;
  off(eventName: string, eventHandler: (...args: never[]) => void): void;
}

/** A collaborator whose cursor is safe to render. */
export interface RemoteCursor {
  clientId: number;
  user: { id: string; name: string; color: string };
  /** Caret head, clamped to the document. */
  head: number;
  /** Selection anchor; equals `head` when nothing is selected. */
  anchor: number;
  /** Normalised selection range, or `null` when the cursor is collapsed. */
  selection: { from: number; to: number } | null;
}

/** Fallback palette so a peer without a colour still gets a stable, distinct one. */
const FALLBACK_COLORS = ['#1677ff', '#13c2c2', '#52c41a', '#faad14', '#eb2f96', '#722ed1'];

/**
 * A deterministic colour per client id.
 *
 * Deterministic rather than random on purpose: two peers must agree on the colour
 * of a third, and a random colour would change on every render.
 */
export function colorForClient(clientId: number): string {
  const index = Math.abs(clientId) % FALLBACK_COLORS.length;
  return FALLBACK_COLORS[index]!;
}

/**
 * Build the renderable remote cursors.
 *
 * `documentLength` is used to clamp offsets: a peer may legitimately report an
 * offset beyond our current text (their update has not arrived yet), and a
 * CodeMirror range outside the document throws.
 */
export function collectRemoteCursors(
  awareness: AwarenessView,
  collaborators: readonly CollaboratorInfo[],
  documentLength: number,
  selfClientId: number,
): RemoteCursor[] {
  const validStates = collectValidAwarenessStates(awareness.getStates());
  if (validStates.size === 0) return [];

  const byClient = new Map<number, CollaboratorInfo>();
  for (const collaborator of collaborators) {
    byClient.set(collaborator.clientId, collaborator);
  }

  const cursors: RemoteCursor[] = [];

  for (const [clientId, state] of validStates) {
    // Never draw our own cursor twice: the local one belongs to the editor.
    if (clientId === selfClientId) continue;

    const collaborator = byClient.get(clientId);
    // Not attributable to a validated user → not rendered. See the module note.
    if (collaborator === undefined) continue;

    const cursor = cursorFromState(state, documentLength);
    if (cursor === null) continue;

    cursors.push({
      clientId,
      user: {
        id: collaborator.user.id,
        name: collaborator.user.name,
        color: collaborator.user.color ?? colorForClient(clientId),
      },
      head: cursor.head,
      anchor: cursor.anchor,
      selection: cursor.selection,
    });
  }

  return cursors;
}

/**
 * Cursor offsets for one validated awareness state.
 *
 * The contract carries **two independent fields** (`docs/CONTRACTS.md` §9):
 * `cursor` is the caret (`anchor` + `head`, which also gives the direction) and
 * `selection` is the normalised range the user has highlighted. A client normally
 * publishes both, derived from one `EditorSelection`, but nothing forces the two
 * to arrive in the same update, so neither field may be used to reconstruct the
 * other:
 *
 * - the caret comes from `cursor.head`;
 * - the highlighted range comes from `selection`;
 * - a peer that publishes no `selection` but a non-collapsed `cursor` still gets a
 *   range, derived from the cursor itself (that is what a cursor-only client
 *   sends);
 * - a `selection` that arrives while the `cursor` is collapsed is still rendered.
 *   Deriving the range from the cursor alone - the previous behaviour - silently
 *   dropped it, so a remote selection never appeared.
 */
function cursorFromState(
  state: AwarenessState,
  documentLength: number,
): { head: number; anchor: number; selection: { from: number; to: number } | null } | null {
  const cursor =
    state.cursor === null
      ? null
      : {
          anchor: clampOffset(state.cursor.anchor, documentLength),
          head: clampOffset(state.cursor.head, documentLength),
        };

  const published =
    state.selection === null
      ? null
      : {
          from: clampOffset(state.selection.from, documentLength),
          to: clampOffset(state.selection.to, documentLength),
        };

  // Clamping is monotonic, so a valid `selection` keeps `from <= to`.
  const range =
    published ??
    (cursor === null
      ? null
      : { from: Math.min(cursor.anchor, cursor.head), to: Math.max(cursor.anchor, cursor.head) });

  if (cursor !== null) {
    return {
      anchor: cursor.anchor,
      head: cursor.head,
      selection: range !== null && range.to > range.from ? range : null,
    };
  }

  // No usable caret: the selection endpoints are the only position information.
  if (range === null) return null;
  return { anchor: range.from, head: range.to, selection: range.to > range.from ? range : null };
}

function clampOffset(offset: number, documentLength: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  if (offset > documentLength) return documentLength;
  return Math.trunc(offset);
}

/**
 * Subscribe to awareness changes.
 *
 * Wrapped so the extension never has to know the `y-protocols` event name, and so
 * a test double only has to implement `on`/`off`.
 */
export function observeAwareness(awareness: AwarenessView, listener: () => void): () => void {
  const handler = (): void => listener();
  awareness.on('change', handler as (...args: never[]) => void);
  // `update` fires for added/updated/removed entries and is the event Yjs
  // bindings conventionally use for cursor redraws; both are observed so a
  // removal (peer left) repaints immediately rather than on the 30 s expiry.
  awareness.on('update', handler as (...args: never[]) => void);

  return () => {
    awareness.off('change', handler as (...args: never[]) => void);
    awareness.off('update', handler as (...args: never[]) => void);
  };
}
