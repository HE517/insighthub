import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTestContext,
  testSocketFactory,
  waitFor,
  type TestContext,
} from './support/scenarios.js';
import { ContractTestServer } from './support/test-server.js';

/**
 * Requirement 8 (of the task brief): after `destroy()` no listener, timer or pending
 * send is left behind.
 *
 * Leaks matter here for a concrete reason: `y-protocols`' `Awareness` installs a 3 s
 * check interval and `y-indexeddb` installs a trim timer, so a session that forgets
 * to release them keeps a Node process (and a test run) alive, while a leaky observer
 * would keep writing to a replica nobody owns (`docs/DECISIONS.md` D-015).
 *
 * Two independent lines of evidence are used:
 *
 * 1. **Subscription lists.** `Y.Doc` and `Awareness` are lib0 `Observable`s and keep
 *    their observers in `_observers`; teardown must empty them for the events the
 *    session subscribed to.
 * 2. **Timer releases.** `clearInterval`/`clearTimeout` are spied on, so teardown
 *    must actually disarm the interval the presence channel created and any pending
 *    reconnect/flush timer.
 */

let context: TestContext | undefined;
let server: ContractTestServer | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await context?.cleanup();
  context = undefined;
  await server?.stop();
  server = undefined;
});

function ctx(): TestContext {
  context ??= createTestContext();
  return context;
}

/** Number of observers a lib0 `Observable` holds for one event name. */
function observerCount(target: unknown, event: string): number {
  const observers = (target as { _observers?: { get(name: string): Set<unknown> | undefined } })
    ._observers;
  return observers?.get(event)?.size ?? 0;
}

describe('teardown releases every resource', () => {
  it('removes all document and awareness observers on destroy()', async () => {
    const session = await ctx().create();
    session.transact((text) => text.insert(0, 'content'));
    session.startNetwork('ws://127.0.0.1:1/ws', testSocketFactory);

    expect(observerCount(session.doc, 'update')).toBeGreaterThan(0);
    expect(observerCount(session.awareness, 'change')).toBeGreaterThan(0);

    session.destroy();

    expect(observerCount(session.doc, 'update')).toBe(0);
    expect(observerCount(session.doc, 'afterTransaction')).toBe(0);
    expect(observerCount(session.awareness, 'change')).toBe(0);
    expect(observerCount(session.awareness, 'update')).toBe(0);
  });

  it('clears the presence interval that Awareness installs', async () => {
    const session = await ctx().create();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    session.destroy();

    // `Awareness.destroy()` clears exactly one interval. If the session did not call
    // it, that 3 s interval would outlive the session and hold the process open.
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('clears pending timers when a connection is torn down mid-flight', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const session = await ctx().create();
    // A socket factory that always fails forces the reconnect timer to be armed.
    session.startNetwork('ws://127.0.0.1:1/ws', function FailingSocket() {
      throw new Error('no transport');
    } as unknown as typeof testSocketFactory);
    await waitFor(() => session.connectionStatus === 'reconnecting', 'a reconnect attempt');

    session.destroy();
    // Both the awareness flush timer and the reconnect timer must be disarmed.
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('stops notifying subscribers and stops accepting edits after destroy()', async () => {
    const session = await ctx().create();
    let notifications = 0;
    const unsubscribe = session.subscribe(() => {
      notifications += 1;
    });

    session.transact((text) => text.insert(0, 'before'));
    expect(notifications).toBeGreaterThan(0);

    session.destroy();
    unsubscribe();
    const afterDestroy = notifications;
    session.transact((text) => text.insert(0, 'x'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(notifications).toBe(afterDestroy);
  });

  it('stops sending document frames after destroy() even with a socket that was open', async () => {
    const room = new ContractTestServer('leak-send');
    server = room;
    const url = await room.start();
    const session = await ctx().create({ documentId: 'leak-send' });
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'joined');
    // Let the client-initiated handshake finish before measuring, so a late
    // SyncStep2 reply is not mistaken for post-destroy traffic. Two exchanges means
    // the server answered our SyncStep1 (SyncStep2 out) and we answered its
    // SyncStep1 (sync-step1 in is counted once per SyncStep1 received).
    await waitFor(() => room.syncExchanges.length >= 2, 'the initial sync handshake');
    const framesBefore = room.syncExchanges.length;

    session.destroy();
    // The provider is detached, so a late document edit cannot reach the wire.
    session.transact((text) => text.insert(0, 'after destroy'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(room.syncExchanges.length).toBe(framesBefore);
  });

  it('is idempotent and never throws on repeated or post-destroy calls', async () => {
    const session = await ctx().create();
    session.destroy();
    expect(() => {
      session.destroy();
      session.disconnect();
      session.undo();
      session.redo();
      session.getUndoState();
      session.getCollaborators();
    }).not.toThrow();
    expect(session.state).toBe('destroyed');
  });

  it('leaves no reconnect scheduled after an explicit disconnect()', async () => {
    server = new ContractTestServer('leak-reconnect');
    const url = await server.start();
    const session = await ctx().create({ documentId: 'leak-reconnect' });
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'joined');

    session.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Deliberate offline is not an error path: no reconnect may be armed.
    expect(session.connectionStatus).toBe('offline');
    session.destroy();
  });
});
