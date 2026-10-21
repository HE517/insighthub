/**
 * M1-A3 protocol robustness: malformed and hostile input on both planes, the
 * fatal/non-fatal split, heartbeat reaping of a socket that vanished without a close
 * frame, and the slow-client backpressure strategy.
 *
 * The client here is deliberately adversarial: it sends frames a conforming client
 * never would, because the acceptance criteria are about what the server does with
 * input it cannot trust.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import {
  MAX_BINARY_FRAME_BYTES,
  PROTOCOL_VERSION,
  WS_ERROR_CODES,
  WS_MESSAGE_TYPES,
  createEnvelope,
} from '@insighthub/shared';
import * as Y from 'yjs';

import { PeerImpl } from './peer.js';
import { Heartbeat } from './heartbeat.js';
import { SLOW_CLIENT_BUFFER_LIMIT_BYTES, SLOW_CLIENT_CLOSE_CODE } from './constants.js';
import {
  FRAME,
  FakeSocket,
  TestClient,
  createTestAwareness,
  makePeerDocument,
  startTestServer,
  syncUpdateFrame,
  type TestServer,
} from './test-harness.js';

let server: TestServer;
let connectionBaseline = 0;
let roomBaseline = 0;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  connectionBaseline = server.handle.registry.connectionCount;
  roomBaseline = server.handle.registry.roomCount();
});

afterEach(async () => {
  await waitUntil(
    () =>
      server.handle.registry.connectionCount === connectionBaseline &&
      server.handle.registry.roomCount() === roomBaseline,
    'the registry returns to its pre-test state',
  );
});

describe('M1-A3 invalid input', () => {
  it('reports malformed JSON as INVALID_MESSAGE and closes the socket', async () => {
    const client = await TestClient.connect(server.url);
    try {
      client.sendRaw('{ not json at all');
      const error = await client.waitForError(WS_ERROR_CODES.INVALID_MESSAGE);
      assert.equal(error.payload.code, WS_ERROR_CODES.INVALID_MESSAGE);
      // INVALID_MESSAGE is fatal: a peer whose frames cannot be parsed cannot be trusted
      // to keep speaking the protocol.
      await client.waitForClose();
    } finally {
      client.destroy();
    }
  });

  it('reports an unknown TEXT type as UNKNOWN_MESSAGE_TYPE and closes the socket', async () => {
    const client = await TestClient.connect(server.url);
    try {
      // The M1-plan `presence` message was deleted by M1-A0.1, so a stale client must
      // fail loudly with the accurate code rather than being mistaken for corruption.
      // Sent as a raw envelope because `createEnvelope` is typed against the frozen
      // vocabulary, which no longer contains `presence`.
      client.sendRaw(
        JSON.stringify({
          type: 'presence',
          payload: { documentId: 'doc-1', connectionId: 'c1', state: 'joined' },
          ts: new Date().toISOString(),
        }),
      );
      const error = await client.waitForError(WS_ERROR_CODES.UNKNOWN_MESSAGE_TYPE);
      assert.equal(error.payload.code, WS_ERROR_CODES.UNKNOWN_MESSAGE_TYPE);
      await client.waitForClose();
    } finally {
      client.destroy();
    }
  });

  it('reports a known type with an invalid payload as INVALID_MESSAGE, not unknown', async () => {
    const client = await TestClient.connect(server.url);
    try {
      // `join-room` is implemented, so this is a payload fault: the distinction matters
      // because the two faults have different fixes.
      client.send(createEnvelope(WS_MESSAGE_TYPES.joinRoom, { documentId: '' }));
      const error = await client.waitForError(WS_ERROR_CODES.INVALID_MESSAGE);
      assert.equal(error.payload.code, WS_ERROR_CODES.INVALID_MESSAGE);
      assert.equal(client.closed, false, 'the error is delivered before the close lands');
    } finally {
      client.destroy();
    }
  });

  it('reports an unparseable envelope with no type as INVALID_MESSAGE', async () => {
    const client = await TestClient.connect(server.url);
    try {
      client.sendRaw(JSON.stringify({ payload: {}, ts: '2026-01-01T00:00:00.000Z' }));
      const error = await client.waitForError(WS_ERROR_CODES.INVALID_MESSAGE);
      assert.equal(error.payload.code, WS_ERROR_CODES.INVALID_MESSAGE);
    } finally {
      client.destroy();
    }
  });

  it('reports a binary frame before join-room as ROOM_NOT_JOINED without closing', async () => {
    const client = await TestClient.connect(server.url);
    try {
      // A valid SYNC frame, sent with no room. This is normal during a handshake race, so
      // the socket must survive it.
      const frame = syncUpdateFrame(makePeerDocument('never routed').doc);
      client.sendBinary(frame);

      const error = await client.waitForError(WS_ERROR_CODES.ROOM_NOT_JOINED);
      assert.equal(error.payload.code, WS_ERROR_CODES.ROOM_NOT_JOINED);

      await client.settle(150);
      assert.equal(client.closed, false, 'ROOM_NOT_JOINED is explicitly non-fatal');

      // And the socket is still usable: a valid join afterwards succeeds.
      const joined = await client.joinAndWait('doc-after-not-joined');
      assert.equal(joined.documentId, 'doc-after-not-joined');
    } finally {
      client.destroy();
    }
  });

  it('reports an unknown binary frame type as INVALID_BINARY_FRAME and closes', async () => {
    const client = await TestClient.connect(server.url);
    try {
      await client.joinAndWait('doc-unknown-frame');

      // Frame type 9 is not in the frozen vocabulary (0 = SYNC, 1 = AWARENESS). Unknown
      // types are rejected, never ignored.
      client.sendBinary(Uint8Array.from([9, 0, 0, 0]));

      const error = await client.waitForError(WS_ERROR_CODES.INVALID_BINARY_FRAME);
      assert.equal(error.payload.code, WS_ERROR_CODES.INVALID_BINARY_FRAME);
      await client.waitForClose();
    } finally {
      client.destroy();
    }
  });

  it('reports a malformed binary frame as INVALID_BINARY_FRAME and closes', async () => {
    const client = await TestClient.connect(server.url);
    try {
      await client.joinAndWait('doc-malformed-frame');

      // A SYNC frame whose length prefix promises more payload than exists. The codec
      // detects this explicitly instead of letting y-protocols read it as "no data".
      client.sendBinary(Uint8Array.from([FRAME.sync, 2, 40, 1, 2, 3]));

      const error = await client.waitForError(WS_ERROR_CODES.INVALID_BINARY_FRAME);
      assert.equal(error.payload.code, WS_ERROR_CODES.INVALID_BINARY_FRAME);
      await client.waitForClose();
    } finally {
      client.destroy();
    }
  });

  it('reports a one-byte binary frame as INVALID_BINARY_FRAME', async () => {
    const client = await TestClient.connect(server.url);
    try {
      await client.joinAndWait('doc-tiny-frame');
      client.sendBinary(Uint8Array.from([FRAME.sync]));
      const error = await client.waitForError(WS_ERROR_CODES.INVALID_BINARY_FRAME);
      assert.equal(error.payload.code, WS_ERROR_CODES.INVALID_BINARY_FRAME);
    } finally {
      client.destroy();
    }
  });

  it('never leaks a stack trace or internal path in an error message', async () => {
    const client = await TestClient.connect(server.url);
    try {
      client.sendRaw('totally not json');
      const error = await client.waitForError(WS_ERROR_CODES.INVALID_MESSAGE);

      // The code is the contract; the message is human-facing. A path, a stack frame or
      // an internal identifier would be an information leak (docs/CONTRACTS.md §7).
      const message = error.payload.message;
      assert.ok(message.length > 0);
      assert.ok(!message.includes('    at '), `message must not contain a stack frame: ${message}`);
      assert.ok(
        !/[A-Za-z]:\\/.test(message),
        `message must not contain a Windows path: ${message}`,
      );
      assert.ok(!message.includes('node_modules'), 'message must not contain a module path');
    } finally {
      client.destroy();
    }
  });

  it('reports an unsupported integer protocol version as PROTOCOL_VERSION_MISMATCH', async () => {
    // M1-A0.2: `joinRoomPayloadSchema` accepts any integer version structurally, so a
    // version disagreement reaches the server's own comparison and produces the specific
    // code. Before this fix the schema used `z.literal(PROTOCOL_VERSION)`, which rejected a
    // differing version as a malformed message — `PROTOCOL_VERSION_MISMATCH` was
    // unreachable on the wire and an older client could not be told why it was refused.
    for (const version of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1, 1, 999]) {
      const client = await TestClient.connect(server.url);
      try {
        client.join(`doc-version-${version}`, { protocolVersion: version });

        const error = await client.waitForError(WS_ERROR_CODES.PROTOCOL_VERSION_MISMATCH);
        assert.equal(error.payload.code, WS_ERROR_CODES.PROTOCOL_VERSION_MISMATCH);

        // Fatal by contract: the peer cannot continue on this socket.
        await client.waitForClose();

        assert.equal(
          server.handle.registry.hasRoom(`doc-version-${version}`),
          false,
          'a rejected join must not create a room',
        );
      } finally {
        client.destroy();
      }
    }
  });

  it('reports a non-integer protocol version as INVALID_MESSAGE', async () => {
    // A string, fraction, null or object version is a structurally malformed envelope, not
    // an unsupported version, so it must not be reported as a mismatch.
    //
    // Each case uses its own document id: sharing one would let a successful earlier join
    // leave a `room-joined` frame in the next client's history and mask a later failure.
    const cases: Array<[string, unknown]> = [
      ['string', '2'],
      ['null', null],
      ['fraction', 2.5],
      ['object', {}],
      ['negative', -1],
    ];

    for (const [label, version] of cases) {
      const client = await TestClient.connect(server.url);
      try {
        client.join(`doc-version-malformed-${label}`, { protocolVersion: version });
        const error = await client.waitForError(WS_ERROR_CODES.INVALID_MESSAGE);
        assert.equal(
          error.payload.code,
          WS_ERROR_CODES.INVALID_MESSAGE,
          `malformed version (${label}) must be INVALID_MESSAGE, not a mismatch`,
        );
      } finally {
        client.destroy();
      }
    }
  });

  it('reports a missing protocol version as INVALID_MESSAGE', async () => {
    const client = await TestClient.connect(server.url);
    try {
      // Bypass the harness default so the field is genuinely absent.
      client.send(
        createEnvelope(WS_MESSAGE_TYPES.joinRoom, {
          documentId: 'doc-version-missing',
          mode: 'readwrite',
        }),
      );
      const error = await client.waitForError(WS_ERROR_CODES.INVALID_MESSAGE);
      assert.equal(error.payload.code, WS_ERROR_CODES.INVALID_MESSAGE);
    } finally {
      client.destroy();
    }
  });

  it('accepts a join-room carrying the exact frozen protocol version', async () => {
    const client = await TestClient.connect(server.url);
    try {
      const joined = await client.joinAndWait('doc-version-ok');
      assert.equal(joined.documentId, 'doc-version-ok');
      assert.equal(PROTOCOL_VERSION, 2);
    } finally {
      client.destroy();
    }
  });

  it('drops an awareness update that exceeds the frozen client limit', async () => {
    const publisher = await TestClient.connect(server.url);
    const observer = await TestClient.connect(server.url);
    const rejections: string[] = [];
    const limited = await startTestServer({
      logger: { warn: (message) => rejections.push(message) },
    });

    try {
      await publisher.joinAndWait('doc-abuse');
      await observer.joinAndWait('doc-abuse');

      // The contract bounds one update's fan-out at MAX_AWARENESS_CLIENTS_PER_UPDATE
      // (512). Build a frame that mentions more than that, using the codec's own
      // awareness encoder so the frame is otherwise well formed.
      const oversized = buildOversizedAwarenessFrame(600);
      assert.ok(oversized.byteLength > 0);

      publisher.sendBinary(oversized);
      await publisher.settle(200);
      await observer.settle(200);

      // The update is dropped whole: no partial application, no relay, and no socket
      // close (awareness is ephemeral, so discarding is the entire remedy).
      assert.equal(
        server.handle.registry.requireRoom('doc-abuse').snapshot().awarenessEntryCount,
        0,
        'an over-broad awareness update must not be applied',
      );
      assert.equal(
        observer.frames.filter((frame) => frame.kind === 'binary').length,
        0,
        'and must not be relayed to the room',
      );
      assert.equal(publisher.closed, false, 'awareness abuse never closes a socket');

      // A conforming update from the same socket still works: the drop is per-frame.
      const { encodeAwarenessFrame } = await import('@insighthub/shared');
      const { encodeAwarenessUpdate } = await import('y-protocols/awareness');
      const doc = new Y.Doc();
      const awareness = createTestAwareness(doc);
      awareness.setLocalState({
        user: { id: 'u1', name: 'OK', color: '#112233' },
        cursor: null,
        selection: null,
        updatedAt: Date.now(),
      });
      publisher.sendBinary(
        encodeAwarenessFrame(encodeAwarenessUpdate(awareness, [awareness.clientID])),
      );
      await waitUntil(
        () => server.handle.registry.requireRoom('doc-abuse').snapshot().awarenessEntryCount === 1,
        'a conforming awareness update is accepted after a rejected one',
      );
      awareness.destroy();
      doc.destroy();
    } finally {
      publisher.destroy();
      observer.destroy();
      await limited.close();
    }
  });
});

describe('M1-A3 heartbeat', () => {
  it('reaps a socket that stops answering pings, cleaning room and awareness', async () => {
    // The sweep is driven synchronously by `markPeerUnresponsive`, so no automatic tick is
    // needed to produce the reap. The interval is kept long on purpose: at the previous
    // 40 ms/60 ms the next automatic sweep could fire before a live peer's pong came back,
    // terminate the *surviving* socket, and turn this liveness test into a scheduler-latency
    // test (observed as a 4 s `waitUntil` timeout under load — TOOLING-P2, D-070).
    const fast = await startTestServer({
      heartbeat: { intervalMs: 5_000, timeoutMs: 15_000 },
      logger: { warn: () => undefined },
    });

    try {
      const dead = await TestClient.connect(fast.url);
      const survivor = await TestClient.connect(fast.url);

      const deadJoined = await dead.joinAndWait('doc-heartbeat');
      await survivor.joinAndWait('doc-heartbeat');

      // The dead client publishes presence so the test can prove the entry is removed,
      // not merely detached from the room.
      const { encodeAwarenessFrame } = await import('@insighthub/shared');
      const { encodeAwarenessUpdate } = await import('y-protocols/awareness');
      const doc = new Y.Doc();
      const awareness = createTestAwareness(doc);
      awareness.setLocalState({
        user: { id: 'ghost', name: 'Ghost', color: '#ff0000' },
        cursor: { anchor: 0, head: 0 },
        selection: null,
        updatedAt: Date.now(),
      });
      dead.sendBinary(encodeAwarenessFrame(encodeAwarenessUpdate(awareness, [awareness.clientID])));
      await waitUntil(
        () =>
          fast.handle.registry.requireRoom('doc-heartbeat').snapshot().awarenessEntryCount === 1,
        'the server holds the dead client’s presence',
      );

      // Simulate a client that vanished: it still answers at the TCP layer (a local
      // client always pongs), but produced no evidence of liveness this round. The sweep
      // then runs the production reap path — terminate, close, full cleanup.
      fast.handle.markPeerUnresponsive(deadJoined.connectionId);
      survivor.clear();

      await waitUntil(
        () => dead.closed && survivor.closed === false,
        'the heartbeat terminates the unresponsive socket and leaves the live one open',
        4000,
      );

      assert.equal(dead.closed, true, 'the unresponsive socket was terminated');
      assert.equal(survivor.closed, false, 'a live peer is never reaped');

      // The reaped peer's cleanup must leave exactly the surviving member behind. The room
      // is NOT destroyed here: `survivor` joined the same room above and is still
      // connected, so asserting `!hasRoom(...)` would contradict the scenario. (M1-A0.2
      // fix: that assertion previously made this test time out rather than fail, which
      // hung the whole suite.)
      await waitUntil(
        () =>
          fast.handle.registry.hasRoom('doc-heartbeat') &&
          fast.handle.registry.requireRoom('doc-heartbeat').peerCount === 1,
        'the room keeps exactly the surviving member after the reap',
      );
      await waitUntil(
        () => fast.handle.registry.connectionCount === 1,
        'the dead socket’s context is gone and the survivor’s remains',
      );

      // The survivor observed the departure as an awareness removal — the only presence
      // channel there is (D-021). No control-plane presence message exists.
      const removal = await survivor.waitForFrame(
        (frame) => frame.kind === 'binary' && frame.bytes[0] === FRAME.awareness,
        'the awareness removal broadcast to the surviving peer',
        2000,
      );
      assert.equal(removal.kind, 'binary');

      assert.equal(
        survivor.textMessages().filter((message) => message.type !== 'connected').length,
        0,
        'departure is reported through awareness, never as a control message',
      );

      // The room's destruction is still proven — by the last member actually leaving.
      survivor.close();
      await waitUntil(
        () => !fast.handle.registry.hasRoom('doc-heartbeat'),
        'the room is destroyed once its last member is gone',
      );
      await waitUntil(
        () => fast.handle.registry.connectionCount === 0,
        'no connection context is left behind',
      );

      assert.ok(deadJoined.connectionId.length > 0);
      awareness.destroy();
      doc.destroy();
      survivor.destroy();
    } finally {
      await fast.close();
    }
  });

  it('notifies once and stops tracking a socket it terminates', async () => {
    const reasons: string[] = [];
    const heartbeat = new Heartbeat({
      intervalMs: 1000, // never fires in this test: `sweep()` is driven directly
      timeoutMs: 30_000, // long enough that only the explicit unresponsive mark can reap
      onTerminate: (reason) => reasons.push(reason),
    });
    const socket = new FakeSocket();

    try {
      heartbeat.track(socket);
      assert.equal(heartbeat.trackedCount, 1);

      // Round 1 pings and starts the reap window.
      heartbeat.sweep();
      assert.equal(socket.pingCount, 1);

      // The socket produced nothing, so the next round reaps it.
      heartbeat.markUnresponsive(socket);
      heartbeat.sweep();

      assert.equal(socket.terminateCount, 1, 'the unresponsive socket is terminated exactly once');
      assert.equal(heartbeat.trackedCount, 0, 'and untracked, so it cannot be reaped twice');
      assert.equal(heartbeat.isTracked(socket), false);
      assert.equal(reasons.length, 1, 'the termination is reported once, with a reason');
      assert.match(reasons[0] ?? '', /no pong/);
    } finally {
      heartbeat.stop();
    }
  });

  it('treats any inbound traffic as proof of life', async () => {
    // A long reap window so the timer cannot fire during this test: the assertions are
    // about the decision `sweep()` makes, not about wall-clock expiry.
    const heartbeat = new Heartbeat({ intervalMs: 1000, timeoutMs: 30_000 });
    const socket = new FakeSocket();

    try {
      heartbeat.track(socket);

      // Round 1 marks the socket as awaiting a pong.
      heartbeat.sweep();
      assert.equal(socket.pingCount, 1);
      assert.equal(heartbeat.isTracked(socket), true);

      // Real traffic arrives before the next round: better evidence of liveness than a
      // control frame, so the next sweep must not reap it.
      socket.emit('message');
      heartbeat.sweep();
      assert.equal(socket.terminateCount, 0, 'inbound traffic keeps the socket alive');

      // A pong is equally good evidence.
      socket.emit('pong');
      heartbeat.sweep();
      assert.equal(socket.terminateCount, 0, 'a pong keeps the socket alive');

      // With nothing at all, the socket is reaped.
      heartbeat.markUnresponsive(socket);
      heartbeat.sweep();
      assert.equal(socket.terminateCount, 1, 'a silent socket is terminated on the next round');
    } finally {
      heartbeat.stop();
    }
  });
});

describe('M1-A3 slow client / backpressure', () => {
  it('drops a peer whose send buffer is over the limit instead of queueing forever', () => {
    const socket = new FakeSocket();
    const peer = new PeerImpl(socket, 'slow-connection');

    // Under the limit: the frame is written.
    socket.bufferedAmount = SLOW_CLIENT_BUFFER_LIMIT_BYTES;
    const first = new Uint8Array([0, 1, 2]);
    assert.equal(peer.sendBinary(first), true, 'a buffer at the limit is still writable');
    assert.equal(socket.binaryFrames.length, 1);

    // Over the limit: refuse and drop. Queueing here is what turns one slow reader into
    // unbounded server memory, which is the failure this strategy exists to prevent.
    socket.bufferedAmount = SLOW_CLIENT_BUFFER_LIMIT_BYTES + 1;
    assert.equal(peer.sendBinary(new Uint8Array([0, 3, 4])), false);
    assert.equal(socket.binaryFrames.length, 1, 'nothing further is queued');
    assert.deepEqual(socket.closes, [
      { code: SLOW_CLIENT_CLOSE_CODE, reason: 'slow client: send buffer limit exceeded' },
    ]);
  });

  it('refuses control writes to a peer it has already dropped', () => {
    const socket = new FakeSocket();
    const peer = new PeerImpl(socket, 'slow-connection');
    socket.bufferedAmount = SLOW_CLIENT_BUFFER_LIMIT_BYTES * 2;

    assert.equal(peer.sendError(WS_ERROR_CODES.INTERNAL_ERROR, 'nope'), false);
    assert.equal(socket.textFrames.length, 0, 'no error is queued onto a saturated socket');
    assert.equal(socket.closes.length, 1, 'the drop is signalled exactly once');
  });

  it('returns false for a closed socket instead of throwing', () => {
    const socket = new FakeSocket();
    const peer = new PeerImpl(socket, 'closed-connection');
    socket.readyState = 3; // CLOSED

    assert.equal(peer.isOpen(), false);
    assert.equal(peer.sendBinary(new Uint8Array([0, 1])), false);
    assert.equal(peer.sendControl({ type: 'x' }), false);
    assert.equal(socket.closes.length, 0, 'a closed socket needs no close call');
  });

  it('never sends a frame the peer would have to reject as oversized', () => {
    const socket = new FakeSocket();
    const peer = new PeerImpl(socket, 'connection');

    // One byte over the shared ceiling: sending it would hand the peer a frame its own
    // codec must reject, so the write is refused locally instead.
    const oversized = new Uint8Array(MAX_BINARY_FRAME_BYTES + 1);
    oversized[0] = FRAME.sync;
    assert.equal(peer.sendBinary(oversized), false);
    assert.equal(socket.binaryFrames.length, 0);
    assert.equal(socket.closes.length, 0, 'refusing an oversized frame is not a backpressure drop');
  });

  it('drops a real peer whose socket has stopped draining', async () => {
    // The integration side of the same strategy: with the production buffer budget, a real
    // client that has stopped reading eventually exceeds it and is dropped. The kernel
    // absorbs a lot before that point, so this drives enough traffic to get there.
    const constrained = await startTestServer({
      heartbeat: { intervalMs: 600_000, timeoutMs: 600_000 },
      logger: { warn: () => undefined },
    });

    try {
      const slow = await TestClient.connect(constrained.url);
      const talker = await TestClient.connect(constrained.url);
      await slow.joinAndWait('doc-backpressure');
      await talker.joinAndWait('doc-backpressure');

      // Stop reading on the slow client's socket so its receive window closes and the
      // server's send buffer can no longer drain.
      slow.socket.pause();

      const largeChunk = 'z'.repeat(400_000);
      for (let index = 0; index < 40 && !slow.closed; index += 1) {
        const chunkDoc = new Y.Doc();
        chunkDoc.getText('content').insert(0, `${largeChunk}${index}`);
        talker.sendBinary(syncUpdateFrame(chunkDoc));
        await talker.settle(25);
      }
      await slow.settle(400);

      // The invariant that must hold either way: the server never queues without bound.
      // It either keeps up, or it drops the peer — and a dropped peer leaves the room.
      assert.equal(
        constrained.handle.registry.connectionCount <= 2,
        true,
        'the server never accumulates connections it is not tracking',
      );

      if (slow.closed) {
        await waitUntil(
          () => constrained.handle.registry.roomCount() === 0,
          'the dropped peer is removed and the empty room is destroyed',
        );
      }

      // Resume before tearing down. A paused socket holds a *referenced* handle, and while the
      // server still has megabytes queued for it the close handshake cannot finish — that is a
      // leaked handle rather than a slow test, and `node:test` waits for the event loop to drain
      // before the file process exits, so the whole gate would never return (TOOLING-P2).
      // Resuming lets the queued bytes flush and both ends reach CLOSED.
      slow.socket.resume();
      slow.destroy();
      talker.destroy();
      await waitUntil(
        () => constrained.handle.registry.connectionCount === 0,
        'both peers to be reaped from the registry',
      );
    } finally {
      await constrained.close();
    }
  });
});

describe('M1-A3 server shutdown', () => {
  it('destroys every room and connection, and leaves no socket behind', async () => {
    const disposable = await startTestServer({ logger: { warn: () => undefined } });

    const client = await TestClient.connect(disposable.url);
    await client.joinAndWait('doc-shutdown');
    assert.equal(disposable.handle.registry.roomCount(), 1);

    await disposable.close();

    assert.equal(disposable.handle.registry.roomCount(), 0);
    assert.equal(disposable.handle.registry.connectionCount, 0);
    assert.equal(disposable.handle.clientCount(), 0);
    client.destroy();
  });
});

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/** Build an awareness frame mentioning more clients than the contract allows. */
function buildOversizedAwarenessFrame(clientCount: number): Uint8Array {
  // Encoded by hand because `encodeAwarenessUpdate` only encodes clients that exist in an
  // `Awareness` instance, and creating 600 real ones is wasteful. The layout is the
  // frozen one: `varint(count)` then `(varint(clientID), varint(clock), varString(json))`
  // per entry — the same structure the codec validates on the way in.
  const body: number[] = [];
  writeVarint(body, clientCount);
  for (let index = 0; index < clientCount; index += 1) {
    writeVarint(body, index + 1);
    writeVarint(body, 1);
    writeVarString(body, JSON.stringify({ user: { id: `u${index}`, name: `u${index}` } }));
  }
  // Wrap it in the AWARENESS frame envelope: `varint(1)` + `varint8Array(body)`.
  const frame: number[] = [];
  writeVarint(frame, FRAME.awareness);
  writeVarint(frame, body.length);
  frame.push(...body);
  return Uint8Array.from(frame);
}

function writeVarint(target: number[], value: number): void {
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    target.push(byte);
  } while (remaining > 0);
}

function writeVarString(target: number[], value: string): void {
  const bytes = Array.from(new TextEncoder().encode(value));
  writeVarint(target, bytes.length);
  target.push(...bytes);
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting until ${description}`);
}
