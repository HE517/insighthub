/**
 * The M1 gateway: a **real A1 client** against a **real A3 server** (`docs/DECISIONS.md`
 * D-032).
 *
 * ## Why this file exists
 *
 * A1's suite runs its collaboration core against its own in-process server; A3's suite
 * runs its rooms against its own `TestClient`. Both were green while the two halves
 * disagreed, because each side was proving it matched the *shared codec*, not that it
 * matched the *other agent*. This file crosses that boundary: it imports A1's real
 * public seam (`createCollaborativeSession`) and boots A3's real server on a real
 * WebSocket, so only agreement on the wire can make it pass.
 *
 * It earned its place immediately: it caught A3 applying a `SyncStep2` payload with
 * `Y.applyUpdate` without unwrapping the `varint8Array` envelope, which threw
 * `Unexpected end of array` inside yjs during the handshake. Neither agent's own suite
 * could observe it (`docs/DECISIONS.md` D-029, D-032).
 *
 * ## What it does NOT prove
 *
 * IndexedDB persistence: `persistence: 'none'` is passed because Node has no IndexedDB.
 * A1's suite covers the wiring with a double, and the browser runbook in
 * `apps/web/src/collab/README.md` (owned by A6) is the only evidence for real browser
 * storage. Nothing here is evidence about a browser (`AGENTS.md` R5).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { WebSocket as WsClient } from 'ws';

import { createCollaborativeSession } from '../../../web/src/collab/public.js';
import { startTestServer, type TestServer } from './test-harness.js';

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

/** Per-test suffix so parallel or repeated runs cannot share a document or replica. */
let counter = 0;
function uniqueDocumentId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ClientHandle {
  session: Awaited<ReturnType<typeof createCollaborativeSession>>;
  /** The text this client currently holds, as a plain string. */
  text(): string;
  /** Wait until this client's text equals `expected`. */
  waitForText(expected: string, timeoutMs?: number): Promise<void>;
}

