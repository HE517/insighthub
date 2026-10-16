/**
 * CodeMirror 6 adapter for the collaboration binding.
 *
 * This is the only file in the editor feature that touches CodeMirror's view
 * layer. It converts `ViewUpdate` objects into the small `EditorTextSurface` the
 * binding understands, and back again. Keeping the adapter thin is deliberate:
 * `EditorView` cannot be constructed without a DOM, so everything
 * decision-worthy lives in `collabTextBinding.ts`, where it is unit-testable.
 */
import {
  Annotation,
  ChangeSet,
  EditorSelection,
  Text,
  type ChangeSpec,
  type Extension,
} from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';

import type { EditorTextSurface } from './editorTextSurface.js';
import { REMOTE_SYNC_ORIGIN } from './syncOrigin.js';
import type { TextChange } from './textDiff.js';

/**
 * Annotation used to mark a transaction as derived from `Y.Text`.
 *
 * Declared here (the `@codemirror/state`-aware module) and handed to
 * `createCodeMirrorSurface`, so the binding can pass an opaque origin without
 * importing CodeMirror.
 */
export const remoteSyncAnnotation = Annotation.define<boolean>();

export interface CodeMirrorSurfaceOptions {
  /** Called with the changes of each local (editor-originated) update. */
  onLocalChanges(changes: readonly TextChange[]): void;
  /** Called with the local selection after each update, for awareness publishing. */
  onSelectionChange?(selection: { anchor: number; head: number }): void;
}

export interface CodeMirrorSurface {
  surface: EditorTextSurface;
  /**
   * Must be part of the view's initial extensions, so no update can happen
   * before the binding is listening.
   */
  extension: Extension;
  /**
   * The update handler behind `extension`, exposed so its translation rules can be
   * exercised directly: `EditorView` cannot be constructed in a node test
   * environment, and this handler is where the adapter's logic lives.
   */
  invokeUpdateListener(update: ViewUpdate): void;
}

/**
 * Wire an `EditorView` to the binding.
 *
 * `getView` is a thunk rather than the view itself because the extension has to
 * exist before `new EditorView(...)` does — the usual circular construction of a
 * CodeMirror integration.
 */
export function createCodeMirrorSurface(
  getView: () => EditorView | null,
  options: CodeMirrorSurfaceOptions,
): CodeMirrorSurface {
  const { onLocalChanges, onSelectionChange } = options;

  const handleUpdate = (update: ViewUpdate): void => {
    if (update.docChanged) {
      // A change this binding dispatched *because* of `Y.Text` is not a user edit:
      // reporting it would re-record an undo or a remote update as a local change
      // (see `REMOTE_SYNC_ORIGIN` in `syncOrigin.ts`).
      //
      // `update.transactions` is always present on a real `ViewUpdate`; the
      // optional chain only protects the structural test double used to exercise
      // this translation without a DOM.
      const derivedFromCollab =
        update.transactions?.some(
          (transaction) => transaction.annotation(remoteSyncAnnotation) === true,
        ) ?? false;

      if (!derivedFromCollab) {
        const changes: TextChange[] = [];
        update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          changes.push({ from: fromA, to: toA, insert: inserted.toString() });
        });
        if (changes.length > 0) onLocalChanges(changes);
      }
    }

    if (update.docChanged || update.selectionSet) {
      const range = update.state.selection.main;
      onSelectionChange?.({ anchor: range.anchor, head: range.head });
    }
  };

  const extension = EditorView.updateListener.of(handleUpdate);

  const surface: EditorTextSurface = {
    getText(): string {
      return getView()?.state.doc.toString() ?? '';
    },

    hasText(text: string): boolean {
      // `Text.eq` avoids materialising the document as a string, which is what
      // makes this cheap enough to call on every remote update.
      return getView()?.state.doc.eq(Text.of(text.split('\n'))) ?? text.length === 0;
    },

    applyDelta(changes: readonly TextChange[], origin?: unknown): void {
      const view = getView();
      if (view === null || changes.length === 0) return;

      const docLength = view.state.doc.length;
      // Clamp defensively: a wrong offset must degrade to a bounded change, never
      // to a CodeMirror range error thrown inside a Yjs observer.
      const specs: ChangeSpec[] = [];
      for (const change of changes) {
        const from = clamp(change.from, 0, docLength);
        const to = clamp(change.to, from, docLength);
        specs.push({ from, to, insert: change.insert });
      }

      view.dispatch({
        changes: specs,
        annotations: annotationsFor(origin),
        // Yjs offsets are positions in the result being built (`sequential`
        // semantics), and `ChangeSet.of` maps each spec through the preceding
        // ones. `sequential: true` would reinterpret each later offset in the
        // already-modified document and land it in the wrong place.
        // Map the selection explicitly so a remote edit can never move the local
        // caret to a stale offset.
        selection: view.state.selection.map(ChangeSet.of(specs, docLength)),
      });
    },

    setText(text: string, origin?: unknown): void {
      const view = getView();
      if (view === null) return;
      // One transaction for the whole document: a resync is rare and must not be
      // O(document) separate dispatches.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: annotationsFor(origin),
        // The caret cannot be preserved meaningfully across a wholesale replace,
        // and the previous offset may no longer exist.
        //
        // `EditorSelection.single`, NOT `EditorSelection.cursor`: the latter is
        // typed as returning an `EditorSelection` but returns a bare
        // `SelectionRange` at runtime (verified against the installed
        // `@codemirror/state` 6.7.6 bundle), which a dispatch rejects as a
        // selection spec.
        selection: EditorSelection.single(0),
      });
    },

    getRange(): { anchor: number; head: number } {
      const view = getView();
      if (view === null) return { anchor: 0, head: 0 };
      const range = view.state.selection.main;
      return { anchor: range.anchor, head: range.head };
    },
  };

  return { surface, extension, invokeUpdateListener: handleUpdate };
}

/**
 * Translate the binding's opaque origin marker into a CodeMirror annotation.
 *
 * The binding cannot import CodeMirror, so it passes the `REMOTE_SYNC_ORIGIN`
 * sentinel; anything else (including `undefined`) yields no annotation, i.e.
 * "treat this as a user edit".
 */
function annotationsFor(origin: unknown): Annotation<boolean>[] | undefined {
  if (origin === REMOTE_SYNC_ORIGIN) return [remoteSyncAnnotation.of(true)];
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
