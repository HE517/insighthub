import { afterEach, describe, expect, it } from 'vitest';

import { isTransitionalStatus, type ConnectionStatus } from '@insighthub/shared';

import {
  TEST_RECONNECT_OBSERVE_MS,
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

    // Record every status the session publishes, so "it never went back to the
    // network" can be checked as a sequence instead of a single final value.
    const statuses: ConnectionStatus[] = [];
    const unsubscribe = session.subscribe(() => {
      statuses.push(session.connectionStatus);
    });

    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'joined');
    const connectionsAfterJoin = server.totalConnections;

    // The **production** fatal path (`docs/CONTRACTS.md` §7): the server sends the
    // typed error *and* closes the socket, exactly as `sendError` does for a fatal
    // code. Sending the error frame alone is not enough: the client then closes a
    // socket it has already detached its handlers from, so the close event a
    // reconnect loop would react to never reaches the provider and the assertion
    // below could not fail no matter how long it waited.
    server.failAllWith('PROTOCOL_VERSION_MISMATCH', 'unsupported protocol version');

    // Wait on the *recorded* sequence, not on a polled value: `error` is a status the
    // client may only hold briefly if a retry is scheduled, and a 5 ms poller can miss
    // it. The subscriber is notified synchronously from `onStatusChange`, so this can
    // never race the transition it is waiting for.
    await waitFor(() => statuses.includes('error'), 'the fatal status to surface');
    const statusesAtError = statuses.lastIndexOf('error') + 1;

    // The backoff belongs to the test context (20 ms base → 60 ms cap), so this
    // window holds at least six retry slots: a live loop would have opened a socket
    // and reported `reconnecting`/`connecting` long before it ends.
    await new Promise((resolve) => setTimeout(resolve, TEST_RECONNECT_OBSERVE_MS));

    // 1. No reconnect attempt of any kind: no new socket was accepted, and no retry
    //    was scheduled (a scheduled retry shows up as a transitional status).
    expect(server.totalConnections).toBe(connectionsAfterJoin);
    expect(session.connectionStatus).toBe('error');
    const publishedAfterError = statuses.slice(statusesAtError);
    expect(publishedAfterError.filter(isTransitionalStatus)).toEqual([]);
    expect(publishedAfterError).not.toContain('connected');

    // 2. The loop was stopped by clearing the provider's `active` flag, not by luck.
    //    `SyncProvider.connect()` early-returns while that flag is set, so an explicit
    //    recovery after the user acknowledges the error is only possible if it was
    //    cleared. This is the assertion that catches a removed `active = false`:
    //    check 1 cannot, because `closeSocket()` detaches the handlers that would
    //    otherwise schedule the retry.
    session.connect();
    await waitFor(
      () => session.connectionStatus === 'connected',
      'an explicit reconnect after the fatal error is acknowledged',
    );
    expect(server.totalConnections).toBe(connectionsAfterJoin + 1);

    unsubscribe();
    session.destroy();
  });

  /**
   * Positive control for the pin above.
   *
   * The same context, the same backoff and the same observation window, but a genuine
   * network failure instead of a fatal error: the provider is still active, so it must
   * retry and re-join on its own, and the new connection must be visible in
   * `totalConnections` within `TEST_RECONNECT_OBSERVE_MS`. If this control ever goes
   * red, the fatal pin's "no new connection" result stops being evidence.
   */
  it('reconnects on its own when the socket dies, inside the fatal-observation window', async () => {
    const room = new ContractTestServer('sync-reconnect-control');
    server = room;
    const url = await room.start();
    const session = await ctx().create({ documentId: 'sync-reconnect-control' });
    session.startNetwork(url, testSocketFactory);
    await waitFor(() => session.connectionStatus === 'connected', 'joined');
    const connectionsAfterJoin = room.totalConnections;

    // Drop the TCP socket without a close handshake — what a network failure looks
    // like, and the event the fatal path must *not* produce a retry for.
    room.dropAllConnections();

    await waitFor(
      () => room.totalConnections > connectionsAfterJoin,
      'an automatic reconnect after the socket was dropped',
      TEST_RECONNECT_OBSERVE_MS,
    );
    await waitFor(() => session.connectionStatus === 'connected', 're-joined after the drop');
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
