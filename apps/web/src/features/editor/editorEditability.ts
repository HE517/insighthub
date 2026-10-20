/**
 * "May this editor accept local edits right now?" — and the two places that answer is
 * enforced.
 *
 * ## Why this module exists
 *
 * `docs/CONTRACTS.md` §17.9 requires the editor to be read-only for a **known** role without
 * `canEdit`, fully usable for `owner`/`editor`, and fully usable while the role is UNKNOWN
 * (`null` never locks a user out of their own unsent text). The decision itself is made in
 * exactly one place — `features/permissions/capabilityGate.ts` — and this module is the
 * delivery of that decision into the editor, in two layers:
 *
 * 1. **CodeMirror configuration** (`editorEditability`): `EditorState.readOnly` is the facet
 *    CodeMirror's own input handlers consult (typing, paste, drop), and `EditorView.editable`
 *    makes the DOM non-editable so the browser refuses the keystroke before it is a
 *    transaction. Programmatic transactions are *not* affected: remote `Y.Text` updates keep
 *    flowing into a read-only viewer, which is what §17.5's `canRead`-only sync requires.
 * 2. **Change delivery** (`deliverLocalChanges`): the `Y.Text` write path refuses an
 *    editor-reported change while the gate says read-only, and re-aligns the surface with the
 *    authoritative `Y.Text` instead. CodeMirror already blocks the input, so this layer should
 *    never fire; it exists so a UI guess can never become a silent local fork that the server
 *    then rejects (the defect recorded in `docs/DECISIONS.md` D-064 §2 item 3).
 * 3. **History commands** (`runSessionHistory`): `Mod-z` / `Mod-Shift-z` / `Mod-y` are bound to
 *    the session's `Y.UndoManager`, not to CodeMirror history, so they need the flag too — an
 *    undo is a local `Y.Text` write like any other (`AGENTS.md` R13).
 *
 * ## What this is not
 *
 * Not a security boundary (`docs/ARCHITECTURE.md` §8.2): the server rejects unauthorised
 * mutations before apply/persist/broadcast (§17.5). Everything here only decides which
 * controls the UI shows and what the local replica does with a keystroke the server would
 * refuse anyway.
 *
 * ## Why the read-only state is a reconfigured compartment, never a rebuilt editor
 *
 * A demotion must not destroy the editor: the local `Y.Doc` may hold text the user typed
 * before the demotion and nothing may delete it. So the editor is created **once per
 * session** and the read-only flags are swapped through a `Compartment` (see
 * `CollaborativeMarkdownEditor.tsx`), which is a state reconfiguration, not a remount.
 */
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import type { CollaborativeSession } from '@insighthub/shared';

import type { CollabTextBinding } from './collabTextBinding.js';
import type { TextChange } from './textDiff.js';

/**
 * The CodeMirror extensions that make a view editable or read-only.
 *
 * Both facets are set for a reason: `EditorState.readOnly` is what commands and the
 * built-in input handlers check, and `EditorView.editable` turns the content element into
 * non-editable DOM so the browser does not even produce the input event. Setting only the
 * first still lets the DOM accept a keystroke and then drop it, which looks broken; setting
 * only the second leaves programmatic commands (a pasted `Mod-z` handler, an IME path) able
 * to mutate the document.
 */
export function editorEditability(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/** What happened to an editor-reported change. Returned for tests and diagnostics. */
export type LocalEditDelivery = 'applied' | 'blocked' | 'ignored';

/**
 * The session-level undo/redo the editor's keymap runs (`Mod-z` / `Mod-Shift-z` / `Mod-y`).
 *
 * ## Why this needs the same read-only flag
 *
 * Undo is **not** a CodeMirror history operation here: it is `session.undo()`, which mutates
 * `Y.Text` through the session's `Y.UndoManager` (`AGENTS.md` R13). `@codemirror/commands`
 * consults `EditorState.readOnly` before its own editing commands, but a hand-written keymap
 * binding does not inherit that check — so without this function a read-only viewer could
 * still delete their own earlier text with `Ctrl+Z`, producing exactly the local Yjs write the
 * gate is supposed to stop (and which the server refuses, leaving a fork).
 *
 * Returns `true` in both cases: the key is *handled*. In the read-only case it is handled by
 * doing nothing, so the keystroke cannot fall through to a browser default and cannot be
 * mistaken for an unhandled shortcut.
 */
export function runSessionHistory(
  readOnly: boolean,
  port: Pick<CollaborativeSession, 'undo' | 'redo'>,
  direction: 'undo' | 'redo',
): boolean {
  if (readOnly) return true;
  if (direction === 'undo') port.undo();
  else port.redo();
  return true;
}

/**
 * Route an editor-reported local change to `Y.Text`, or refuse it while read-only.
 *
 * - `applied` — the change is in `Y.Text` (`owner` / `editor`, and the unknown-role state);
 * - `blocked` — the gate says read-only: nothing is written, and the surface is re-aligned
 *   with the authoritative `Y.Text` so the editor cannot show content the document lacks;
 * - `ignored` — an empty report, which is what CodeMirror sends for a pure selection change.
 *
 * Blocking never deletes anything from the `Y.Doc`. Content that reached `Y.Text` before a
 * demotion stays there (requirement: a demotion must not destroy unsent local text); the
 * resync copies that text *into* the editor, it does not clear the editor.
 */
export function deliverLocalChanges(
  readOnly: boolean,
  binding: Pick<CollabTextBinding, 'handleLocalChanges' | 'resync'>,
  changes: readonly TextChange[],
): LocalEditDelivery {
  if (changes.length === 0) return 'ignored';

  if (readOnly) {
    // Second line of defence: the surface should not have changed at all. If it did, show
    // the truth again rather than letting a reader accumulate text the server will refuse.
    binding.resync('read-only-role');
    return 'blocked';
  }

  binding.handleLocalChanges(changes);
  return 'applied';
}
