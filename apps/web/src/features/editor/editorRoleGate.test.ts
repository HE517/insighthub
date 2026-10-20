/**
 * Role → gate → editor, for the four states that matter (closes A7 F1's UI half).
 *
 * ## What is real here
 *
 * - a **real** `Y.Doc` / `Y.Text` and a **real** `Y.Text ⇄ surface` binding
 *   (`createCollabTextBinding`) — the path a keystroke takes;
 * - the **real** `FakeCollaborativeSession`, whose `setRole()` announces through the
 *   existing `subscribe()` channel (`docs/CONTRACTS.md` §17.9 rule 4), so the test can
 *   drive a promotion/demotion without a socket;
 * - the **real** `selectRole` selector (the one `useSessionRole` is built on) and the
 *   **real** `capabilityGate` + `editorEditability` / `deliverLocalChanges`;
 * - CodeMirror's **real** state layer (`EditorState`, `Compartment`) for the read-only flags.
 *
 * ## What is NOT real here (and is not claimed)
 *
 * No DOM: `@codemirror/view`'s `EditorView` needs `document.createElement`, and this
 * workspace's Vitest environment is `node` with no jsdom. So:
 *
 * - "typing does not change `Y.Text`" is proven at the **delivery** layer (an
 *   editor-reported change is refused and the surface is re-aligned) and at the **state**
 *   layer (`EditorState.readOnly`, the facet CodeMirror's own input handlers consult). The
 *   keystroke-to-DOM path itself is browser evidence and belongs to A6.
 * - "the gate updates without remounting the editor" is proven as: the session object is
 *   the same object, no new session is created, and the read-only flip is a `Compartment`
 *   **reconfiguration of an existing state** — the same expression `CollaborativeMarkdownEditor`
 *   dispatches on `readOnly` change. Observing the real DOM keep its `.cm-editor` is A6's job.
 */
import { describe, expect, it, vi } from 'vitest';

import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { capabilityGate } from '../permissions/capabilityGate.js';
import { createCollabTextBinding, type CollabTextBinding } from './collabTextBinding.js';
import { deliverLocalChanges, editorEditability, runSessionHistory } from './editorEditability.js';
import type { EditorTextSurface } from './editorTextSurface.js';
import {
  createFakeCollaborativeSession,
  type FakeCollaborativeSession,
} from './testing/fakeCollaborativeSession.js';
import { selectRole } from './useCollaborativeSession.js';
import type { TextChange } from './textDiff.js';

const USER = { id: 'me', name: 'Me' };

function createSession(initialText = 'hello'): FakeCollaborativeSession {
  return createFakeCollaborativeSession({ documentId: 'role-gate', user: USER, initialText });
}

/** A DOM-free surface, exactly like the binding unit tests use. */
class InMemorySurface implements EditorTextSurface {
  constructor(public text: string) {}
  getText(): string {
    return this.text;
  }
  hasText(text: string): boolean {
    return this.text === text;
  }
  applyDelta(changes: readonly TextChange[]): void {
    let offset = 0;
    for (const change of changes) {
      const from = change.from + offset;
      const to = change.to + offset;
      this.text = this.text.slice(0, from) + change.insert + this.text.slice(to);
      offset += change.insert.length - (change.to - change.from);
    }
  }
  setText(text: string): void {
    this.text = text;
  }
  getRange(): { anchor: number; head: number } {
    return { anchor: 0, head: 0 };
  }
}

function bind(session: FakeCollaborativeSession): {
  binding: CollabTextBinding;
  surface: InMemorySurface;
} {
  const surface = new InMemorySurface(session.text.toString());
  const binding = createCollabTextBinding(
    {
      text: session.text,
      doc: session.doc,
      transact: (fn, origin) => session.transact(fn, origin),
    },
    surface,
  );
  return { binding, surface };
}

/** The gate the workspace computes: session role → gate. One source, no second table. */
function gateOf(session: FakeCollaborativeSession) {
  return capabilityGate(selectRole(session));
}

/** A keystroke at the end of the document, as CodeMirror reports it. */
function keystroke(session: FakeCollaborativeSession, insert: string): TextChange {
  const end = session.text.length;
  return { from: end, to: end, insert };
}

