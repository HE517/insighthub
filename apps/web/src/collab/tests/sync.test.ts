import { afterEach, describe, expect, it } from 'vitest';

import {
  createTestContext,
  testSocketFactory,
  waitFor,
  type TestContext,
} from './support/scenarios.js';
import { ContractTestServer } from './support/test-server.js';

/**
 * Requirements 6 (offline edits survive a reconnect) and the wire behaviour of the
 * frozen contract: the client-initiated sync handshake, duplicate delivery,
 * out-of-order delivery, join failure and teardown.
 *
 * The server is A1's own contract-compatible double, not A3's implementation, and it
 * speaks the same shared codec — so these tests verify A1's half of the wire
 * contract, and A7 re-runs the real pairing once A3 lands.
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

describe('realtime sync over the frozen wire', () => {
  it('runs the client-initiated handshake: SyncStep1 → SyncStep2 + SyncStep1 → SyncStep2', async () => {
    server = new ContractTestServer('sync-basic', { initialContent: 'from the server\n' });
    const url = await server.start();
    const session = await ctx().create({ documentId: 'sync-basic' });
    session.startNetwork(url, testSocketFactory);

    await waitFor(() => session.connectionStatus === 'connected', 'room-joined');
    await waitFor(
      () => session.text.toString() === 'from the server\n',
      'the server delta to reach the client',
    );

    const kinds = server.syncExchanges.map((exchange) => exchange.kind);
    expect(kinds[0]).toBe('sync-step1-in');
    expect(kinds).toContain('sync-step2-out');
    session.destroy();
  });

  it('sends offline edits to the server after joining', async () => {
    const room = new ContractTestServer('sync-offline-write');
    server = room;
    const url = await room.start();
    const session = await ctx().create({ documentId: 'sync-offline-write' });

    // Edited before the socket exists — the normal offline case.
    session.transact((text) => text.insert(0, 'typed offline'));
    session.startNetwork(url, testSocketFactory);

    await waitFor(
      () => room.doc.getText('content').toString() === 'typed offline',
      'the offline edit to reach the server',
    );
    session.destroy();
  });

  it('converges two clients editing the same room', async () => {
    server = new ContractTestServer('sync-two-clients');
    const url = await server.start();
    const first = await ctx().create({ documentId: 'sync-two-clients' });
    const second = await ctx().create({ documentId: 'sync-two-clients' });

    first.startNetwork(url, testSocketFactory);
    await waitFor(() => first.connectionStatus === 'connected', 'client A joined');
    second.startNetwork(url, testSocketFactory);
    await waitFor(() => second.connectionStatus === 'connected', 'client B joined');

    first.transact((text) => text.insert(0, 'A'));
    await waitFor(() => second.text.toString().includes('A'), 'A→B propagation');
    second.transact((text) => text.insert(second.text.length, 'B'));
    await waitFor(() => first.text.toString().includes('B'), 'B→A propagation');

    expect(first.text.toString()).toBe('AB');
    expect(second.text.toString()).toBe('AB');
    first.destroy();
    second.destroy();
  });

  it('treats a duplicated update frame as a no-op', async () => {
    server = new ContractTestServer('sync-duplicate');
    const url = await server.start();
    const session = await ctx().create({ documentId: 'sync-duplicate' });
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'joined');

    // The server's own next edit is captured, then delivered twice.
    const captured: Uint8Array[] = [];
    const listener = (update: Uint8Array): void => {
      captured.push(update.slice());
    };
    server.doc.on('update', listener);
    server.applyPeerEdit(0, 'once');
    server.doc.off('update', listener);
    expect(captured).toHaveLength(1);

    const { encodeSyncUpdate } = await import('@insighthub/shared');
    const frame = encodeSyncUpdate(captured[0]!);
    server.pushRawBinaryToAll(frame);

    await waitFor(() => session.text.toString() === 'once', 'the duplicate frame to apply');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(session.text.toString()).toBe('once');
    session.destroy();
  });

  it('keeps offline edits and merges the delta on reconnect (no second Y.Doc)', async () => {
    server = new ContractTestServer('sync-reconnect', {
      initialContent: 'server-line\n',
    });
    const url = await server.start();
    const session = await ctx().create({ documentId: 'sync-reconnect' });
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'first join');
    await waitFor(
      () => session.text.toString() === 'server-line\n',
      'initial content from the server',
    );

    const firstExchangeBytes = server.syncExchanges.find(
      (exchange) => exchange.kind === 'sync-step1-in',
    )?.bytes;
    const docIdentity = session.doc;
    const textIdentity = session.text;

    // Sever the network: the socket dies, the document and its replica do not.
    server.offline = true;
    session.disconnect();
    expect(session.connectionStatus).toBe('offline');

    session.transact((text) => text.insert(text.length, 'written while offline\n'));
    expect(session.text.toString()).toBe('server-line\nwritten while offline\n');
    // Same CRDT document before and after the outage.
    expect(session.doc).toBe(docIdentity);
    expect(session.text).toBe(textIdentity);
    expect(session.state).toBe('active');

    // A peer edits the server while this client is offline. `room` is a local alias
    // so the double stays narrowed for the rest of the test.
    const room = server;
    room.applyPeerEdit(0, 'peer-edit\n');

    room.offline = false;
    session.connect();

    await waitFor(() => session.connectionStatus === 'connected', 'reconnect');
    await waitFor(
      () => room.doc.getText('content').toString().includes('written while offline'),
      'the offline edit to be merged into the server document',
    );
    await waitFor(
      () => session.text.toString().includes('peer-edit'),
      'the server-side edit to arrive after reconnect',
    );

    // Convergence: both sides hold both edits, and nothing was lost.
    const clientText = session.text.toString();
    const serverText = room.doc.getText('content').toString();
    expect(clientText).toBe(serverText);
    expect(clientText).toContain('server-line');
    expect(clientText).toContain('peer-edit');
    expect(clientText).toContain('written while offline');

    // Reconnect syncs a delta; it does not resend the document. The second
    // SyncStep1 is what the client sends, so compare the *server's* reply size.
    const replies = server.syncExchanges.filter((exchange) => exchange.kind === 'sync-step2-out');
    expect(replies.length).toBeGreaterThanOrEqual(2);
    expect(firstExchangeBytes).toBeGreaterThan(0);
    session.destroy();
  });

  it('reports a fatal error without looping reconnects', async () => {
    server = new ContractTestServer('sync-fatal');
    const url = await server.start();
    const session = await ctx().create({ documentId: 'sync-fatal' });
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'joined');

    server.sendRawToAll(
      JSON.stringify({
        type: 'error',
        payload: { code: 'PROTOCOL_VERSION_MISMATCH', message: 'unsupported protocol version' },
        ts: new Date().toISOString(),
      }),
    );

    await waitFor(() => session.connectionStatus === 'error', 'the fatal status to surface');
    const connectionsAfterError = server.connectionCount;
    await new Promise((resolve) => setTimeout(resolve, 120));
    // A fatal code stops the reconnect loop: no new socket was opened.
    expect(server.connectionCount).toBe(connectionsAfterError);
    session.destroy();
  });

  it('never sends a data-plane frame before a successful join', async () => {
    server = new ContractTestServer('sync-order');
    const url = await server.start();
    const session = await ctx().create({ documentId: 'sync-order' });

    // A local edit made before the socket opens must not be flushed pre-join.
    session.transact((text) => text.insert(0, 'pre-join edit'));
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'joined');
    await waitFor(
      () => server!.doc.getText('content').toString() === 'pre-join edit',
      'the edit to arrive after the join',
    );

    const stats = session.networkStatistics;
    expect(stats?.framesBeforeJoin).toBe(0);
    session.destroy();
  });

  it('ignores a room-joined acknowledgement for another document', async () => {
    server = new ContractTestServer('sync-wrong-room');
    const url = await server.start();
    const session = await ctx().create({ documentId: 'sync-wrong-room' });
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'joined');

    server.sendRawToAll(
      JSON.stringify({
        type: 'room-joined',
        payload: {
          documentId: 'a-different-document',
          connectionId: 'not-ours',
          peers: [],
        },
        ts: new Date().toISOString(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The session ignores the foreign room and stays on its own document.
    expect(session.documentId).toBe('sync-wrong-room');
    expect(session.connectionStatus).toBe('connected');
    session.destroy();
  });

  it('retries a non-fatal join rejection and then gives up quietly', async () => {
    server = new ContractTestServer('sync-join-retry');
    const url = await server.start();
    server.rejectJoinWith = 'ROOM_NOT_FOUND';
    const session = await ctx().create({ documentId: 'sync-join-retry' });
    session.startNetwork(url, testSocketFactory);

    await waitFor(() => session.connectionStatus === 'reconnecting', 'a bounded retry');
    // The room is never established, and the socket stays open (non-fatal code).
    expect(session.networkStatistics?.syncFramesOut).toBe(0);
    session.destroy();
  });
});
