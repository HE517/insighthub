/**
 * A2 acceptance tests that span the session seam: presence through the validated
 * accessor, offline presentation, and document-switch teardown.
 *
 * Everything here runs against the typed `CollaborativeSession` double
 * (`testing/fakeCollaborativeSession.ts`), because A2 must not wait for A1's
 * implementation (`docs/TASKS.md` M1-A2). The double validates awareness with the
 * same shared schema the real accessor uses, so a malformed-payload assertion
 * here tests the contract rather than the double's leniency.
 */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import {
  DOCUMENT_TEXT_KEY,
  TRANSACTION_ORIGINS,
  type CollaborativeSession,
} from '@insighthub/shared';

import { createCollabTextBinding, type CollabTextBinding } from './collabTextBinding.js';
import type { EditorTextSurface } from './editorTextSurface.js';
import { collectRemoteCursors } from './remoteCursors.js';
import {
  createFakeCollaborativeSession,
  type FakeCollaborativeSession,
} from './testing/fakeCollaborativeSession.js';
import type { TextChange } from './textDiff.js';

const USER = { id: 'me', name: 'Me' };

function createSession(documentId = 'doc-a'): FakeCollaborativeSession {
  return createFakeCollaborativeSession({ documentId, user: USER, initialText: 'hello' });
}

/** The same in-memory surface the binding unit tests use. */
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

