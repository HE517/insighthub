/**
 * The hydration barrier and the room state machine
 * (`docs/ARCHITECTURE.md` §7.5, §7.6; `docs/DECISIONS.md` D-043, D-049).
 *
 * Two obligations are singled out because they are easy to get wrong and impossible to notice
 * by reading the happy path:
 *
 * 1. **`UNHEALTHY` never returns to `READY`.** No method moves a room back, so a half-healed
 *    room cannot exist. Asserted structurally, not by convention.
 * 2. **A result that arrives after the client left must be discarded.** The barrier resolves
 *    asynchronously, so between "join" and "acknowledge" a socket can close or be atomically
 *    replaced into another room. Acknowledging the old room would tell a client it is
 *    somewhere it is not.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SYNC_MESSAGE_TYPES } from '@insighthub/shared';

import { DocumentRoom, HYDRATION_BACKLOG_MAX_FRAMES } from '../rooms/room.js';
import { TestClient, startTestServer } from '../rooms/test-harness.js';
import { openDocumentStore } from './open-store.js';
import { ControllableStore } from './test-stores.js';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'insighthub-barrier-'));
  tempRoots.push(root);
  return root;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${description}`);
    await sleep(10);
  }
}

describe('Room lifecycle state machine (D-049)', () => {
  it('walks CREATED → HYDRATING → READY and refuses illegal transitions', () => {
    const room = new DocumentRoom('doc-state');
    try {
      assert.equal(room.state, 'created');
      assert.equal(room.acceptsMutations, false, 'an empty room may not take updates');

      room.beginHydration();
      assert.equal(room.state, 'hydrating');
      assert.equal(room.acceptsMutations, false, 'HYDRATING must not accept mutations');
      assert.throws(
        () => room.beginHydration(),
        /cannot begin hydration from state hydrating/,
        'hydration is entered exactly once',
      );

      room.completeHydration();
      assert.equal(room.state, 'ready');
      assert.equal(room.acceptsMutations, true);
    } finally {
      room.destroy();
    }
  });

  it('never returns to READY from UNHEALTHY', () => {
    const room = new DocumentRoom('doc-unhealthy');
    try {
      room.beginHydration();
      room.completeHydration();
      assert.equal(room.state, 'ready');

      room.markUnhealthy('persist failed');
      assert.equal(room.state, 'unhealthy');
      assert.equal(room.unhealthyReason, 'persist failed');
      assert.equal(room.acceptsMutations, false);

      // The only exit is destruction: there is deliberately no method that re-enters READY.
      assert.throws(
        () => room.completeHydration(),
        /cannot complete hydration from state unhealthy/,
      );

      // Idempotent: a second failure (a heartbeat reap racing a persist failure) must not
      // overwrite the first cause or throw.
      room.markUnhealthy('something else');
      assert.equal(room.state, 'unhealthy');
      assert.equal(room.unhealthyReason, 'persist failed');
    } finally {
      room.destroy();
    }
  });

  it('drops the hydration backlog instead of replaying it after a failure', () => {
    const room = new DocumentRoom('doc-backlog-drop');
    try {
      room.beginHydration();
      const participant = {
        peer: {
          connectionId: 'c1',
          isOpen: () => true,
          sendControl: () => true,
          sendBinary: () => true,
          sendError: () => true,
          close: () => undefined,
          terminate: () => undefined,
        },
        awarenessClients: new Set<number>(),
      };

      const frame = { kind: 'sync' as const, bytes: new Uint8Array([0, 1]) };
      assert.equal(room.enqueueBacklog(participant, frame), 'queued');
      assert.equal(room.backlogFrames, 1);

      room.markUnhealthy('hydration failed');
      assert.equal(room.backlogFrames, 0, 'replaying it would publish state the room cannot keep');
      assert.deepEqual(room.drainBacklog(), []);
    } finally {
      room.destroy();
    }
  });

  it('refuses to apply Yjs payloads before the barrier releases', () => {
    const room = new DocumentRoom('doc-refuses-early');
    try {
      // A `SyncStep1` answered from a half-hydrated document would hand the client a delta
      // computed against state the server is about to replace.
      const participant = {
        peer: {
          connectionId: 'c1',
          isOpen: () => true,
          sendControl: () => true,
          sendBinary: () => true,
          sendError: () => true,
          close: () => undefined,
          terminate: () => undefined,
        },
        awarenessClients: new Set<number>(),
      };
      const frame = { kind: 'sync' as const, bytes: new Uint8Array([SYNC_MESSAGE_TYPES.step1, 0]) };
      assert.equal(room.replyToSyncStep1(frame, participant), false);
    } finally {
      room.destroy();
    }
  });

  it('bounds the backlog by frame count', () => {
    const room = new DocumentRoom('doc-backlog-bound');
    try {
      room.beginHydration();
      const participant = {
        peer: {
          connectionId: 'c1',
          isOpen: () => true,
          sendControl: () => true,
          sendBinary: () => true,
          sendError: () => true,
          close: () => undefined,
          terminate: () => undefined,
        },
        awarenessClients: new Set<number>(),
      };

      const frame = { kind: 'sync' as const, bytes: new Uint8Array([0, 1]) };
      for (let index = 0; index < HYDRATION_BACKLOG_MAX_FRAMES; index += 1) {
        assert.equal(room.enqueueBacklog(participant, frame), 'queued');
      }
      assert.equal(
        room.enqueueBacklog(participant, frame),
        'overflow',
        'one more than the bound is a server-side condition, reported as overflow',
      );
    } finally {
      room.destroy();
    }
  });
});

describe('Hydration barrier obligations over real sockets (D-049 obligation 1)', () => {
  it('sends no room-joined while the room is hydrating', async () => {
    const dir = tempRoot();
    const opened = await openDocumentStore(dir);
    const gated = new ControllableStore(opened.store);
    gated.holdLoads();

    const server = await startTestServer({ store: gated, logger: { warn: () => undefined } });
    const client = await TestClient.connect(server.url);
    try {
      client.join('doc-no-early-ack');
      await sleep(250);

      assert.equal(
        client.textMessages().filter((message) => message.type === 'room-joined').length,
        0,
        'HYDRATING must not acknowledge: room-joined is the gate before the data plane',
      );
      assert.equal(
        client.binaryFrames().length,
        0,
        'and nothing may arrive on the data plane either',
      );

      gated.releaseLoads();
      await waitFor(
        () => client.textMessages().some((message) => message.type === 'room-joined'),
        'the acknowledgement after the barrier releases',
      );
    } finally {
      gated.releaseLoads();
      client.destroy();
      await server.close();
    }
  });

  it('discards a delayed acknowledgement when the socket switched rooms mid-hydration', async () => {
    const dir = tempRoot();
    const opened = await openDocumentStore(dir);
    const gated = new ControllableStore(opened.store);
    gated.holdLoads();

    const server = await startTestServer({ store: gated, logger: { warn: () => undefined } });
    const client = await TestClient.connect(server.url);
    try {
      // Join A, then atomically replace it with B before either barrier resolves. Both
      // hydrations are held, so the A acknowledgement would land *after* the switch.
      client.join('doc-switch-a');
      await sleep(100);
      client.join('doc-switch-b');
      await sleep(100);

      assert.equal(
        client.textMessages().filter((message) => message.type === 'room-joined').length,
        0,
        'neither join may be acknowledged yet',
      );

      gated.releaseLoads();

      await waitFor(
        () => client.textMessages().some((message) => message.type === 'room-joined'),
        'the acknowledgement for the room the socket actually occupies',
      );
      // Give the discarded A result every chance to arrive late before asserting it did not.
      await sleep(250);

      const acknowledgements = client
        .textMessages()
        .flatMap((message) => (message.type === 'room-joined' ? [message.payload.documentId] : []));
      assert.deepEqual(
        acknowledgements,
        ['doc-switch-b'],
        'only the room the socket is in may be acknowledged; no delayed room-joined for A',
      );

      // And the abandoned room is gone rather than lingering with a phantom member.
      assert.equal(server.handle.registry.hasRoom('doc-switch-a'), false);
    } finally {
      gated.releaseLoads();
      client.destroy();
      await server.close();
    }
  });

  it('does not re-admit a socket that closed while its room was hydrating', async () => {
    const dir = tempRoot();
    const opened = await openDocumentStore(dir);
    const gated = new ControllableStore(opened.store);
    gated.holdLoads();

    const server = await startTestServer({ store: gated, logger: { warn: () => undefined } });
    const client = await TestClient.connect(server.url);
    try {
      client.join('doc-closed-mid-hydration');
      await sleep(150);
      assert.equal(server.handle.registry.roomCount(), 1, 'membership is applied synchronously');

      // The socket dies before the barrier resolves; the room has no members, so it is
      // evicted and the in-flight load result must be discarded.
      client.destroy();
      await waitFor(
        () => server.handle.registry.roomCount() === 0,
        'the memberless room to be evicted',
      );

      gated.releaseLoads();
      await sleep(250);

      assert.equal(
        server.handle.registry.roomCount(),
        0,
        'the discarded hydration must not resurrect a room for a socket that is gone',
      );
      assert.equal(server.handle.registry.connectionCount, 0);
    } finally {
      gated.releaseLoads();
      await server.close();
    }
  });
});
