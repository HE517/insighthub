/**
 * M1-A3 room model: one socket = one room, idempotent re-join, atomic replace,
 * awareness cleanup, no-op leave, and last-client teardown.
 *
 * Every case drives a real socket against a real server on an ephemeral port. The
 * transition tests assert **negatively** as well as positively — "A's peers received
 * nothing more" and "the room the socket left holds no membership for it" are the
 * assertions that would catch a half-applied replace.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { WS_ERROR_CODES, decodeBinaryFrame } from '@insighthub/shared';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  TestClient,
  awarenessFrame,
  makeAwarenessState,
  makePeerDocument,
  startTestServer,
  syncUpdateFrame,
  type TestServer,
} from './test-harness.js';

let server: TestServer;
/**
 * Registry readings taken before each test, so the cleanup hook waits for this
 * test's own sockets to be reaped instead of guessing with a sleep.
 */
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
  // A terminated socket's close event is asynchronous, so wait for the registry to
  // return to its baseline. Without this, one test's teardown would be observed by the
  // next test's room/connection counts.
  await waitUntil(
    () =>
      server.handle.registry.connectionCount === connectionBaseline &&
      server.handle.registry.roomCount() === roomBaseline,
    'the registry returns to its pre-test state',
  );
});

/** Build an awareness frame for a brand-new client id. */
function awarenessFor(name: string): { frame: Uint8Array; clientId: number } {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState(makeAwarenessState(name));
  const update = encodeAwarenessUpdate(awareness, [awareness.clientID]);
  const clientId = awareness.clientID;
  // Awareness is ephemeral and never persisted, so tearing the local instance down once
  // the bytes exist is correct — and it avoids leaking its 3 s timer into the test
  // process (docs/DECISIONS.md D-015).
  awareness.destroy();
  doc.destroy();
  return { frame: awarenessFrame(update), clientId };
}

describe('M1-A3 room join', () => {
  it('joins a room and acknowledges with the initial roster', async () => {
    const peerOne = await TestClient.connect(server.url);
    const peerTwo = await TestClient.connect(server.url);
    try {
      const first = await peerOne.joinAndWait('doc-roster');
      assert.equal(first.documentId, 'doc-roster');
      assert.ok(first.connectionId.length > 0, 'room-joined carries this socket’s id');
      assert.deepEqual(first.peers, [], 'the first peer sees an empty roster');

      const second = await peerTwo.joinAndWait('doc-roster');
      assert.deepEqual(
        second.peers,
        [first.connectionId],
        'the second peer sees the first as its initial roster',
      );
      assert.notEqual(second.connectionId, first.connectionId);

      assert.equal(server.handle.registry.requireRoom('doc-roster').peerCount, 2);
    } finally {
      peerOne.destroy();
      peerTwo.destroy();
    }
  });

  it('is idempotent when the same socket re-joins the same room', async () => {
    const client = await TestClient.connect(server.url);
    const other = await TestClient.connect(server.url);
    try {
      const first = await client.joinAndWait('doc-idempotent');
      const otherJoined = await other.joinAndWait('doc-idempotent');

      const again = await client.joinAndWait('doc-idempotent');

      // Same room, same connection id, unchanged roster: a re-join must not add a second
      // membership entry for this socket.
      assert.equal(again.documentId, 'doc-idempotent');
      assert.equal(again.connectionId, first.connectionId);
      assert.deepEqual(again.peers, [otherJoined.connectionId]);

      const room = server.handle.registry.requireRoom('doc-idempotent');
      assert.equal(room.peerCount, 2, 'an idempotent re-join must not duplicate membership');
      const contexts = room.participants();
      assert.equal(new Set(contexts).size, contexts.length, 'each participant appears once');
    } finally {
      client.destroy();
      other.destroy();
    }
  });

  it('destroys the previous room when its only client moves to another document', async () => {
    const mover = await TestClient.connect(server.url);
    try {
      await mover.joinAndWait('doc-solo-a');
      assert.equal(server.handle.registry.hasRoom('doc-solo-a'), true);

      await mover.joinAndWait('doc-solo-b');

      // M1 has no persistence, so an empty room holds nothing worth keeping: it must be
      // gone immediately rather than lingering as a leak (decision D-024).
      assert.equal(server.handle.registry.hasRoom('doc-solo-a'), false, 'A was torn down');
      assert.equal(server.handle.registry.hasRoom('doc-solo-b'), true, 'B remains');
      assert.equal(server.handle.registry.roomCount(), roomBaseline + 1);
    } finally {
      mover.destroy();
    }
  });

  it('creates a room with no awareness entry of its own', async () => {
    const client = await TestClient.connect(server.url);
    try {
      await client.joinAndWait('doc-no-server-presence');
      const room = server.handle.registry.requireRoom('doc-no-server-presence');

      // `y-protocols`' Awareness constructor assigns itself a client id and publishes an
      // empty `{}` state. The server is a relay, not a participant: that phantom entry has
      // no `user`, so a peer would count a collaborator it cannot render (D-026).
      assert.deepEqual(
        room.snapshot().awarenessClientIds,
        [],
        'a fresh room must hold no awareness entries, least of all one for the server',
      );
      assert.equal(room.snapshot().awarenessEntryCount, 0);
      assert.equal(room.awareness.clientID, null, 'the server claims no awareness identity');
      assert.equal(room.awareness.getLocalState(), null);

      // And nothing is broadcast to the joining peer: awareness arrives only when a peer
      // publishes it. A spurious binary frame here would be the phantom entry on the wire.
      await client.settle(150);
      assert.equal(client.binaryFrames().length, 0, 'joining a room sends no presence frames');
    } finally {
      client.destroy();
    }
  });
});

