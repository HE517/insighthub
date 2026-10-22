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
 *
 * ## Who decides *when* a rebuild happens
 *
 * `remoteCursorPresence.ts`. Nothing here dispatches from the plugin constructor:
 * a `ViewPlugin` is constructed inside an update cycle, where `view.dispatch`
 * throws, so the mount-time paint is deferred and coalesced there (DEFECT P0-3,
 * `AGENTS.md` A2 invariant 4). This file only turns a cursor list into decorations.
 */
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { CollaboratorInfo } from '@insighthub/shared';

import { createRemoteCursorPresence, type RemoteCursorPresence } from './remoteCursorPresence.js';
import { type AwarenessView, type RemoteCursor } from './remoteCursors.js';

/** Redraws remote cursors. Carries nothing: the provider reads live awareness. */
const refreshRemoteCursors = StateEffect.define<readonly RemoteCursor[]>();

/** Attribute names so tests and themes can find the injected nodes. */
export const CURSOR_ATTRIBUTE = 'data-insighthub-cursor';
export const SELECTION_ATTRIBUTE = 'data-insighthub-selection';

/**
 * A zero-width, per-user-coloured caret **with its name label as a child**.
 *
 * ## Why the label is nested inside the caret (DEFECT: label clipped at the top)
 *
 * The label is absolutely positioned, so it is placed relative to its nearest
 * *positioned* ancestor. As a separate sibling widget it had none between itself and
 * `.cm-scroller` (`position: relative` in CodeMirror's base theme): `left: -1px;
 * top: -1.25em` therefore resolved against the **scroll container's** origin, not the
 * caret's line, and the label was rendered at the editor's top-left corner and clipped
 * by the scroller's `overflow` (~14px measured). It looked plausible in a one-line
 * document and was wrong on every other line.
 *
 * Rendering the label as a child of `.cm-remote-caret` — which is itself
 * `position: relative` (`styles.css`) — makes the caret the containing block. The label
 * then follows the caret on every line, at every scroll offset, with no measuring and no
 * per-update work. One decoration per peer also means the two pieces cannot drift apart
 * when a line is re-rendered.
 *
 * The label is a *different* element with its own `data-insighthub-cursor="label"` (the
 * A6 suite queries both), it is only nested, not merged into the caret's own contract.
 */
class CaretWidget extends WidgetType {
  constructor(
    readonly color: string,
    readonly name: string,
  ) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    // The name participates in equality: a renamed collaborator must repaint the text,
    // and CodeMirror reuses a widget's DOM whenever `eq` says nothing changed.
    return other.color === this.color && other.name === this.name;
  }

  override toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'cm-remote-caret';
    caret.setAttribute(CURSOR_ATTRIBUTE, 'caret');
    caret.style.borderLeftColor = this.color;

    const label = document.createElement('span');
    label.className = 'cm-remote-cursor-label';
    label.setAttribute(CURSOR_ATTRIBUTE, 'label');
    label.style.backgroundColor = this.color;
    // `textContent`, never `innerHTML`: the name is peer-supplied input.
    label.textContent = this.name;
    caret.appendChild(label);
    return caret;
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
    // One widget per peer: the caret owns its label (see `CaretWidget`), so the label
    // can never be positioned against the scroller instead of the caret.
    ranges.push(
      Decoration.widget({
        widget: new CaretWidget(color, cursor.user.name),
        side: 1,
      }).range(head),
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

  const plugin = ViewPlugin.fromClass(
    class {
      private readonly presence: RemoteCursorPresence;

      constructor(view: EditorView) {
        // Nothing is dispatched here on purpose. A `ViewPlugin` constructor runs
        // inside an update cycle, where `view.dispatch` throws ("Calls to
        // EditorView.update are not allowed while an update is in progress"), so
        // the mount-time repaint once crashed the plugin and no remote cursor was
        // ever drawn (DEFECT P0-3). The presence owns both the deferred first paint
        // and the awareness subscription; see `remoteCursorPresence.ts`.
        this.presence = createRemoteCursorPresence({
          awareness,
          getCollaborators,
          localClientId,
          repaint: {
            documentLength: () => view.state.doc.length,
            dispatch: (cursors) => {
              view.dispatch({ effects: refreshRemoteCursors.of(cursors) });
            },
          },
        });
      }

      update(_update: ViewUpdate): void {
        // Position mapping for local document changes happens in the state field
        // (`DecorationSet.map`). Awareness changes arrive through the presence
        // subscription above. Nothing to do per update, and deliberately so: this
        // is the hot path and it must stay free of awareness reads.
      }

      destroy(): void {
        // Unsubscribes both awareness events and drops a first paint that has not
        // run yet, so nothing is dispatched into a destroyed view.
        this.presence.destroy();
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
