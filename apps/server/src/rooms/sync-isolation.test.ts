/**
 * M1-A3 data plane: the frozen client-initiated sync handshake, CRDT convergence,
 * duplicate/out-of-order tolerance, room isolation, and the measured proof that a
 * reconnect transfers a delta rather than the document.
 *
 * The client side of these tests is a real `Y.Doc`, exactly as A1's browser provider
 * would use one. The server is reached only over a real socket, so nothing here can
 * pass because a mock agreed with itself.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import {
  MAX_BINARY_FRAME_BYTES,
  SYNC_MESSAGE_TYPES,
  WS_ERROR_CODES,
  decodeBinaryFrame,
  decodeSyncFrame,
  encodeAwarenessFrame,
  encodeSyncStep2,
  encodeSyncUpdate,
  readSyncMessageType,
} from '@insighthub/shared';
import { encodeAwarenessUpdate } from 'y-protocols/awareness';
import { readSyncMessage } from 'y-protocols/sync';
import * as Y from 'yjs';

import {
  FRAME,
  TestClient,
  TestDecoder,
  createTestAwareness,
  fillDocument,
  makeAwarenessState,
  makePeerDocument,
  startTestServer,
  syncMessageTypeOf,
  syncStep1Frame,
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

/**
 * Apply every binary SYNC frame a client received to a local `Y.Doc`.
 *
 * The merge is performed by `y-protocols`' own `readSyncMessage` —the same function
 * the server uses —so convergence is proven by the real protocol implementation rather
 * than by a test-local reimplementation of it.
 */
function applyReceivedSync(target: Y.Doc, frames: Uint8Array[]): void {
  for (const frame of frames) {
    // Decode through the shared codec rather than peeking at `frame[0]`: the frame type is
    // a varint, so reading it as the first byte only happens to work for the small type
    // values this build uses.
    const decoded = decodeSyncFrame(frame);
    assert.ok(decoded !== null, 'server sent an undecodable sync frame');
    if (decoded === null) continue;

    if (readSyncMessageType(decoded) === SYNC_MESSAGE_TYPES.step1) {
      // A server SyncStep1 asks for our state vector. The client answers with SyncStep2;
      // `readSyncMessage` writes that reply into the scratch encoder for us.
      continue;
    }

    readSyncMessage(
      new TestDecoder(decoded.bytes) as unknown as never,
      TestDecoder.scratchEncoder() as unknown as never,
      target,
      'insighthub:remote',
    );
  }
}

/** The full-state encoding of a text value, for byte-level convergence assertions. */
function encodeDocState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

