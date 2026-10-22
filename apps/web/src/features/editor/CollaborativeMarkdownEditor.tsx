/**
 * The collaborative Markdown surface: CodeMirror 6 bound to `session.text`.
 *
 * ## Source of truth
 *
 * The editor is a *view* of `Y.Text`. The only string this component ever holds
 * is the one it reads at construction time to seed the buffer; afterwards every
 * change flows in one of exactly two directions:
 *
 * ```
 * keystroke      → CodeMirror → binding.handleLocalChanges → session.transact → Y.Text
 * remote Y.Text  → binding observer → CodeMirror delta transaction
 * ```
 *
 * There is no `value` prop, no `onChange(value: string)` callback and no
 * `useState(text)`: each of those would be the mirrored body that
 * `docs/ARCHITECTURE.md` §0 forbids and that `AGENTS.md` R11 makes a defect.
 *
 * ## Why the editor is created in an effect and never in render
 *
 * `EditorView` needs a real DOM node, so creating it during render would build
 * (and leak) a view on every render — including renders caused by a collaborator
 * joining or a connection badge flipping. One effect, keyed on the *session*
 * object: one view per document, remounted only when the document really changes.
 *
 * ## Why the binding is created before the view
 *
 * The `Y.Text` observer must exist before the view can produce updates, otherwise
 * a remote change landing during construction would be missed (the observer is
 * not attached yet) and the editor would silently diverge. Creating the observer
 * first closes that window; the view's own construction transaction is ignored by
 * the update listener because the binding handle is still `null` at that moment.
 *
 * ## Undo
 *
 * No `history()` extension is installed. Undo is the session's `Y.UndoManager`:
 * `Mod-z` reverts only local/AI-origin edits and can never clobber a
 * collaborator's text (`AGENTS.md` R13). Two undo systems in one editor would be
 * a correctness bug, not a convenience.
 *
 * ## Presence
 *
 * This component publishes its caret through **one** seam call per selection update,
 * `session.publishPresence(...)` (see `editorPresence.ts`). It does not write through
 * `session.awareness` at all: that instance is a CodeMirror binding input only
 * (`AGENTS.md` R14), and it is passed to the remote-cursor extension for that purpose
 * alone. `updatedAt` belongs to the collaboration layer, so A2 neither computes nor
 * sends it (`docs/CONTRACTS.md` §15, M2-P0-2).
 *
 * ## Selection access (read-only)
 *
 * `selectionRef` hands the parent a lazy reader over `EditorState.selection.main`, used by the AI
 * panel at the moment it generates a proposal. It is a **read**, not a callback feed: nothing is
 * dispatched, the view is not touched, and the editor still publishes presence through
 * `publishPresence` at exactly the same points as before.
 *
 * ## Read-only (`readOnly`)
 *
 * The caller passes the one bit `capabilityGate(role).readOnly`, i.e. "a **known** role may
 * not edit" (`docs/CONTRACTS.md` §17.9). It is applied by **reconfiguring a compartment**, so
 * a demotion flips the flags on the existing view without remounting the editor and without
 * touching `Y.Text`: text typed before the demotion stays in the document. The view is
 * created once per session (`[session]`), so this prop must never be added to that effect's
 * dependencies — a role change is not a document change.
 */
import { defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

import type { CollaborativeSession } from '@insighthub/shared';

import { createCollabTextBinding, type CollabTextBinding } from './collabTextBinding.js';
import { createCodeMirrorSurface } from './codeMirrorSurface.js';
import { deliverLocalChanges, editorEditability, runSessionHistory } from './editorEditability.js';
import { publishEditorPresence } from './editorPresence.js';
import { remoteCursors } from './remoteCursorExtension.js';

export interface CollaborativeMarkdownEditorProps {
  /** An `active` session. The caller narrows `CollaborativeSessionResult` first. */
  session: CollaborativeSession;
  /**
   * `true` only when a **known** role without `canEdit` owns this document. `false` for
   * `owner`/`editor` **and** for the unknown role, which must stay editable (R10, §17.9).
   */
  readOnly?: boolean;
  /** Optional handle so a parent can flush pending edits before tearing down. */
  bindingRef?: (binding: CollabTextBinding | null) => void;
  /** Diagnostics: called when the binding had to resync wholesale. */
  onResync?: (reason: string) => void;
  /**
   * Read-only access to the editor's **current selection**, for callers that need it at the moment
   * of an action rather than on every keystroke (the AI panel's "generate from the selection").
   *
   * Called with a lazy reader once the view exists and with `null` on teardown. The reader returns
   * the live `EditorState.selection.main` anchors, or `null` while the view is gone. It never
   * selects, scrolls or dispatches anything, and it is read through a ref exactly like
   * `bindingRef`/`onResync`, so passing a new inline arrow on every parent render cannot rebuild
   * the editor.
   */
  selectionRef?: (read: (() => { anchor: number; head: number } | null) | null) => void;
}

const editorTheme = EditorView.theme({
  '&': { fontSize: '14px' },
  '.cm-content': { minHeight: '320px' },
});

/** The remote-cursor compartment's initial (empty) content. */
const noCursors: Extension = [];

export function CollaborativeMarkdownEditor({
  session,
  readOnly = false,
  bindingRef,
  onResync,
  selectionRef,
}: CollaborativeMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Callbacks are held in refs so a new inline arrow from the parent cannot tear
  // down and rebuild the editor.
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;
  const bindingRefCb = useRef(bindingRef);
  bindingRefCb.current = bindingRef;
  const selectionRefCb = useRef(selectionRef);
  selectionRefCb.current = selectionRef;

  /**
   * The current read-only flag, in a ref for the same reason as the callbacks: the view is
   * built in an effect keyed on `[session]` only, so a change of role must not restart that
   * effect. The ref is updated during render, so both the creation path (initial value) and
   * the delivery guard (latest value) see the truth without re-running the effect.
   */
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  /** Holds `editorEditability(readOnly)`; swapped in place, never rebuilt with the view. */
  const editabilityRef = useRef<Compartment | null>(null);
  if (editabilityRef.current === null) editabilityRef.current = new Compartment();
  const editability = editabilityRef.current;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    /** Set once the view exists; before that, updates are construction noise. */
    let binding: CollabTextBinding | null = null;

    /**
     * The CodeMirror surface is a thin delegate: it resolves the view lazily, so
     * the binding can exist before the view does. Before the view exists every
     * read is empty and every write is a no-op — which is what makes the ordering
     * below safe.
     */
    const { surface, extension: surfaceExtension } = createCodeMirrorSurface(
      () => viewRef.current,
      {
        onLocalChanges: (changes) => {
          // `null` until the view has been constructed: that transaction is the
          // seeding of the buffer from `Y.Text`, not a user edit.
          if (binding === null) return;
          // Read the flag through the ref: the editor is created once per session, so a
          // closure over the first render's prop would freeze the role.
          deliverLocalChanges(readOnlyRef.current, binding, changes);
        },
        onSelectionChange: (range) => {
          if (binding === null) return;
          // One seam call per selection update. The session validates the patch,
          // stamps `updatedAt` and merges it; A2 writes nothing through the raw
          // `Awareness` instance (M2-P0-2, `docs/CONTRACTS.md` §15).
          publishEditorPresence(session, range);
        },
      },
    );

    // 1. Attach the Y.Text observer FIRST (see the module note).
    binding = createCollabTextBinding(
      {
        text: session.text,
        doc: session.doc,
        // Session-owned transaction: this stamps the local origin and keeps undo
        // tracking correct. Direct `text.insert` calls would bypass both.
        transact: (fn, origin) => session.transact(fn, origin),
      },
      surface,
      { onResync: (reason) => onResyncRef.current?.(reason) },
    );
    bindingRefCb.current?.(binding);

    // Read-only selection access for the AI panel. The reader is lazy (`viewRef` is still null
    // here, and only becomes non-null after `new EditorView`), so it always answers from the
    // *current* `EditorState` and never from a snapshot.
    selectionRefCb.current?.(() => {
      const view = viewRef.current;
      if (view === null) return null;
      const range = view.state.selection.main;
      return { anchor: range.anchor, head: range.head };
    });

    // 2. Build the view from `Y.Text` content, so the editor opens on the truth
    //    instead of an empty buffer that would be resynced a moment later.
    const cursorExtension = new Compartment();
    const state = EditorState.create({
      doc: session.text.toString(),
      extensions: [
        // Initial read-only state, from the prop as it stood when the view was created:
        // a document opened by a viewer is read-only from its first keystroke, not a
        // moment later. Later changes go through the reconfigure effect below.
        editability.of(editorEditability(readOnlyRef.current)),
        cursorExtension.of(noCursors),
        lineNumbers(),
        keymap.of([
          // The session's UndoManager, not CodeMirror history: see the module note. These
          // bindings also carry the read-only flag, because `session.undo()` is a local
          // `Y.Text` write that CodeMirror's own `state.readOnly` check cannot see.
          { key: 'Mod-z', run: () => runSessionHistory(readOnlyRef.current, session, 'undo') },
          {
            key: 'Mod-Shift-z',
            run: () => runSessionHistory(readOnlyRef.current, session, 'redo'),
          },
          { key: 'Mod-y', run: () => runSessionHistory(readOnlyRef.current, session, 'redo') },
          ...defaultKeymap,
        ]),
        markdown(),
        EditorView.lineWrapping,
        editorTheme,
        surfaceExtension,
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    // 3. Now that the surface is live, remote cursors may render.
    view.dispatch({
      effects: cursorExtension.reconfigure(
        remoteCursors({
          awareness: session.awareness,
          // The validated accessor, never `awareness.getStates()` (R14).
          getCollaborators: () => session.getCollaborators(),
          localClientId: session.localClientId,
        }),
      ),
    });

    // Publish this client's cursor once, so a peer that joins later sees where we
    // are instead of an empty awareness state.
    const initialRange = view.state.selection.main;
    publishEditorPresence(session, { anchor: initialRange.anchor, head: initialRange.head });

    return () => {
      // Teardown order matters: flush what the user typed, then stop observing
      // Y.Text, then destroy the view. A queued edit must not be dropped, and the
      // view must not be dispatched to after the session has moved on.
      binding?.flushLocalEdits();
      binding?.destroy();
      bindingRefCb.current?.(null);
      selectionRefCb.current?.(null);
      viewRef.current = null;
      view.destroy();
    };
  }, [session]);

  /**
   * Flip the read-only flags on the **existing** view when the gate changes.
   *
   * This is deliberately a separate effect with a primitive dependency: a role change
   * (promotion or demotion) reconfigures a compartment, so the editor keeps its `Y.Doc`
   * binding, its undo history and everything the user already typed. Rebuilding the editor
   * here would be the "remount on permission change" regression, and would risk dropping
   * text that never reached `Y.Text`.
   *
   * On mount this also runs (after the creation effect), dispatching an idempotent
   * reconfiguration of the value the view was just created with.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: editability.reconfigure(editorEditability(readOnly)),
    });
    // `editability` is the per-editor compartment held in a ref: its identity never
    // changes, so the only *behavioural* dependency is the boolean.
  }, [readOnly, editability]);

  return <div className="markdown-editor" ref={hostRef} data-testid="markdown-editor" />;
}