describe('editable roles: owner and editor', () => {
  for (const role of ['owner', 'editor'] as const) {
    it(`keeps the editor editable and shows no read-only notice for ${role}`, () => {
      const session = createSession();
      session.setRole(role);

      const gate = gateOf(session);
      expect(gate.known).toBe(true);
      expect(gate.role).toBe(role);
      expect(gate.readOnly).toBe(false);

      // The CodeMirror state the editor is built from is editable.
      const state = EditorState.create({
        doc: session.text.toString(),
        extensions: [editorEditability(gate.readOnly)],
      });
      expect(state.readOnly).toBe(false);
      expect(state.facet(EditorView.editable)).toBe(true);

      // And a keystroke reaches `Y.Text` exactly as before (no regression).
      const { binding, surface } = bind(session);
      const outcome = deliverLocalChanges(gate.readOnly, binding, [keystroke(session, '!')]);
      expect(outcome).toBe('applied');
      expect(session.text.toString()).toBe('hello!');

      surface.text = 'hello!';
      binding.destroy();
      session.destroy();
    });
  }
});

describe('viewer', () => {
  it('is read-only and refuses to write local text into Y.Text', () => {
    const session = createSession();
    session.setRole('viewer');

    const gate = gateOf(session);
    expect(gate.readOnly).toBe(true);

    // 1. CodeMirror is configured read-only: `EditorState.readOnly` is the facet its input
    //    handlers (typing / paste / drop) consult, and `EditorView.editable` makes the DOM
    //    non-editable. Both are what `CollaborativeMarkdownEditor` installs for this state.
    const state = EditorState.create({
      doc: session.text.toString(),
      extensions: [editorEditability(gate.readOnly)],
    });
    expect(state.readOnly).toBe(true);
    expect(state.facet(EditorView.editable)).toBe(false);

    // 2. Even if an editor-reported change reached the delivery path, it never becomes a
    //    Y.Text change: the local replica cannot silently fork from what the server accepted.
    const { binding, surface } = bind(session);
    const outcome = deliverLocalChanges(gate.readOnly, binding, [keystroke(session, 'nope')]);
    expect(outcome).toBe('blocked');
    expect(session.text.toString()).toBe('hello');

    // The surface is re-aligned with the authoritative text, so nothing the document lacks
    // stays on screen as if it were saved.
    expect(surface.getText()).toBe('hello');

    // 3. Remote edits still flow into a read-only viewer (§17.5: SYNC reads need `canRead`).
    session.applyRemoteText((text) => text.insert(0, 'REMOTE '));
    expect(surface.getText()).toBe('REMOTE hello');

    binding.destroy();
    session.destroy();
  });

  it('ignores an empty change report instead of resyncing (selection-only updates)', () => {
    const session = createSession();
    session.setRole('viewer');
    const { binding } = bind(session);

    expect(deliverLocalChanges(gateOf(session).readOnly, binding, [])).toBe('ignored');
    expect(session.text.toString()).toBe('hello');

    binding.destroy();
    session.destroy();
  });
});

describe('unknown role (null) must never lock the editor', () => {
  it('keeps the editor fully usable and shows no read-only notice', () => {
    // The fake defaults to `null` and never volunteers `viewer`/`editor` (§17.9 rule 1).
    const session = createSession();
    expect(session.getRole()).toBeNull();

    const gate = gateOf(session);
    expect(gate.known).toBe(false);
    expect(gate.role).toBeNull();
    // The case that would silently break users: `null` read as "viewer" locks a user out of
    // their own unsent text (AGENTS.md R10, CONTRACTS §17.9 gating consequence).
    expect(gate.readOnly).toBe(false);

    const state = EditorState.create({
      doc: session.text.toString(),
      extensions: [editorEditability(gate.readOnly)],
    });
    expect(state.readOnly).toBe(false);
    expect(state.facet(EditorView.editable)).toBe(true);

    const { binding, surface } = bind(session);
    expect(deliverLocalChanges(gate.readOnly, binding, [keystroke(session, ' offline')])).toBe(
      'applied',
    );
    expect(session.text.toString()).toBe('hello offline');

    surface.text = 'hello offline';
    expect(surface.getText()).toBe(session.text.toString());

    binding.destroy();
    session.destroy();
  });

  it('treats a role the session could not parse as unknown, not as read-only', () => {
    // The double only accepts `DocumentRole | null`; `null` is exactly what the real seam
    // reports for an unparseable `room-joined.role` (§17.9 rule 1). Going back to unknown
    // (e.g. after a room ends) must re-open the editor, never lock it.
    const session = createSession();
    session.setRole('viewer');
    expect(gateOf(session).readOnly).toBe(true);

    session.setRole(null);
    expect(gateOf(session).readOnly).toBe(false);
    expect(gateOf(session).known).toBe(false);

    session.destroy();
  });
});