describe('M1-A3 sync handshake', () => {
  it('answers a client SyncStep1 with SyncStep2 followed by the server’s SyncStep1', async () => {
    const client = await TestClient.connect(server.url);

    try {
      // Seed the room through a second socket so there is something to be behind on.
      const seeder = await TestClient.connect(server.url);
      const seederDoc = makePeerDocument('shared content').doc;
      await seeder.joinAndWait('doc-handshake');
      seeder.sendBinary(syncUpdateFrame(seederDoc));
      await waitUntil(
        () => server.handle.registry.requireRoom('doc-handshake').doc.getText('content').length > 0,
        'the room holds the seeded content',
      );

      await client.joinAndWait('doc-handshake');
      client.clear();

      // The frozen sequence: client SyncStep1 -> server SyncStep2 + server SyncStep1.
      const localDoc = new Y.Doc();
      client.sendBinary(syncStep1Frame(localDoc));

      const step2 = await client.waitForFrame(
        (frame) => frame.kind === 'binary' && syncMessageTypeOf(frame.bytes) === 1,
        'a SyncStep2 reply',
      );
      const step1 = await client.waitForFrame(
        (frame) => frame.kind === 'binary' && syncMessageTypeOf(frame.bytes) === 0,
        'the server’s own SyncStep1',
      );

      assert.equal(step2.kind, 'binary');
      assert.equal(step1.kind, 'binary');

      // Order matters for a client that pipelines: SyncStep2 (what I am missing) comes
      // first, then SyncStep1 (what do you need from me).
      const syncFrames = client.binaryFrames().filter((frame) => frame[0] === FRAME.sync);
      assert.equal(syncMessageTypeOf(syncFrames[0] as Uint8Array), 1, 'SyncStep2 is sent first');
      assert.equal(syncMessageTypeOf(syncFrames[1] as Uint8Array), 0, 'then the server SyncStep1');

      seeder.destroy();
      localDoc.destroy();
    } finally {
      client.destroy();
    }
  });

  it('converges two peers editing the same room concurrently', async () => {
    const peerOne = await TestClient.connect(server.url);
    const peerTwo = await TestClient.connect(server.url);

    try {
      await peerOne.joinAndWait('doc-converge');
      await peerTwo.joinAndWait('doc-converge');

      // Two independent CRDT clients edit the same text concurrently, exactly as two
      // browsers would.
      const docOne = new Y.Doc();
      const docTwo = new Y.Doc();
      docOne.getText('content').insert(0, 'AAA');
      docTwo.getText('content').insert(0, 'BBB');

      peerOne.sendBinary(encodeSyncUpdate(Y.encodeStateAsUpdate(docOne)));
      peerTwo.sendBinary(encodeSyncUpdate(Y.encodeStateAsUpdate(docTwo)));

      // Each peer applies what the other published (routed through the server).
      await peerOne.waitForFrame(
        (frame) => frame.kind === 'binary' && syncMessageTypeOf(frame.bytes) === 2,
        'the relayed update at peer one',
      );
      await peerTwo.waitForFrame(
        (frame) => frame.kind === 'binary' && syncMessageTypeOf(frame.bytes) === 2,
        'the relayed update at peer two',
      );

      applyReceivedSync(docOne, peerOne.binaryFrames());
      applyReceivedSync(docTwo, peerTwo.binaryFrames());

      assert.equal(docOne.getText('content').toString(), docTwo.getText('content').toString());
      assert.ok(
        bytesEqual(encodeDocState(docOne), encodeDocState(docTwo)),
        'the two clients must be byte-identical after merging, not merely textually equal',
      );
      assert.equal(
        server.handle.registry.requireRoom('doc-converge').doc.getText('content').toString(),
        docOne.getText('content').toString(),
        'the server replica converged with both clients',
      );

      docOne.destroy();
      docTwo.destroy();
    } finally {
      peerOne.destroy();
      peerTwo.destroy();
    }
  });

  it('treats a duplicate update as a no-op', async () => {
    const sender = await TestClient.connect(server.url);
    const receiver = await TestClient.connect(server.url);

    try {
      await sender.joinAndWait('doc-duplicate');
      await receiver.joinAndWait('doc-duplicate');

      const update = Y.encodeStateAsUpdate(makePeerDocument('idempotent').doc);
      sender.sendBinary(encodeSyncUpdate(update));

      const first = await receiver.waitForFrame(
        (frame) => frame.kind === 'binary' && syncMessageTypeOf(frame.bytes) === 2,
        'the first relayed update',
      );
      assert.equal(first.kind, 'binary');

      const room = server.handle.registry.requireRoom('doc-duplicate');
      const afterFirst = room.doc.getText('content').toString();

      // Sending the identical bytes again must not duplicate the text: Yjs identifies
      // structs by (clientID, clock), so a re-applied update is inert.
      sender.sendBinary(encodeSyncUpdate(update));
      await waitUntil(
        () => receiver.binaryFrames().filter((frame) => syncMessageTypeOf(frame) === 2).length >= 2,
        'the server relays the duplicate too',
      );

      assert.equal(room.doc.getText('content').toString(), afterFirst);
      assert.equal(room.doc.getText('content').toString(), 'idempotent');
    } finally {
      sender.destroy();
      receiver.destroy();
    }
  });

  it('converges when updates arrive out of order', async () => {
    const peerOne = await TestClient.connect(server.url);
    const peerTwo = await TestClient.connect(server.url);

    try {
      await peerOne.joinAndWait('doc-order');
      await peerTwo.joinAndWait('doc-order');

      // Two causally sequential edits in one client, sent to the server in reverse
      // order. `updateTwo` strictly depends on `updateOne`.
      const author = new Y.Doc();
      const text = author.getText('content');
      text.insert(0, 'first');
      const updateOne = Y.encodeStateAsUpdate(author);
      const stateAfterFirst = Y.encodeStateVector(author);
      text.insert(text.length, '-second');
      const updateTwo = Y.encodeStateAsUpdate(author, stateAfterFirst);

      const room = server.handle.registry.requireRoom('doc-order');
      room.applyServerUpdate(updateTwo); // causally later, arrives first
      room.applyServerUpdate(updateOne); // causally earlier, arrives second

      assert.equal(
        room.doc.getText('content').toString(),
        'first-second',
        'the room converges regardless of arrival order; nothing may assume arrival order',
      );

      // The same reversed ordering over the wire, through the real relay path.
      const sender = await TestClient.connect(server.url);
      const receiver = await TestClient.connect(server.url);
      await sender.joinAndWait('doc-order-wire');
      await receiver.joinAndWait('doc-order-wire');

      sender.sendBinary(encodeSyncUpdate(updateTwo));
      sender.sendBinary(encodeSyncUpdate(updateOne));
      await waitUntil(
        () =>
          server.handle.registry.requireRoom('doc-order-wire').doc.getText('content').toString() ===
          'first-second',
        'the relayed updates merge in either order',
      );

      const receiverDoc = new Y.Doc();
      applyReceivedSync(receiverDoc, receiver.binaryFrames());
      assert.equal(receiverDoc.getText('content').toString(), 'first-second');

      sender.destroy();
      receiver.destroy();
      author.destroy();
    } finally {
      peerOne.destroy();
      peerTwo.destroy();
    }
  });

  it('relays awareness to room peers and never persists it in the document', async () => {
    const publisher = await TestClient.connect(server.url);
    const observer = await TestClient.connect(server.url);

    try {
      await publisher.joinAndWait('doc-awareness-relay');
      await observer.joinAndWait('doc-awareness-relay');

      const localDoc = new Y.Doc();
      const localAwareness = createTestAwareness(localDoc);
      localAwareness.setLocalState(makeAwarenessState('Publisher'));
      publisher.sendBinary(
        encodeAwarenessFrame(encodeAwarenessUpdate(localAwareness, [localAwareness.clientID])),
      );

      const relayed = await observer.waitForFrame(
        (frame) => frame.kind === 'binary' && frame.bytes[0] === FRAME.awareness,
        'the relayed awareness frame',
      );
      assert.equal(relayed.kind, 'binary');

      // The observer can apply it to its own Awareness and see the publisher.
      const observerDoc = new Y.Doc();
      const observerAwareness = createTestAwareness(observerDoc);
      if (relayed.kind === 'binary') {
        const decoded = decodeBinaryFrame(relayed.bytes);
        assert.ok(decoded.success);
        if (decoded.success && decoded.frame.kind === 'awareness') {
          const { applyAwarenessUpdate } = await import('y-protocols/awareness');
          applyAwarenessUpdate(observerAwareness, decoded.frame.bytes, 'test');
        }
      }
      const seen = observerAwareness.getStates().get(localAwareness.clientID);
      assert.ok(seen !== undefined, 'the observer saw the publisher through awareness');
      assert.equal((seen as { user: { name: string } }).user.name, 'Publisher');

      // Awareness is presence, never content: it must not have touched the document.
      const room = server.handle.registry.requireRoom('doc-awareness-relay');
      assert.equal(room.doc.getText('content').length, 0, 'awareness never becomes document text');

      localAwareness.destroy();
      observerAwareness.destroy();
      localDoc.destroy();
      observerDoc.destroy();
    } finally {
      publisher.destroy();
      observer.destroy();
    }
  });
});

