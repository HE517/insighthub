/**
 * Tests for the CodeMirror surface adapter.
 *
 * `EditorView` itself cannot be constructed in a node environment (it calls
 * `document.createElement`), so the *view construction* and the `EditorView`
 * update flow are verified in the browser/E2E pass (M1-A6). What is verified here
 * is everything the adapter decides: how a `ViewUpdate`'s changes become the
 * binding's deltas, and that a remote change becomes exactly one `dispatch` with
 * the selection mapped.
 *
 * The view is a structural stand-in that records the transaction specs it is
 * asked to apply. It is not a CodeMirror simulation — it is a recorder.
 */
import { ChangeSet, EditorSelection, Text, type ChangeSpec } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

import {
  createCodeMirrorSurface,
  remoteSyncAnnotation,
  type CodeMirrorSurface,
} from './codeMirrorSurface.js';

interface DispatchRecord {
  changes?: ChangeSpec | readonly ChangeSpec[];
  selection?: EditorSelection;
}

/** A recorder in the shape of the parts of `EditorView` the adapter touches. */
class FakeView {
  readonly dispatches: DispatchRecord[] = [];
  state: { doc: Text; selection: EditorSelection };

  constructor(doc: string, selection?: EditorSelection) {
    const text = Text.of(doc.split('\n'));
    this.state = {
      doc: text,
      selection: selection ?? EditorSelection.single(0),
    };
  }

  dispatch(spec: DispatchRecord): void {
    this.dispatches.push(spec);

    // Apply the change and the selection the way a real view would by the time
    // the next reader runs.
    if (spec.changes === undefined) {
      if (spec.selection !== undefined) {
        this.state = { ...this.state, selection: spec.selection };
      }
      return;
    }

    const specs = Array.isArray(spec.changes) ? spec.changes : [spec.changes];
    const changeSet = ChangeSet.of(specs, this.state.doc.length);
    this.state = {
      doc: changeSet.apply(this.state.doc),
      selection: spec.selection ?? this.state.selection.map(changeSet),
    };
  }

  asView(): EditorView {
    return this as unknown as EditorView;
  }
}

function createSurface(doc: string, selection?: EditorSelection) {
  const view = new FakeView(doc, selection);
  const onLocalChanges = vi.fn();
  const onSelectionChange = vi.fn();
  let current: FakeView | null = view;

  const cm: CodeMirrorSurface = createCodeMirrorSurface(() => current?.asView() ?? null, {
    onLocalChanges,
    onSelectionChange,
  });

  return { view, cm, onLocalChanges, onSelectionChange, detach: () => (current = null) };
}