describe('M1-A3 atomic room replace', () => {
  it('replaces A with B in one transition, leaving the socket in exactly one room', async () => {
    const mover = await TestClient.connect(server.url);
    const peerInA = await TestClient.connect(server.url);
    const peerInB = await TestClient.connect(server.url);

    try {
      const aJoined = await peerInA.joinAndWait('doc-replace-a');
      const bJoined = await peerInB.joinAndWait('doc-replace-b');
      await mover.joinAndWait('doc-replace-a');

      const roomA = server.handle.registry.requireRoom('doc-replace-a');
      const roomB = server.handle.registry.requireRoom('doc-replace-b');
      assert.equal(roomA.peerCount, 2);
      assert.equal(roomB.peerCount, 1);

      // The mover's context is observable only through the registry; capture it via the
      // participant set identity that the join established.
      const moverContext = roomA
        .participants()
        .find((entry) => !isPeerOf(entry, aJoined.connectionId));
      assert.ok(moverContext !== undefined, 'the mover is a participant of A');

      const replaced = await mover.joinAndWait('doc-replace-b');

      assert.equal(replaced.documentId, 'doc-replace-b');
      assert.deepEqual(
        replaced.peers,
        [bJoined.connectionId],
        'B’s roster contains only B’s existing peer',
      );

      // The single-field invariant, read straight off the server: the socket is absent
      // from A and present in B, and there is no third state.
      assert.equal(roomA.peerCount, 1, 'A lost the mover');
      assert.equal(roomB.peerCount, 2, 'B gained the mover');
      assert.equal(roomA.has(moverContext), false, 'the mover is not in A');
      assert.equal(roomB.has(moverContext), true, 'the mover is in B');

      // The single-field invariant, read straight off the connection's context: R15 is
      // structural, so there is no representation in which this points at two rooms.
      const moverSocketContext = server.handle.registry.contextFor(moverContext.peer);
      assert.ok(moverSocketContext !== undefined, 'the mover still has a live context');
      assert.equal(moverSocketContext.activeRoom, roomB, 'the context points at exactly one room');
      assert.equal(server.handle.registry.roomCount(), 2);
      assert.equal(roomA.destroyed, false, 'A still has a member, so it stays alive');
    } finally {
      mover.destroy();
      peerInA.destroy();
      peerInB.destroy();
    }
  });

  it('stops routing the old room’s updates to the mover once it has switched', async () => {
    const mover = await TestClient.connect(server.url);
    const peerInA = await TestClient.connect(server.url);
    const peerInB = await TestClient.connect(server.url);

    try {
      await peerInA.joinAndWait('doc-switch-a');
      await peerInB.joinAndWait('doc-switch-b');
      await mover.joinAndWait('doc-switch-a');

      await mover.joinAndWait('doc-switch-b');
      mover.clear();

      // A peer in A publishes a document update. The mover is no longer in A, so it must
      // never see it — this is the cross-room leak a non-atomic replace would produce.
      peerInA.sendBinary(syncUpdateFrame(makePeerDocument('only-visible-in-a').doc));
      await mover.settle(150);
      assert.equal(
        mover.binaryFrames().length,
        0,
        'the mover must receive nothing from the room it left',
      );

      // ...and it is still live in B.
      peerInB.sendBinary(syncUpdateFrame(makePeerDocument('visible-in-b').doc));
      await mover.waitForFrame(
        (frame) => frame.kind === 'binary',
        'an update relayed inside the room the mover actually occupies',
      );
    } finally {
      mover.destroy();
      peerInA.destroy();
      peerInB.destroy();
    }
  });

  it('removes and broadcasts the mover’s awareness in A, leaving no ghost cursor', async () => {
    const mover = await TestClient.connect(server.url);
    const peerInA = await TestClient.connect(server.url);

    try {
      await peerInA.joinAndWait('doc-ghost-a');
      await mover.joinAndWait('doc-ghost-a');

      const { frame, clientId: moverAwarenessClientId } = awarenessFor('mover');
      mover.sendBinary(frame);

      const roomA = server.handle.registry.requireRoom('doc-ghost-a');
      await waitUntil(
        () => roomA.snapshot().awarenessClientIds.includes(moverAwarenessClientId),
        'the server holds the mover’s awareness entry in A',
      );

      // A's surviving peer saw the presence arrive first.
      await peerInA.waitForFrame(
        (candidate) => candidate.kind === 'binary',
        'the relayed awareness update in A',
      );
      peerInA.clear();

      // The replace must remove A's entry for the mover and tell A's peers. Both
      // observations are true by the time A's former peer is told B was joined, so the
      // cleanup provably happened inside the replace rather than later.
      await mover.joinAndWait('doc-ghost-b');

      assert.equal(
        roomA.snapshot().awarenessEntryCount,
        0,
        'A must not keep a stale awareness entry for a client that left (no ghost)',
      );

      const removal = await peerInA.waitForFrame(
        (candidate) => candidate.kind === 'binary',
        'the awareness removal broadcast in A',
      );
      assert.equal(removal.kind, 'binary');
      if (removal.kind === 'binary') {
        // Asserted against the real client id, not merely "non-empty bytes": an empty
        // awareness body would also decode without throwing.
        assert.deepEqual(
          awarenessClientsOfFixture(removal.bytes),
          [moverAwarenessClientId],
          'the removal broadcast must name the client whose awareness was removed',
        );
      }
    } finally {
      mover.destroy();
      peerInA.destroy();
    }
  });
});