describe('a role change announced through the existing subscription', () => {
  it('updates the gate without creating a second session or rebuilding the editor state', () => {
    const session = createSession();
    const subscribe = vi.spyOn(session, 'subscribe');
    let notifications = 0;
    const unsubscribe = session.subscribe(() => {
      notifications += 1;
    });

    // The editor is built once and keeps its own `EditorState` + compartment.
    const compartment = new Compartment();
    let state = EditorState.create({
      doc: session.text.toString(),
      extensions: [compartment.of(editorEditability(gateOf(session).readOnly))],
    });
    expect(state.readOnly).toBe(false);

    // Owner first: editable.
    session.setRole('owner');
    expect(notifications).toBe(1);
    expect(gateOf(session).readOnly).toBe(false);

    // Demotion to viewer: same session object, same state object updated in place through
    // the compartment — this is the expression the editor's `readOnly` effect dispatches.
    session.setRole('viewer');
    expect(notifications).toBe(2);
    expect(gateOf(session).readOnly).toBe(true);
    state = state.update({
      effects: compartment.reconfigure(editorEditability(gateOf(session).readOnly)),
    }).state;
    expect(state.readOnly).toBe(true);
    expect(state.facet(EditorView.editable)).toBe(false);

    // Promotion back: the same state flips to editable again.
    session.setRole('editor');
    expect(notifications).toBe(3);
    expect(gateOf(session).readOnly).toBe(false);
    state = state.update({
      effects: compartment.reconfigure(editorEditability(gateOf(session).readOnly)),
    }).state;
    expect(state.readOnly).toBe(false);
    expect(state.facet(EditorView.editable)).toBe(true);

    // One subscription for the whole role lifecycle: no second mechanism was invented
    // (§17.9 rule 4). `useSessionRole` reuses `createSessionStore`, which subscribes once.
    expect(subscribe).toHaveBeenCalledTimes(1);

    unsubscribe();
    session.destroy();
  });

  it('keeps unsent text in the Y.Doc when the user is demoted', () => {
    const session = createSession();
    session.setRole('editor');
    const { binding, surface } = bind(session);

    // Typed while allowed: the text is in `Y.Text` (this editor has no staging buffer).
    expect(
      deliverLocalChanges(gateOf(session).readOnly, binding, [keystroke(session, ' unsent')]),
    ).toBe('applied');
    surface.text = 'hello unsent';
    expect(session.text.toString()).toBe('hello unsent');

    // Demotion: the gate flips to read-only, and nothing may delete what is already in the doc.
    session.setRole('viewer');
    expect(gateOf(session).readOnly).toBe(true);

    // Further typing is refused...
    expect(
      deliverLocalChanges(gateOf(session).readOnly, binding, [keystroke(session, ' more')]),
    ).toBe('blocked');
    // ...and the earlier text survives, because the demotion reconfigured the editor instead
    // of rebuilding it (and `deliverLocalChanges` never deletes).
    expect(session.text.toString()).toBe('hello unsent');
    expect(surface.getText()).toBe('hello unsent');

    binding.destroy();
    session.destroy();
  });
});

describe('session-level undo is a local write and follows the same flag', () => {
  it('runs the session undo for an editable role', () => {
    const session = createSession();
    session.setRole('editor');
    session.transact((text) => text.insert(5, ' typed'));
    expect(session.text.toString()).toBe('hello typed');

    expect(runSessionHistory(gateOf(session).readOnly, session, 'undo')).toBe(true);
    expect(session.text.toString()).toBe('hello');

    session.destroy();
  });

  it('refuses to undo while read-only, so a viewer cannot mutate Y.Text from the keyboard', () => {
    // Reachable state: the text was typed while the role was unknown or editor, the user is
    // read-only now (e.g. after a rejoin that reported a lower role) and presses Ctrl+Z. The
    // session's `Y.UndoManager` would happily remove it — that is a local Y.Text write the
    // server refuses for a viewer, i.e. a fork.
    const session = createSession();
    session.setRole('editor');
    session.transact((text) => text.insert(5, ' typed'));
    const undo = vi.spyOn(session, 'undo');
    const redo = vi.spyOn(session, 'redo');

    session.setRole('viewer');
    expect(gateOf(session).readOnly).toBe(true);

    // Handled (the key is swallowed) but nothing ran and nothing changed.
    expect(runSessionHistory(gateOf(session).readOnly, session, 'undo')).toBe(true);
    expect(runSessionHistory(gateOf(session).readOnly, session, 'redo')).toBe(true);
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(session.text.toString()).toBe('hello typed');

    session.destroy();
  });
});