function bind(session: CollaborativeSession): {
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

describe('session lifecycle (fake CollaborativeSession)', () => {
  it('is active from local state, with the transport offline', () => {
    const session = createSession();
    // `docs/CONTRACTS.md` §10.1: local state gates `active`; the network never does.
    expect(session.state).toBe('active');
    expect(session.connectionStatus).toBe('offline');
    session.destroy();
  });

  it('exposes Y.Text as the single source of truth, seeded with local content', () => {
    const session = createSession();
    expect(session.text.toString()).toBe('hello');
    expect(session.doc.getText(DOCUMENT_TEXT_KEY)).toBe(session.text);
    session.destroy();
  });

  it('keeps editing possible while offline', () => {
    const session = createSession();
    const { binding, surface } = bind(session);

    session.setConnectionStatus('offline');
    binding.handleLocalChanges([{ from: 5, to: 5, insert: ' offline' }]);
    surface.text = 'hello offline';
    binding.flushLocalEdits();

    expect(session.text.toString()).toBe('hello offline');
    expect(session.connectionStatus).toBe('offline');
    session.destroy();
  });

  it('does not let a local undo remove a remote edit', () => {
    const session = createSession();
    session.transact((text) => text.insert(5, ' local'), TRANSACTION_ORIGINS.local);
    session.applyRemoteText((text) => text.insert(0, 'REMOTE '));

    session.undo();

    // The remote prefix survives: undo tracks only local/AI origins (R13).
    expect(session.text.toString().startsWith('REMOTE ')).toBe(true);
    session.destroy();
  });
});

describe('collaborator accessor (R14)', () => {
  it('returns validated collaborators with cursor metadata', () => {
    const session = createSession();
    session.publishRemoteCollaborator(7, {
      user: { id: 'u-7', name: 'Ada', color: '#ff0000' },
      cursor: { anchor: 2, head: 2 },
    });

    const collaborators = session.getCollaborators();
    const ada = collaborators.find((entry) => entry.clientId === 7);
    expect(ada).toBeDefined();
    expect(ada!.user.name).toBe('Ada');
    expect(ada!.cursor).toEqual({ anchor: 2, head: 2 });
    session.destroy();
  });

  it('excludes a malformed awareness payload from the accessor', () => {
    const session = createSession();
    session.publishMalformedAwareness(9, { user: { id: 'u-9' } }); // missing `name`
    session.publishMalformedAwareness(10, 'not-an-object');

    expect(session.getCollaborators().some((entry) => entry.clientId === 9)).toBe(false);
    expect(session.getCollaborators().some((entry) => entry.clientId === 10)).toBe(false);
    session.destroy();
  });

  it('never surfaces a malformed payload as a renderable remote cursor', () => {
    const session = createSession();
    session.publishRemoteCollaborator(7, {
      user: { id: 'u-7', name: 'Ada' },
      cursor: { anchor: 1, head: 1 },
    });
    session.publishMalformedAwareness(8, { user: { id: 'u-8', name: 42 }, cursor: null });

    const cursors = collectRemoteCursors(
      session.awareness,
      session.getCollaborators(),
      session.text.length,
      session.localClientId,
    );

    expect(cursors.map((cursor) => cursor.clientId)).toEqual([7]);
    expect(cursors[0]!.user.name).toBe('Ada');
    session.destroy();
  });

  it('drops a collaborator as soon as its awareness entry is removed', () => {
    const session = createSession();
    session.publishRemoteCollaborator(7, { user: { id: 'u-7', name: 'Ada' } });
    expect(session.getCollaborators()).toHaveLength(2); // self + Ada

    session.removeRemoteCollaborator(7);
    expect(session.getCollaborators()).toHaveLength(1);
    session.destroy();
  });

  it('notifies subscribers when the collaborator set changes', () => {
    const session = createSession();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    session.publishRemoteCollaborator(7, { user: { id: 'u-7', name: 'Ada' } });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    const calls = listener.mock.calls.length;
    session.publishRemoteCollaborator(8, { user: { id: 'u-8', name: 'Grace' } });
    expect(listener.mock.calls.length).toBe(calls);
    session.destroy();
  });

  it('notifies subscribers when a collaborator leaves', () => {
    const session = createSession();
    session.publishRemoteCollaborator(7, { user: { id: 'u-7', name: 'Ada' } });
    const listener = vi.fn();
    session.subscribe(listener);

    session.removeRemoteCollaborator(7);

    expect(listener).toHaveBeenCalled();
    expect(session.getCollaborators().some((entry) => entry.clientId === 7)).toBe(false);
    session.destroy();
  });
});

describe('document switch cleanup', () => {
  it('tears down the old binding so the previous document cannot mutate the new one', () => {
    const documentA = createSession('doc-a');
    const { binding: bindingA, surface: surfaceA } = bind(documentA);

    // The user switches documents: A's session and binding are destroyed first.
    bindingA.destroy();
    documentA.destroy();

    const documentB = createSession('doc-b');
    const { binding: bindingB, surface: surfaceB } = bind(documentB);

    // A late remote update for A must not reach B's editor.
    documentA.applyRemoteText((text) => text.insert(0, 'LEAK '));
    expect(surfaceB.getText()).toBe('hello');
    expect(surfaceB.getText()).toBe(documentB.text.toString());

    // B still works normally.
    bindingB.handleLocalChanges([{ from: 5, to: 5, insert: '!' }]);
    surfaceB.text = 'hello!';
    bindingB.flushLocalEdits();
    expect(documentB.text.toString()).toBe('hello!');

    expect(surfaceA.getText()).toBe('hello');
    bindingB.destroy();
    documentB.destroy();
  });

  it('detaches the Y.Text observer on destroy so no further work happens', () => {
    const session = createSession();
    trackObservers(session.text);
    const { binding, surface } = bind(session);
    expect(countObservers(session.text)).toBe(1);

    binding.destroy();
    expect(countObservers(session.text)).toBe(0);

    session.applyRemoteText((text) => text.insert(0, 'X'));

    expect(surface.getText()).toBe('hello');
    expect(countObservers(session.text)).toBe(0);
    session.destroy();
  });

  it('keeps two documents independent when both sessions are alive briefly', () => {
    const a = createFakeCollaborativeSession({ documentId: 'a', user: USER, initialText: 'A' });
    const b = createFakeCollaborativeSession({ documentId: 'b', user: USER, initialText: 'B' });

    const boundA = bind(a);
    const boundB = bind(b);

    a.applyRemoteText((text) => text.insert(0, '1'));
    b.applyRemoteText((text) => text.insert(0, '2'));

    expect(boundA.surface.getText()).toBe('1A');
    expect(boundB.surface.getText()).toBe('2B');

    boundA.binding.destroy();
    boundB.binding.destroy();
    a.destroy();
    b.destroy();
  });

  it('releases the surface after a local flush on teardown, losing no keystroke', () => {
    const session = createSession();
    const { binding, surface } = bind(session);

    // A keystroke arrives, then the component unmounts before the batch flushes.
    binding.handleLocalChanges([{ from: 5, to: 5, insert: 'kept' }]);
    surface.text = 'hellokept';
    binding.flushLocalEdits();
    binding.destroy();

    expect(session.text.toString()).toBe('hellokept');
    session.destroy();
  });
});

describe('undo does not echo back as a local edit', () => {
  it('leaves Y.Text unchanged when a derived change is flushed after an undo', () => {
    const session = createSession();
    const { binding, surface } = bind(session);

    // A local edit, then undo: `Y.Text` returns to 'hello'.
    binding.handleLocalChanges([{ from: 5, to: 5, insert: 'Z' }]);
    surface.text = 'helloZ';
    binding.flushLocalEdits();
    expect(session.text.toString()).toBe('helloZ');

    session.undo();
    expect(session.text.toString()).toBe('hello');
    // The surface follows the truth (this is what the binding's reconcile does).
    surface.text = 'hello';

    // If the editor had reported that derived change as a local edit, the binding
    // would now write the undone text back in - and undo would be broken forever
    // after the first use.
    binding.flushLocalEdits();
    expect(session.text.toString()).toBe('hello');
    session.destroy();
  });

  it('still applies a genuine user edit made after an undo', () => {
    const session = createSession();
    const { binding, surface } = bind(session);

    binding.handleLocalChanges([{ from: 5, to: 5, insert: 'Z' }]);
    surface.text = 'helloZ';
    binding.flushLocalEdits();
    session.undo();
    surface.text = 'hello';

    // A real keystroke, reported as an unannotated (user) change.
    binding.handleLocalChanges([{ from: 5, to: 5, insert: '!' }]);
    surface.text = 'hello!';
    binding.flushLocalEdits();

    expect(session.text.toString()).toBe('hello!');
    session.destroy();
  });
});

describe('fake session double', () => {
  it('is idempotent on destroy', () => {
    const session = createSession();
    session.destroy();
    expect(() => session.destroy()).not.toThrow();
    expect(session.state).toBe('destroyed');
  });

  it('stops notifying listeners after destroy', () => {
    const session = createSession();
    const listener = vi.fn();
    session.subscribe(listener);
    session.destroy();
    session.setConnectionStatus('connected');
    expect(listener).not.toHaveBeenCalled();
  });
});

/**
 * Count the live `Y.Text` observers without reaching into Yjs internals: every
 * call to `observe` / `unobserve` for a text is recorded here, so the net count
 * is `observations - unobservations`.
 */
const observationCounts = new WeakMap<Y.Text, number>();

function countObservers(text: Y.Text): number {
  return observationCounts.get(text) ?? 0;
}

/** Wrap a `Y.Text` so its observe/unobserve calls are counted. */
function trackObservers(text: Y.Text): void {
  if (observationCounts.has(text)) return;
  observationCounts.set(text, 0);

  const originalObserve = text.observe.bind(text);
  const originalUnobserve = text.unobserve.bind(text);

  text.observe = ((...args: Parameters<Y.Text['observe']>) => {
    observationCounts.set(text, countObservers(text) + 1);
    return originalObserve(...args);
  }) as Y.Text['observe'];

  text.unobserve = ((...args: Parameters<Y.Text['unobserve']>) => {
    observationCounts.set(text, Math.max(0, countObservers(text) - 1));
    return originalUnobserve(...args);
  }) as Y.Text['unobserve'];
}