describe('M1-A3 room isolation', () => {
  it('never delivers an update from document A to a socket in document B', async () => {
    const inA = await TestClient.connect(server.url);
    const inB = await TestClient.connect(server.url);

    try {
      await inA.joinAndWait('doc-isolation-a');
      await inB.joinAndWait('doc-isolation-b');

      const authorDoc = makePeerDocument('SECRET-CONTENT-FOR-A').doc;
      inA.sendBinary(syncUpdateFrame(authorDoc));

      // Give the server every chance to leak before asserting the negative.
      await inB.settle(200);

      assert.equal(
        inB.binaryFrames().length,
        0,
        'a socket in room B received a data-plane frame from room A',
      );
      assert.equal(
        server.handle.registry.requireRoom('doc-isolation-b').doc.getText('content').length,
        0,
        'room B’s document must not contain room A’s content',
      );
      assert.equal(
        server.handle.registry.requireRoom('doc-isolation-a').doc.getText('content').toString(),
        'SECRET-CONTENT-FOR-A',
        'room A did receive its own update',
      );
    } finally {
      inA.destroy();
      inB.destroy();
    }
  });

  it('keeps awareness inside the room it was published in', async () => {
    const inA = await TestClient.connect(server.url);
    const inB = await TestClient.connect(server.url);

    try {
      await inA.joinAndWait('doc-awareness-a');
      await inB.joinAndWait('doc-awareness-b');

      const doc = new Y.Doc();
      const awareness = createTestAwareness(doc);
      awareness.setLocalState(makeAwarenessState('OnlyInA'));
      inA.sendBinary(encodeAwarenessFrame(encodeAwarenessUpdate(awareness, [awareness.clientID])));

      await inB.settle(200);
      assert.equal(inB.binaryFrames().length, 0, 'room B saw no awareness from room A');
      assert.equal(
        server.handle.registry.requireRoom('doc-awareness-b').snapshot().awarenessEntryCount,
        0,
      );
      assert.equal(
        server.handle.registry.requireRoom('doc-awareness-a').snapshot().awarenessEntryCount,
        1,
      );

      awareness.destroy();
      doc.destroy();
    } finally {
      inA.destroy();
      inB.destroy();
    }
  });
});