describe('M1-A3 leave-room', () => {
  it('is a no-op for a different document and keeps the current room', async () => {
    const client = await TestClient.connect(server.url);
    const peer = await TestClient.connect(server.url);

    try {
      await peer.joinAndWait('doc-leave-a');
      await client.joinAndWait('doc-leave-a');

      // `leave-room(B)` while in A: ignore it. Dropping A here would silently remove a
      // live room, which is the failure the cardinality table forbids.
      client.leave('some-other-document');
      await client.settle(80);
      assert.equal(
        server.handle.registry.requireRoom('doc-leave-a').peerCount,
        2,
        'A still holds both peers',
      );

      // Proof the socket is still routed into A: an update from the peer arrives.
      peer.sendBinary(syncUpdateFrame(makePeerDocument('still-in-a').doc));
      await client.waitForFrame(
        (frame) => frame.kind === 'binary',
        'an update proving the socket still belongs to A',
      );
    } finally {
      client.destroy();
      peer.destroy();
    }
  });

  it('removes membership on the matching leave-room and cleans its awareness', async () => {
    const client = await TestClient.connect(server.url);
    const peer = await TestClient.connect(server.url);

    try {
      await peer.joinAndWait('doc-leave-b');
      await client.joinAndWait('doc-leave-b');

      const { frame, clientId } = awarenessFor('leaver');
      client.sendBinary(frame);
      const room = server.handle.registry.requireRoom('doc-leave-b');
      await waitUntil(
        () => room.snapshot().awarenessClientIds.includes(clientId),
        'the server holds the leaver’s awareness entry',
      );

      peer.clear();
      client.leave('doc-leave-b');
      await waitUntil(() => room.peerCount === 1, 'the leaver is removed from the room');

      assert.equal(room.snapshot().awarenessEntryCount, 0, 'the leaver left no ghost cursor');
      await peer.waitForFrame(
        (candidate) => candidate.kind === 'binary',
        'the awareness removal broadcast for the explicit leave',
      );

      // After leaving, a data-plane frame is no longer routed, and the code is
      // non-fatal: the socket stays open.
      client.clear();
      client.sendBinary(syncUpdateFrame(makePeerDocument('after-leave').doc));
      const error = await client.waitForError(WS_ERROR_CODES.ROOM_NOT_JOINED);
      assert.equal(error.payload.code, WS_ERROR_CODES.ROOM_NOT_JOINED);
      assert.equal(client.closed, false, 'ROOM_NOT_JOINED is non-fatal');
    } finally {
      client.destroy();
      peer.destroy();
    }
  });

  it('destroys the server-side Y.Doc when the last client leaves', async () => {
    const client = await TestClient.connect(server.url);
    try {
      await client.joinAndWait('doc-destroy');
      const room = server.handle.registry.requireRoom('doc-destroy');

      client.sendBinary(syncUpdateFrame(makePeerDocument('some content').doc));
      await waitUntil(() => room.doc.getText('content').length > 0, 'the room applied the update');

      client.leave('doc-destroy');
      await waitUntil(
        () => !server.handle.registry.hasRoom('doc-destroy'),
        'the empty room is removed from the registry',
      );

      assert.equal(room.destroyed, true, 'the room released its awareness timer and Y.Doc');
    } finally {
      client.destroy();
    }
  });

  it('cleans up the room when the socket closes without a leave-room', async () => {
    const client = await TestClient.connect(server.url);
    await client.joinAndWait('doc-abrupt-close');
    assert.equal(server.handle.registry.hasRoom('doc-abrupt-close'), true);

    // `destroy()` severs the TCP connection with no close frame at all.
    client.destroy();

    await waitUntil(
      () => !server.handle.registry.hasRoom('doc-abrupt-close'),
      'the room is cleaned up after an abrupt disconnect',
    );
    assert.equal(server.handle.registry.connectionCount, connectionBaseline);
  });
});

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/** True when a participant entry belongs to the given connection id. */
function isPeerOf(entry: { peer: { connectionId: string } }, connectionId: string): boolean {
  return entry.peer.connectionId === connectionId;
}

/** Read the client ids an AWARENESS frame speaks for, using the shared codec. */
function awarenessClientsOfFixture(frame: Uint8Array): number[] {
  const decoded = decodeBinaryFrame(frame);
  assert.ok(decoded.success, 'the removal broadcast must be a decodable frame');
  assert.equal(decoded.frame?.kind, 'awareness', 'the removal broadcast must be AWARENESS');
  return decoded.success && decoded.frame.kind === 'awareness' ? decoded.frame.clients : [];
}

/**
 * Poll until `predicate` holds.
 *
 * Used only where the assertion is about server-side state that no wire message
 * announces — presence has exactly one channel (Yjs awareness) and no control-plane
 * message exists (D-021), so there is nothing to await on. Every other assertion waits
 * on an actual frame.
 */
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
