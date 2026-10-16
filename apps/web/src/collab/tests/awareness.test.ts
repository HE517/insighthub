import { afterEach, describe, expect, it } from 'vitest';
import { applyUpdate, Doc } from 'yjs';
import { awarenessStateSchema } from '@insighthub/shared';

import {
  createTestContext,
  testSocketFactory,
  waitFor,
  type TestContext,
} from './support/scenarios.js';
import { ContractTestServer } from './support/test-server.js';

/**
 * Requirements 8 and 9: awareness lifecycle, and the validated read path.
 *
 * Awareness is the single source of truth for ephemeral presence
 * (`docs/CONTRACTS.md` §9, R14). The two things these tests pin down are:
 *
 * - `getCollaborators()` never returns an entry that fails the shared schema,
 *   because its values are rendered as another user's name and cursor;
 * - presence is cleaned up — locally and on the wire — when a session ends, so no
 *   ghost cursor survives.
 */

let context: TestContext | undefined;
let server: ContractTestServer | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
  await server?.stop();
  server = undefined;
});

function ctx(): TestContext {
  context ??= createTestContext();
  return context;
}

describe('awareness lifecycle', () => {
  it('publishes a schema-valid local entry and never lists itself', async () => {
    const session = await ctx().create();
    const local = session.getLocalAwarenessState();
    expect(awarenessStateSchema.safeParse(local).success).toBe(true);
    expect(session.awareness.getStates().has(session.localClientId)).toBe(true);
    expect(session.getCollaborators()).toEqual([]);
    session.destroy();
  });

  it('exposes remote peers through the validated accessor', async () => {
    server = new ContractTestServer('awareness-valid');
    const url = await server.start();
    const session = await ctx().create({ documentId: 'awareness-valid' });
    session.startNetwork(url, testSocketFactory);

    await waitFor(() => session.connectionStatus === 'connected', 'the room to be joined');
    await waitFor(
      () =>
        session.getCollaborators().some((collaborator) => collaborator.user.name === 'Server Peer'),
      'the server peer to appear in getCollaborators()',
    );

    const [peer] = session.getCollaborators();
    expect(peer?.user.name).toBe('Server Peer');
    expect(peer?.clientId).toBe(server.awareness.clientID);
    // The client's own entry is never offered as a collaborator.
    expect(session.getCollaborators().some((c) => c.clientId === session.localClientId)).toBe(
      false,
    );
    session.destroy();
  });

  it('filters every invalid awareness entry out of getCollaborators()', async () => {
    server = new ContractTestServer('awareness-invalid');
    const url = await server.start();
    const session = await ctx().create({ documentId: 'awareness-invalid' });
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'the room to be joined');

    // A hostile or buggy peer: no user name, a reversed selection range, and a
    // value that is not an object at all. None of these may reach UI code.
    server.injectAwarenessState(90_001, {
      user: { id: 'ghost' },
      cursor: { anchor: -5, head: -5 },
      selection: null,
      updatedAt: 1,
    });
    server.injectAwarenessState(90_002, {
      user: { id: 'reversed', name: 'Reversed' },
      cursor: { anchor: 1, head: 1 },
      selection: { from: 9, to: 2 },
      updatedAt: 1,
    });
    server.injectAwarenessState(90_003, 'not-an-object');
    server.pushAwarenessFrame([90_001, 90_002, 90_003]);

    await waitFor(
      () => session.awareness.getStates().size >= 4,
      'the invalid entries to reach the raw awareness map',
    );
    // The raw map holds them; the validated accessor refuses every one of them, and
    // the only collaborator it reports is the schema-valid server peer.
    const collaboratorIds = session.getCollaborators().map((collaborator) => collaborator.user.id);
    expect(collaboratorIds).toEqual(['server-peer']);
    expect(session.getCollaborators()).toHaveLength(1);
    expect(session.awareness.getStates().has(90_001)).toBe(true);
    expect(session.awareness.getStates().has(90_002)).toBe(true);
    expect(session.awareness.getStates().has(90_003)).toBe(true);
    session.destroy();
  });

  it('drops a peer entry when the server broadcasts its departure', async () => {
    server = new ContractTestServer('awareness-departure');
    const url = await server.start();
    const session = await ctx().create({ documentId: 'awareness-departure' });
    session.startNetwork(url, testSocketFactory);

    await waitFor(
      () =>
        session.getCollaborators().some((collaborator) => collaborator.user.name === 'Server Peer'),
      'the first peer to appear',
    );
    server.dropAwarenessState(server.awareness.clientID);
    await waitFor(
      () =>
        !session
          .getCollaborators()
          .some((collaborator) => collaborator.user.name === 'Server Peer'),
      'the departed peer to disappear from getCollaborators()',
    );
    session.destroy();
  });

  it('removes and broadcasts the local entry on destroy()', async () => {
    const room = new ContractTestServer('awareness-destroy');
    server = room;
    const url = await room.start();
    const session = await ctx().create({ documentId: 'awareness-destroy' });
    session.startNetwork(url, testSocketFactory);

    await waitFor(
      () => room.awarenessClientIds.includes(session.localClientId),
      'the server to learn this client from awareness',
    );

    session.destroy();

    await waitFor(
      () => !room.awarenessClientIds.includes(session.localClientId),
      'the server to drop this client’s awareness entry',
    );
    expect(session.awareness.getStates().has(session.localClientId)).toBe(false);
  });

  it('never persists awareness into the document or the replica', async () => {
    const documentId = ctx().nextId('awareness-persist');
    const persistenceKey = `awareness-${documentId}`;
    const session = await ctx().create({ documentId, persistenceKey });

    session.setCursor({ anchor: 2, head: 4 });
    session.setSelection({ from: 2, to: 4 });
    expect(session.getLocalAwarenessState()?.cursor).toEqual({ anchor: 2, head: 4 });
    expect(session.getLocalAwarenessState()?.selection).toEqual({ from: 2, to: 4 });

    // Document content stays empty: awareness is not document content.
    expect(session.text.toString()).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The provider is allowed to store the *empty* Yjs state it starts with
    // (`[0, 0]`, i.e. no structs). What must never appear is an update carrying the
    // cursor or the identity: awareness is not CRDT content, so every stored update
    // still decodes to an empty document.
    for (const stored of ctx().db.records(persistenceKey)) {
      const probe = new Doc();
      applyUpdate(probe, stored as Uint8Array);
      expect(probe.getText('content').toString()).toBe('');
      probe.destroy();
    }
    session.destroy();
  });

  it('re-announces presence after a reconnect', async () => {
    const room = new ContractTestServer('awareness-reconnect');
    server = room;
    const url = await room.start();
    const session = await ctx().create({ documentId: 'awareness-reconnect' });
    session.startNetwork(url, testSocketFactory);

    await waitFor(
      () => room.awarenessClientIds.includes(session.localClientId),
      'the room to see this client on the first connection',
    );
    const localClientId = session.localClientId;

    // A quiet outage: the socket dies and the server broadcasts the departure, so
    // the room forgets this client.
    session.disconnect();
    await waitFor(
      () => !room.awarenessClientIds.includes(localClientId),
      'the room to drop this client while it is offline',
    );

    session.connect();
    await waitFor(() => session.connectionStatus === 'connected', 'the reconnect to join');
    // The reconnect must re-publish presence: the state itself never changed, so a
    // publish driven only by state changes would leave this client invisible.
    await waitFor(
      () => room.awarenessClientIds.includes(localClientId),
      'the room to see this client again after the reconnect',
    );
    session.destroy();
  });

  it('leaves no ghost cursor when two clients are in one room', async () => {
    const room = new ContractTestServer('awareness-two-clients');
    server = room;
    const url = await room.start();
    const first = await ctx().create({ documentId: 'awareness-two-clients' });
    const second = await ctx().create({ documentId: 'awareness-two-clients' });

    first.startNetwork(url, testSocketFactory);
    second.startNetwork(url, testSocketFactory);
    await waitFor(
      () =>
        room.awarenessClientIds.includes(first.localClientId) &&
        room.awarenessClientIds.includes(second.localClientId),
      'both clients to be present',
    );
    // Each client also sees the other (plus the server's own entry).
    await waitFor(
      () => first.getCollaborators().some((c) => c.clientId === second.localClientId),
      'client B to be visible to client A',
    );

    const before = room.awarenessClientIds.length;
    first.destroy();
    await waitFor(
      () => !room.awarenessClientIds.includes(first.localClientId),
      'the destroyed client to leave no ghost entry',
    );
    expect(room.awarenessClientIds.length).toBe(before - 1);
    // B is told about the departure as well, so no ghost cursor is rendered.
    await waitFor(
      () => !second.getCollaborators().some((c) => c.clientId === first.localClientId),
      'client A to disappear from client B',
    );
    second.destroy();
  });
});