describe('createCodeMirrorSurface', () => {
  it('reads the current document text', () => {
    const { cm } = createSurface('hello\nworld');
    expect(cm.surface.getText()).toBe('hello\nworld');
  });

  it('reports a single remote change as one dispatch', () => {
    const { cm, view } = createSurface('hello');

    cm.surface.applyDelta([{ from: 5, to: 5, insert: ' world' }]);

    expect(view.dispatches).toHaveLength(1);
    expect(view.dispatches[0]!.changes).toEqual([{ from: 5, to: 5, insert: ' world' }]);
    expect(cm.surface.getText()).toBe('hello world');
  });

  it('applies a multi-change delta as one transaction, mapped in order', () => {
    const { cm, view } = createSurface('abcdef');

    // The reconcile path normally emits a single change, but the surface contract
    // allows a batch, so both spec offsets are mapped through the preceding ones
    // in one transaction (one render, not two).
    cm.surface.applyDelta([
      { from: 1, to: 2, insert: '' },
      { from: 4, to: 4, insert: 'X' },
    ]);

    expect(view.dispatches).toHaveLength(1);
    expect(view.dispatches[0]!.changes).toEqual([
      { from: 1, to: 2, insert: '' },
      { from: 4, to: 4, insert: 'X' },
    ]);
    // The result is CodeMirror's own mapping of the batch, asserted so a change
    // in that mapping is noticed rather than silently accepted.
    const expected = ChangeSet.of(
      [
        { from: 1, to: 2, insert: '' },
        { from: 4, to: 4, insert: 'X' },
      ],
      6,
    )
      .apply(Text.of(['abcdef']))
      .toString();
    expect(cm.surface.getText()).toBe(expected);
  });

  it('maps the selection through a remote change instead of leaving a stale caret', () => {
    const { cm, view } = createSurface('hello', EditorSelection.single(5));

    cm.surface.applyDelta([{ from: 0, to: 0, insert: 'X' }]);

    expect(view.state.selection.main.head).toBe(6);
  });

  it('clamps an out-of-range remote change instead of throwing', () => {
    const { cm, view } = createSurface('hello');

    // A peer can legitimately be ahead of us. This must degrade to a bounded
    // edit; throwing here would escape into the Yjs observer.
    expect(() => cm.surface.applyDelta([{ from: 3, to: 99, insert: 'Y' }])).not.toThrow();

    expect(view.dispatches[0]!.changes).toEqual([{ from: 3, to: 5, insert: 'Y' }]);
    expect(cm.surface.getText()).toBe('helY');
  });

  it('ignores a nil view rather than throwing during teardown', () => {
    const { cm, detach, view } = createSurface('hello');
    detach();

    expect(() => cm.surface.applyDelta([{ from: 0, to: 0, insert: 'X' }])).not.toThrow();
    expect(() => cm.surface.setText('other')).not.toThrow();
    expect(view.dispatches).toHaveLength(0);
    expect(cm.surface.getRange()).toEqual({ anchor: 0, head: 0 });
  });

  it('replaces the whole document in one dispatch for a resync', () => {
    const { cm, view } = createSurface('stale');

    cm.surface.setText('authoritative');

    expect(view.dispatches).toHaveLength(1);
    expect(cm.surface.getText()).toBe('authoritative');
    // The caret cannot be preserved across a wholesale replace safely.
    expect(view.state.selection.main.head).toBe(0);
  });

  it('reports the current selection range', () => {
    const { cm } = createSurface('hello', EditorSelection.single(2, 4));
    expect(cm.surface.getRange()).toEqual({ anchor: 2, head: 4 });
  });

  it('converts a local update into binding deltas and a selection notification', () => {
    const { cm, onLocalChanges, onSelectionChange } = createSurface('hello');

    // Simulate what CodeMirror passes to the update listener, including the empty
    // transaction list a real `ViewUpdate` always carries.
    const changes = ChangeSet.of({ from: 5, to: 5, insert: '!' }, 5);
    const doc = changes.apply(Text.of(['hello']));
    const update = {
      docChanged: true,
      selectionSet: false,
      changes,
      transactions: [],
      state: { doc, selection: EditorSelection.single(6) },
    } as unknown as ViewUpdate;

    cm.invokeUpdateListener(update);

    expect(onLocalChanges).toHaveBeenCalledWith([{ from: 5, to: 5, insert: '!' }]);
    expect(onSelectionChange).toHaveBeenCalledWith({ anchor: 6, head: 6 });
  });

  it('does not report a delta when nothing changed', () => {
    const { cm, onLocalChanges, onSelectionChange } = createSurface('hello');

    const update = {
      docChanged: false,
      selectionSet: false,
      changes: ChangeSet.empty(5),
      state: { doc: Text.of(['hello']), selection: EditorSelection.single(0) },
    } as unknown as ViewUpdate;

    cm.invokeUpdateListener(update);

    expect(onLocalChanges).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('does not report a change that carries the remote-sync annotation', () => {
    // This is what stops `session.undo()` (or any remote update) from being
    // re-recorded as a new local edit: the binding marks its own dispatches, and
    // the adapter must therefore stay silent about them.
    const { cm, onLocalChanges } = createSurface('hello');

    const changes = ChangeSet.of({ from: 5, to: 5, insert: 'Z' }, 5);
    const update = {
      docChanged: true,
      selectionSet: false,
      changes,
      transactions: [{ annotation: (type: unknown) => type === remoteSyncAnnotation }],
      state: { doc: changes.apply(Text.of(['hello'])), selection: EditorSelection.single(6) },
    } as unknown as ViewUpdate;

    cm.invokeUpdateListener(update);

    expect(onLocalChanges).not.toHaveBeenCalled();
  });

  it('reports an unannotated user change', () => {
    const { cm, onLocalChanges } = createSurface('hello');

    const changes = ChangeSet.of({ from: 5, to: 5, insert: 'Z' }, 5);
    const update = {
      docChanged: true,
      selectionSet: false,
      changes,
      transactions: [{ annotation: () => undefined }],
      state: { doc: changes.apply(Text.of(['hello'])), selection: EditorSelection.single(6) },
    } as unknown as ViewUpdate;

    cm.invokeUpdateListener(update);

    expect(onLocalChanges).toHaveBeenCalledWith([{ from: 5, to: 5, insert: 'Z' }]);
  });
});