describe('M1-A3 incremental sync (acceptance criterion 4)', () => {
  it('sends only the missing delta on reconnect, measured against the full document', async () => {
    const first = await TestClient.connect(server.url);

    try {
      await first.joinAndWait('doc-incremental');

      // A realistic document: a few hundred paragraphs is ordinary knowledge-base size,
      // large enough that "the whole document" and "the delta" differ by orders of
      // magnitude rather than by a handful of bytes.
      const author = new Y.Doc();
      const characters = fillDocument(author, 400);
      assert.ok(characters > 50_000, `fixture should be substantial, got ${characters} chars`);

      first.sendBinary(encodeSyncUpdate(Y.encodeStateAsUpdate(author)));
      const room = server.handle.registry.requireRoom('doc-incremental');
      await waitUntil(
        () => room.doc.getText('content').length >= characters,
        'the room holds the full document',
      );

      // (a) A client with NO state asks for everything: the reply is the full snapshot.
      const emptyClientDoc = new Y.Doc();
      const fullPayload = measureStep2Payload(room.doc, emptyClientDoc);

      // (b) A reconnecting client whose state vector already covers all but a small tail
      //     asks for the difference. This is the reconnect case in the contract: local
      //     state is loaded first, so the client already holds the document.
      const reconnectingDoc = new Y.Doc();
      Y.applyUpdate(reconnectingDoc, Y.encodeStateAsUpdate(author));
      const tailDoc = new Y.Doc();
      tailDoc.getText('content').insert(0, 'one new sentence after the reconnect');
      // The tail shares the author's client id space only if applied to the same doc;
      // applying it to the reconnecting doc models "I was offline and typed a little".
      Y.applyUpdate(reconnectingDoc, Y.encodeStateAsUpdate(tailDoc));

      const incrementalPayload = measureStep2Payload(room.doc, reconnectingDoc);

      // The assertion the task asks for, by measurement rather than by eyeball: the
      // incremental reply is a fraction of the full document, not a re-send of it.
      assert.ok(
        incrementalPayload < fullPayload,
        `incremental (${incrementalPayload}B) must be smaller than full (${fullPayload}B)`,
      );
      assert.ok(
        incrementalPayload * 10 < fullPayload,
        `incremental (${incrementalPayload}B) should be at least 10x smaller than full ` +
          `(${fullPayload}B), proving the reply is delta-driven`,
      );

      // And the same thing end-to-end on the wire, so the measurement is not merely a
      // property of calling the encoder directly.
      const reconnectSocket = await TestClient.connect(server.url);
      await reconnectSocket.joinAndWait('doc-incremental');
      reconnectSocket.clear();
      reconnectSocket.sendBinary(syncStep1Frame(reconnectingDoc));
      const relayedStep2 = await reconnectSocket.waitForFrame(
        (frame) => frame.kind === 'binary' && syncMessageTypeOf(frame.bytes) === 1,
        'SyncStep2 for the reconnecting client',
      );
      assert.equal(relayedStep2.kind, 'binary');
      if (relayedStep2.kind === 'binary') {
        assert.ok(
          relayedStep2.bytes.byteLength < fullPayload,
          'the wire reply to a reconnect is smaller than the full document',
        );
      }
      reconnectSocket.destroy();

      author.destroy();
      emptyClientDoc.destroy();
      reconnectingDoc.destroy();
      tailDoc.destroy();
    } finally {
      first.destroy();
    }
  });

  it('refuses to relay a frame larger than the shared ceiling', async () => {
    const client = await TestClient.connect(server.url);

    try {
      await client.joinAndWait('doc-oversize');

      // One byte over the codec's own limit. The codec checks `byteLength` before any
      // decode work, so this costs the server an error, not an allocation.
      const oversized = new Uint8Array(MAX_BINARY_FRAME_BYTES + 1);
      oversized[0] = FRAME.sync;
      oversized[1] = 2;
      client.sendBinary(oversized);

      const error = await client.waitForError(WS_ERROR_CODES.FRAME_TOO_LARGE, 15_000);
      assert.equal(error.payload.code, WS_ERROR_CODES.FRAME_TOO_LARGE);
      await client.waitForClose(15_000);
    } finally {
      client.destroy();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/**
 * Byte length of the SYNC payload the server would compute as SyncStep2 for `remote`.
 *
 * Uses the shared codec's own encoder with the state vector the remote client would
 * advertise in its SyncStep1, so the number is the real wire payload.
 */
function measureStep2Payload(roomDoc: Y.Doc, remote: Y.Doc): number {
  const frame = encodeSyncStep2(roomDoc, Y.encodeStateVector(remote));
  const decoded = decodeBinaryFrame(frame);
  assert.ok(decoded.success, 'the codec must accept a frame it produced');
  if (!decoded.success || decoded.frame.kind !== 'sync') {
    throw new Error('expected a sync frame');
  }
  // The payload on the wire is the frame minus the frame-type header.
  return frame.byteLength - 1;
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
