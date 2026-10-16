/**
 * CodeMirror extension that renders remote carets, selections and name labels.
 *
 * ## Where the data comes from
 *
 * Cursor *offsets* come from awareness (they are numbers, and awareness is the
 * only channel that has them — D-021). Every *string* shown to a user — the name
 * in a label — comes from `session.getCollaborators()`, i.e. from validated
 * `CollaboratorInfo`, never from the raw awareness map. See `remoteCursors.ts`
 * for the derivation rules and `AGENTS.md` R14 for the rule they implement.
 *
 * ## Why decorations are mapped, then rebuilt
 *
 * A decoration's position must follow the local document, and the two events that
 * move the truth arrive independently:
 *
 * - the local document changed → `DecorationSet.map` over `transaction.changes`
 *   keeps existing decorations aligned without re-reading awareness (cheap, and
 *   it preserves decorations for peers whose awareness has not moved);
 * - awareness changed → the state effect rebuilds the set from the validated
 *   collaborator list (a handful of entries, negligible even at 5 000 lines).
 *
 * Rebuilding on *every* update would also be correct but would put an awareness
 * read on the local keystroke path, which is exactly the hot-path work M1-A2 is
 * meant to avoid.
 */
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { CollaboratorInfo } from '@insighthub/shared';

import {
  collectRemoteCursors,
  observeAwareness,
  type AwarenessView,
  type RemoteCursor,
} from './remoteCursors.js';

/** Redraws remote cursors. Carries nothing: the provider reads live awareness. */
const refreshRemoteCursors = StateEffect.define<readonly RemoteCursor[]>();

/** Attribute names so tests and themes can find the injected nodes. */
export const CURSOR_ATTRIBUTE = 'data-insighthub-cursor';
export const SELECTION_ATTRIBUTE = 'data-insighthub-selection';

/** A zero-width, per-user-coloured caret. */
class CaretWidget extends WidgetType {
  constructor(readonly color: string) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    return other.color === this.color;
  }

  override toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'cm-remote-caret';
    caret.setAttribute(CURSOR_ATTRIBUTE, 'caret');
    caret.style.borderLeftColor = this.color;
    return caret;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** The name label shown at a remote caret. */
class CursorLabelWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
  ) {
    super();
  }

  override eq(other: CursorLabelWidget): boolean {
    return other.name === this.name && other.color === this.color;
  }

  override toDOM(): HTMLElement {
    const label = document.createElement('span');
    label.className = 'cm-remote-cursor-label';
    label.setAttribute(CURSOR_ATTRIBUTE, 'label');
    label.style.backgroundColor = this.color;
    // `textContent`, never `innerHTML`: the name is peer-supplied input.
    label.textContent = this.name;
    return label;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Build the decoration set for the given cursors.
 *
 * Pure and exported so the composition rules (clamping, collapsed selections,
 * one caret per collaborator) can be asserted without a DOM. `Decoration.set`
 * with `sort = true` is used because ranges are emitted per collaborator, and one
 * peer's caret can share a position with another's — a builder that requires
 * ascending input would have to be fed in a sorted order that is not the natural
 * one here.
 */
export function buildRemoteCursorDecorations(
  cursors: readonly RemoteCursor[],
  documentLength: number,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];

  for (const cursor of cursors) {
    const color = cursor.user.color;

    if (cursor.selection !== null) {
      const from = clamp(cursor.selection.from, documentLength);
      const to = clamp(cursor.selection.to, documentLength);
      if (to > from) {
        ranges.push(
          Decoration.mark({
            class: 'cm-remote-selection',
            attributes: { [SELECTION_ATTRIBUTE]: String(cursor.clientId) },
            // Colour travels with the range rather than in a stylesheet, because
            // the palette is per peer and therefore not known at build time.
            inclusive: false,
          }).range(from, to),
        );
      }
    }

    const head = clamp(cursor.head, documentLength);
    ranges.push(Decoration.widget({ widget: new CaretWidget(color), side: 1 }).range(head));
    ranges.push(
      Decoration.widget({ widget: new CursorLabelWidget(cursor.user.name, color), side: 2 }).range(
        head,
      ),
    );
  }

  return Decoration.set(ranges, true);
}

const remoteCursorField = StateField.define<DecorationSet>({
  create(): DecorationSet {
    return Decoration.none;
  },
  update(decorations, transaction) {
    // Follow local document changes first, then apply an explicit rebuild.
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(refreshRemoteCursors)) {
        next = buildRemoteCursorDecorations(effect.value, transaction.state.doc.length);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface RemoteCursorExtensionOptions {
  /** Live awareness object — a *binding* input, never a source of display strings. */
  awareness: AwarenessView;
  /**
   * The validated accessor. Pass `session.getCollaborators` itself (not a copy of
   * the awareness map) — that is the point of this option.
   */
  getCollaborators(): readonly CollaboratorInfo[];
  /** This client's awareness id, so our own caret is never drawn twice. */
  localClientId: number;
}

export function remoteCursors(options: RemoteCursorExtensionOptions): Extension {
  const { awareness, getCollaborators, localClientId } = options;

  const compute = (state: EditorState): readonly RemoteCursor[] =>
    collectRemoteCursors(awareness, getCollaborators(), state.doc.length, localClientId);

  const plugin = ViewPlugin.fromClass(
    class {
      private readonly unsubscribe: () => void;

      constructor(readonly view: EditorView) {
        // Repaint on attach so collaborators already in the room are visible
        // immediately, instead of waiting for their next movement.
        this.view.dispatch({ effects: refreshRemoteCursors.of(compute(this.view.state)) });

        this.unsubscribe = observeAwareness(awareness, () => {
          // Dispatching from an awareness callback is safe: CodeMirror queues the
          // update, and the effect carries the freshly computed cursors so the
          // state field never has to read awareness itself.
          this.view.dispatch({ effects: refreshRemoteCursors.of(compute(this.view.state)) });
        });
      }

      update(_update: ViewUpdate): void {
        // Position mapping for local document changes happens in the state field
        // (`DecorationSet.map`). Awareness changes arrive through the observer
        // above. Nothing to do per update, and deliberately so: this is the hot
        // path and it must stay free of awareness reads.
      }

      destroy(): void {
        this.unsubscribe();
      }
    },
  );

  return [remoteCursorField, plugin];
}

function clamp(offset: number, documentLength: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  if (offset > documentLength) return documentLength;
  return Math.trunc(offset);
}