/** Create a real A1 session joined to the real A3 server. */
async function connectClient(documentId: string, name: string): Promise<ClientHandle> {
  const session = await createCollaborativeSession({
    documentId,
    user: { id: `user-${name}`, name },
    wsUrl: server.url,
    wsSocketFactory: WsClient,
    // No IndexedDB in Node; see the file header for what this does and does not cover.
    persistence: 'none',
  });

  const handle: ClientHandle = {
    session,
    text: () => session.text.toString(),
    async waitForText(expected, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (session.text.toString() === expected) return;
        if (Date.now() > deadline) {
          throw new Error(
            `[${name}] timed out waiting for text ${JSON.stringify(expected)}; ` +
              `holds ${JSON.stringify(session.text.toString())}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };

  // Wait for the room handshake before returning, so a caller's first edit is sent
  // rather than dropped. This is not a relaxed assertion: `sendSyncFrame` deliberately
  // drops data-plane frames before `room-joined` (`docs/CONTRACTS.md` §4,
  // `framesBeforeJoin`), so editing earlier would test that drop path instead of
  // convergence — a race in the harness, not in the code under test.
  await waitFor(() => session.connectionStatus === 'connected', `[${name}] to join the room`);
  return handle;
}

/** Wait until `predicate` holds, so a passing test never encodes machine speed. */
async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('M1 cross-agent integration: real A1 client ⇄ real A3 server', () => {
  it('converges client1 → server → client2', async () => {
    const documentId = uniqueDocumentId('doc-a1-a3-forward');
    const client1 = await connectClient(documentId, 'one');
    const client2 = await connectClient(documentId, 'two');

    try {
      assert.equal(client1.session.state, 'active');
      assert.equal(client2.session.state, 'active');

      client1.session.transact((text) => text.insert(0, 'written by client1'));

      await client2.waitForText('written by client1');
      assert.equal(client2.text(), 'written by client1');
    } finally {
      client1.session.destroy();
      client2.session.destroy();
    }
  });

  it('converges client2 → server → client1', async () => {
    const documentId = uniqueDocumentId('doc-a1-a3-reverse');
    const client1 = await connectClient(documentId, 'one');
    const client2 = await connectClient(documentId, 'two');

    try {
      // client1 seeds the document first, so client2 edits a non-empty buffer.
      client1.session.transact((text) => text.insert(0, 'seed'));
      await client2.waitForText('seed');

      client2.session.transact((text) => text.insert(text.length, ' + client2'));
      await client1.waitForText('seed + client2');
      assert.equal(client1.text(), 'seed + client2');
    } finally {
      client1.session.destroy();
      client2.session.destroy();
    }
  });

  it('keeps both sides editable while disconnected, then merges by state vector on reconnect', async () => {
    const documentId = uniqueDocumentId('doc-a1-a3-offline');
    const client1 = await connectClient(documentId, 'one');
    const client2 = await connectClient(documentId, 'two');

    try {
      client1.session.transact((text) => text.insert(0, 'shared base'));
      await client2.waitForText('shared base');

      // Sever client1's network path only: the session, the Y.Doc and its local edits stay.
      client1.session.disconnect();
      await waitFor(
        () => client1.session.connectionStatus !== 'connected',
        'client1 to observe its own disconnection',
      );

      // Both sides keep editing with no path between them.
      client1.session.transact((text) => text.insert(text.length, ' | offline-1'));
      client2.session.transact((text) => text.insert(text.length, ' | online-2'));

      assert.equal(client1.text(), 'shared base | offline-1');
      assert.equal(client2.text(), 'shared base | online-2');

      // Reconnect: client1 re-runs join → SyncStep1 with its state vector and receives
      // only the delta it is missing, rather than the whole document (§10.2, §10.3).
      client1.session.connect();
      await waitFor(
        () => client1.session.connectionStatus === 'connected',
        'client1 to rejoin the room',
      );

      // CRDT merge is order-independent, so no test may pin the interleaving of two
      // concurrent inserts at the same offset: either order is a valid convergence. The
      // invariant that matters is that both replicas agree and hold both edits.
      await waitFor(
        () =>
          client1.text() === client2.text() &&
          client1.text().includes('offline-1') &&
          client1.text().includes('online-2'),
        'both replicas to converge on both edits',
        12_000,
      );

      assert.equal(client1.text(), client2.text(), 'the two replicas must be equal documents');
      assert.match(
        client1.text(),
        /^shared base \| (offline-1 \| online-2|online-2 \| offline-1)$/,
      );
    } finally {
      client1.session.destroy();
      client2.session.destroy();
    }
  });

  it('publishes awareness that the peer sees through getCollaborators()', async () => {
    const documentId = uniqueDocumentId('doc-a1-a3-awareness');
    const client1 = await connectClient(documentId, 'one');
    const client2 = await connectClient(documentId, 'two');

    try {
      await waitFor(
        () => client2.session.getCollaborators().some((entry) => entry.user.name === 'one'),
        'client2 to see client1 as a collaborator',
      );

      const seen = client2.session.getCollaborators().find((entry) => entry.user.name === 'one');
      assert.ok(seen !== undefined, 'client1 must appear in client2 collaborators');
      // The entry came through schema validation, not a raw cast (R14).
      assert.equal(seen.user.id, 'user-one');
    } finally {
      client1.session.destroy();
      client2.session.destroy();
    }
  });

  it('leaves no ghost collaborator when a peer disconnects', async () => {
    const documentId = uniqueDocumentId('doc-a1-a3-ghost');
    const client1 = await connectClient(documentId, 'one');
    const client2 = await connectClient(documentId, 'two');

    try {
      await waitFor(
        () => client2.session.getCollaborators().some((entry) => entry.user.name === 'one'),
        'client2 to see client1 before the disconnect',
      );

      client1.session.destroy();

      await waitFor(
        () => !client2.session.getCollaborators().some((entry) => entry.user.name === 'one'),
        'client1 to disappear from client2 collaborators',
        12_000,
      );
    } finally {
      client1.session.destroy();
      client2.session.destroy();
    }
  });

  it('removes a peer from the old room when it switches documents (atomic replace)', async () => {
    const documentId = uniqueDocumentId('doc-a1-a3-replace-a');
    const otherDocumentId = uniqueDocumentId('doc-a1-a3-replace-b');
    const observer = await connectClient(documentId, 'observer');
    const mover = await connectClient(documentId, 'mover');

    try {
      await waitFor(
        () => observer.session.getCollaborators().some((entry) => entry.user.name === 'mover'),
        'the observer to see the mover in the first room',
      );

      // One socket carries one room (R15/§5.4), so a different document is a new session
      // and the old one is destroyed: the server must remove the mover's presence from
      // the first room rather than leave a ghost.
      mover.session.destroy();
      const moved = await connectClient(otherDocumentId, 'mover');

      try {
        await waitFor(
          () => !observer.session.getCollaborators().some((entry) => entry.user.name === 'mover'),
          'the mover to leave the first room presence',
          12_000,
        );

        // And the new room is reachable and isolated from the first.
        moved.session.transact((text) => text.insert(0, 'only in the second room'));
        await moved.waitForText('only in the second room');
        assert.equal(observer.text(), '');
      } finally {
        moved.session.destroy();
      }
    } finally {
      observer.session.destroy();
      mover.session.destroy();
    }
  });
});
