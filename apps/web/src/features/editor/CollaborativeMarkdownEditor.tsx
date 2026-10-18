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
 */
import { defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

import type { CollaborativeSession } from '@insighthub/shared';

import { createCollabTextBinding, type CollabTextBinding } from './collabTextBinding.js';
import { createCodeMirrorSurface } from './codeMirrorSurface.js';
import { publishEditorPresence } from './editorPresence.js';
import { remoteCursors } from './remoteCursorExtension.js';

export interface CollaborativeMarkdownEditorProps {
  /** An `active` session. The caller narrows `CollaborativeSessionResult` first. */
  session: CollaborativeSession;
  /** Optional handle so a parent can flush pending edits before tearing down. */
  bindingRef?: (binding: CollabTextBinding | null) => void;
  /** Diagnostics: called when the binding had to resync wholesale. */
  onResync?: (reason: string) => void;
}

const editorTheme = EditorView.theme({
  '&': { fontSize: '14px' },
  '.cm-content': { minHeight: '320px' },
});

/** The remote-cursor compartment's initial (empty) content. */
const noCursors: Extension = [];

export function CollaborativeMarkdownEditor({
  session,
  bindingRef,
  onResync,
}: CollaborativeMarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Callbacks are held in refs so a new inline arrow from the parent cannot tear
  // down and rebuild the editor.
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;
  const bindingRefCb = useRef(bindingRef);
  bindingRefCb.current = bindingRef;

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
          binding?.handleLocalChanges(changes);
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

    // 2. Build the view from `Y.Text` content, so the editor opens on the truth
    //    instead of an empty buffer that would be resynced a moment later.
    const cursorExtension = new Compartment();
    const state = EditorState.create({
      doc: session.text.toString(),
      extensions: [
        cursorExtension.of(noCursors),
        lineNumbers(),
        keymap.of([
          // The session's UndoManager, not CodeMirror history: see the module note.
          { key: 'Mod-z', run: () => (session.undo(), true) },
          { key: 'Mod-Shift-z', run: () => (session.redo(), true) },
          { key: 'Mod-y', run: () => (session.redo(), true) },
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
      viewRef.current = null;
      view.destroy();
    };
  }, [session]);

  return <div className="markdown-editor" ref={hostRef} data-testid="markdown-editor" />;
}
