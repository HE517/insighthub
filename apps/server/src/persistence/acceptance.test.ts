/**
 * M2-P0-1 acceptance scenarios that can be proven **in one process** against real sockets:
 * A, D, E, F, G, H, I, J, K. Scenarios B and C need a real process death and live in
 * `restart.test.ts`.
 *
 * ## What "proven" means here
 *
 * Every scenario drives the production stack — real `ws` sockets, the real room registry,
 * the real hydration barrier, a real `node:sqlite` database in a temporary directory — and
 * then asserts on **durable state read back from disk**, not on the in-memory room. A test
 * that only checked `room.doc` would pass even if nothing had been written.
 *
 * The client half is implemented here against the shared codec (`encodeSyncStep1`,
 * `readSyncStep1StateVector`, `encodeSyncStep2`, …) rather than by importing A1's session, so
 * a failure in this file always points at the server. Cross-agent behaviour is covered by
 * `rooms/a1-a3.integration.test.ts` and, at the browser layer, by A6's suite.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  SYNC_MESSAGE_TYPES,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  decodeSyncFrame,
  readSyncMessageType,
  readSyncStep1StateVector,
} from '@insighthub/shared';
import { readSyncMessage } from 'y-protocols/sync';
import * as Y from 'yjs';

import { TestClient, TestDecoder, startTestServer } from '../rooms/test-harness.js';
import { applyStoredDocument } from './hydrator.js';
import { openDocumentStore } from './open-store.js';
import { ControllableStore, FaultInjectingStore } from './test-stores.js';
import type { DocumentStore } from './types.js';

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** A temporary directory this file owns and removes at the end. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'insighthub-acceptance-'));
  tempRoots.push(root);
  return root;
}

/* ------------------------------------------------------------------ *
 * Client half of the protocol
 * ------------------------------------------------------------------ */

/**
 * Merge every not-yet-seen SYNC frame into `doc`, and answer a server `SyncStep1`.
 *
 * Answering matters: the frozen handshake is client-initiated, but the server's reply is
 * `SyncStep2` **followed by its own `SyncStep1`**, and that second message is how the server
 * asks for edits it is missing. A client that ignores it can push nothing — which is exactly
 * the reconnect case in scenario C.
 */
async function pumpFrames(client: TestClient, doc: Y.Doc, fromIndex: number): Promise<number> {
  const frames = client.binaryFrames();
  for (let index = fromIndex; index < frames.length; index += 1) {
    const frame = frames[index];
    if (frame === undefined) continue;
    const decoded = decodeSyncFrame(frame);
    if (decoded === null) continue;

    if (readSyncMessageType(decoded) === SYNC_MESSAGE_TYPES.step1) {
      const serverStateVector = readSyncStep1StateVector(decoded);
      if (serverStateVector !== null) {
        client.sendBinary(encodeSyncStep2(doc, serverStateVector));
      }
      continue;
    }

    // `readSyncMessage` is `y-protocols`' own reader, which is the point: the test must not
    // grow a second interpretation of the sync body. It needs a lib0-shaped decoder, which
    // the harness provides because pnpm does not expose `lib0` to this package.
    readSyncMessage(
      new TestDecoder(decoded.bytes) as unknown as never,
      TestDecoder.scratchEncoder() as unknown as never,
      doc,
      'insighthub:remote',
    );
  }
  return frames.length;
}

/** Run the state-vector handshake and wait until the conversation goes quiet. */
async function syncClient(client: TestClient, doc: Y.Doc, settleMs = 120): Promise<void> {
  let index = client.binaryFrames().length;
  client.sendBinary(encodeSyncStep1(doc));

  let quietSince = Date.now();
  const deadline = Date.now() + 8_000;
  for (;;) {
    if (client.binaryFrames().length > index) {
      index = await pumpFrames(client, doc, index);
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince > settleMs) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the sync exchange to settle');
    await sleep(10);
  }
}

/** Join a room and reconcile the local replica with durable state. */
async function joinAndSync(client: TestClient, doc: Y.Doc, documentId: string): Promise<void> {
  await client.joinAndWait(documentId);
  await syncClient(client, doc);
}

/** Append text locally and return the incremental update that carries it. */
function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText('content');
  const before = Y.encodeStateVector(doc);
  text.insert(text.length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

/** Send one incremental edit over an existing room. */
function sendText(client: TestClient, doc: Y.Doc, value: string): Uint8Array {
  const update = appendText(doc, value);
  client.sendBinary(encodeSyncUpdate(update));
  return update;
}

/* ------------------------------------------------------------------ *
 * Durable-state assertions
 * ------------------------------------------------------------------ */

/** Rebuild a document from the durable store alone, the way a restarted server would. */
async function durableDoc(store: DocumentStore, documentId: string): Promise<Y.Doc | null> {
  const stored = await store.load(documentId);
  if (stored === null) return null;
  const doc = new Y.Doc();
  applyStoredDocument(stored, doc);
  return doc;
}

/** The rendered text of the durable state, or `null` when the document was never stored. */
async function durableText(store: DocumentStore, documentId: string): Promise<string | null> {
  const doc = await durableDoc(store, documentId);
  if (doc === null) return null;
  const text = doc.getText('content').toString();
  doc.destroy();
  return text;
}

/** Wait until `predicate` holds; fail with `description` if it never does. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${description}`);
    await sleep(10);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/* ------------------------------------------------------------------ *
 * Scenario A — the room is emptied, the document is not
 * ------------------------------------------------------------------ */

describe('Scenario A — content survives the room being evicted', () => {
  it('a brand-new client sees the text after the room was destroyed and reopened', async () => {
    const dir = tempRoot();

    // ---- 1. Write, while the room exists. ----
    const first = await startTestServer({ dataPath: dir });
    const writer = await TestClient.connect(first.url);
    const writerDoc = new Y.Doc();
    try {
      await joinAndSync(writer, writerDoc, 'doc-a-eviction');
      sendText(writer, writerDoc, 'written before the room was evicted');
      await waitFor(
        async () =>
          (await durableText(first.store, 'doc-a-eviction')) ===
          'written before the room was evicted',
        'the edit to reach durable storage',
      );
    } finally {
      writer.destroy();
    }

    // ---- 2. The last peer leaves, so the room is evicted (memory only). ----
    await waitFor(
      () => !first.handle.registry.hasRoom('doc-a-eviction'),
      'the room to be evicted from memory',
    );
    assert.equal(
      await durableText(first.store, 'doc-a-eviction'),
      'written before the room was evicted',
      'eviction must be memory-only (`docs/ARCHITECTURE.md` §7.9)',
    );
    await first.close();

    // ---- 3. A brand-new client opens the document. ----
    const second = await startTestServer({ dataPath: dir });
    const reader = await TestClient.connect(second.url);
    const readerDoc = new Y.Doc();
    try {
      await joinAndSync(reader, readerDoc, 'doc-a-eviction');
      assert.equal(
        readerDoc.getText('content').toString(),
        'written before the room was evicted',
        'a fresh room must hydrate the retained document, not start empty',
      );
    } finally {
      reader.destroy();
      await second.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scenario D — duplicate update replay
 * ------------------------------------------------------------------ */

describe('Scenario D — a duplicate update is stored twice and still applied once', () => {
  it('replays idempotently and does not corrupt the document', async () => {
    const dir = tempRoot();
    const server = await startTestServer({ dataPath: dir });
    const client = await TestClient.connect(server.url);
    const doc = new Y.Doc();
    try {
      await joinAndSync(client, doc, 'doc-duplicate');

      // The handshake itself can append one row (the client uploads its — here empty — state
      // via SyncStep2), so the duplicate assertion counts *from the current log*, not from
      // zero: what matters is that the same bytes are appended twice.
      const before = (await server.store.load('doc-duplicate'))?.updates.length ?? 0;

      const update = appendText(doc, 'duplicated');
      // The same bytes twice. `docs/DECISIONS.md` D-042 deliberately does **not** deduplicate
      // by content hash: Yjs structs are identified by `(clientID, clock)`, so replaying an
      // update is inert and the extra log row costs nothing.
      client.sendBinary(encodeSyncUpdate(update));
      client.sendBinary(encodeSyncUpdate(update));

      await waitFor(
        async () => (await durableText(server.store, 'doc-duplicate')) === 'duplicated',
        'the edit to be durable',
      );
      await waitFor(async () => {
        const stored = await server.store.load('doc-duplicate');
        return (stored?.updates.length ?? 0) >= before + 2;
      }, 'both duplicate rows to be appended');

      const stored = await server.store.load('doc-duplicate');
      assert.ok(stored !== null);
      if (stored === null) return;
      const appended = stored.updates.slice(before);
      assert.equal(appended.length, 2, 'the duplicate was stored twice, not silently deduplicated');
      assert.deepEqual(
        [...(appended[0]?.update ?? new Uint8Array(0))],
        [...(appended[1]?.update ?? new Uint8Array(1))],
        'both rows carry identical bytes',
      );

      const replayed = await durableDoc(server.store, 'doc-duplicate');
      assert.ok(replayed !== null);
      if (replayed === null) return;
      assert.equal(
        replayed.getText('content').toString(),
        'duplicated',
        'a duplicated update must not duplicate the text',
      );
      assert.equal(replayed.getText('content').length, 'duplicated'.length);
      replayed.destroy();
    } finally {
      client.destroy();
      await server.close();
    }

    // ---- Restart and re-read: still correct, still not doubled. ----
    const restarted = await startTestServer({ dataPath: dir });
    try {
      assert.equal(
        await durableText(restarted.store, 'doc-duplicate'),
        'duplicated',
        'replay after a restart must remain idempotent',
      );
    } finally {
      await restarted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scenario E — compaction
 * ------------------------------------------------------------------ */

describe('Scenario E — compaction preserves the document exactly', () => {
  it('crosses the update threshold, compacts, and reads back identically after a restart', async () => {
    const dir = tempRoot();
    const server = await startTestServer({ dataPath: dir });
    const client = await TestClient.connect(server.url);
    const doc = new Y.Doc();
    // Over the frozen 200-update threshold (`docs/DECISIONS.md` D-042), using many small
    // edits so the count triggers it rather than the byte threshold.
    const edits = 210;
    let expected = '';
    // Captured before the client goes away, compared after compaction + restart, so the
    // assertion is about the document and not only about the rendered string.
    let stateVectorBefore: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    try {
      await joinAndSync(client, doc, 'doc-compaction');
      for (let index = 0; index < edits; index += 1) {
        const fragment = `${index % 10}`;
        expected += fragment;
        sendText(client, doc, fragment);
      }

      await waitFor(
        async () => (await durableText(server.store, 'doc-compaction')) === expected,
        'all edits to be durable',
      );

      const storedBefore = await server.store.load('doc-compaction');
      assert.ok(storedBefore !== null);
      if (storedBefore === null) return;
      assert.ok(
        storedBefore.updates.length >= 200,
        `the log must cross the update threshold before compaction, had ${storedBefore.updates.length}`,
      );
      assert.equal(storedBefore.snapshotSequence, 0, 'nothing was compacted yet');

      stateVectorBefore = Y.encodeStateVector(doc);

      // Leaving is the sanctioned compaction moment: the durable write must not sit on the
      // update hot path (`docs/DECISIONS.md` D-042).
      client.destroy();
      await waitFor(
        () => !server.handle.registry.hasRoom('doc-compaction'),
        'the room to be evicted, which triggers compaction',
      );

      // Compaction is fired without blocking eviction, so wait for it to land.
      await waitFor(async () => {
        const stored = await server.store.load('doc-compaction');
        return stored !== null && stored.snapshotSequence > 0 && stored.updates.length === 0;
      }, 'compaction to fold the log into the snapshot');
    } finally {
      await server.close();
    }

    // ---- Restart and compare the document, not just its text. ----
    const restarted = await startTestServer({ dataPath: dir });
    const reader = await TestClient.connect(restarted.url);
    const readerDoc = new Y.Doc();
    try {
      const rehydrated = await durableDoc(restarted.store, 'doc-compaction');
      assert.ok(rehydrated !== null);
      if (rehydrated === null) return;

      assert.equal(
        rehydrated.getText('content').toString(),
        expected,
        'rendered text is unchanged',
      );
      assert.deepEqual(
        [...Y.encodeStateVector(rehydrated)],
        [...stateVectorBefore],
        'the Y.Doc state vector must be identical after compaction + restart',
      );
      rehydrated.destroy();

      // ...and a live client agrees with the durable state.
      await joinAndSync(reader, readerDoc, 'doc-compaction');
      assert.equal(readerDoc.getText('content').toString(), expected);
    } finally {
      reader.destroy();
      await restarted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scenario F — persistence failure is never presented as success
 * ------------------------------------------------------------------ */

describe('Scenario F — a persist failure is never claimed as success', () => {
  it('does not broadcast, reports INTERNAL_ERROR, and closes the participants', async () => {
    const dir = tempRoot();
    const opened = await openDocumentStore(dir);
    const faulty = new FaultInjectingStore(opened.store);
    const server = await startTestServer({ store: faulty, logger: { warn: () => undefined } });

    const author = await TestClient.connect(server.url);
    const peer = await TestClient.connect(server.url);
    const authorDoc = new Y.Doc();
    const peerDoc = new Y.Doc();

    try {
      await joinAndSync(author, authorDoc, 'doc-persist-failure');
      await joinAndSync(peer, peerDoc, 'doc-persist-failure');
      peer.clear();

      // Fail the very next append.
      faulty.failOnAttempt(faulty.attemptCount + 1);
      sendText(author, authorDoc, 'this must never be acknowledged');

      // ---- The peer must never be told this update landed (D-044). ----
      await peer.waitForError('INTERNAL_ERROR');
      await author.waitForError('INTERNAL_ERROR');
      await peer.waitForClose();
      await author.waitForClose();

      assert.equal(
        peer.binaryFrames().length,
        0,
        'a peer must not receive an update whose persist failed: broadcast happens only after commit',
      );

      // ---- The room is gone, so memory cannot drift from durable state. ----
      await waitFor(
        () => !server.handle.registry.hasRoom('doc-persist-failure'),
        'the unhealthy room to be removed from the registry',
      );

      // ---- Nothing of the failed update is durable. ----
      const durable = await durableText(server.store, 'doc-persist-failure');
      assert.ok(
        durable === null || durable === '',
        `the failed update must not be recoverable as content, found ${JSON.stringify(durable)}`,
      );
    } finally {
      author.destroy();
      peer.destroy();
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scenario G — durable document isolation
 * ------------------------------------------------------------------ */

describe('Scenario G — durable state of two documents is isolated', () => {
  it('never lets one document read, overwrite or truncate the other', async () => {
    const dir = tempRoot();
    const server = await startTestServer({ dataPath: dir });
    const clientA = await TestClient.connect(server.url);
    const clientB = await TestClient.connect(server.url);
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    try {
      await joinAndSync(clientA, docA, 'doc-g-a');
      await joinAndSync(clientB, docB, 'doc-g-b');

      sendText(clientA, docA, 'private to A');
      sendText(clientB, docB, 'private to B');

      await waitFor(
        async () =>
          (await durableText(server.store, 'doc-g-a')) === 'private to A' &&
          (await durableText(server.store, 'doc-g-b')) === 'private to B',
        'both documents to be durable and separate',
      );

      // A compaction of A must not disturb B (a shared sequence counter or a snapshot written
      // to the wrong row would surface here).
      clientA.destroy();
      await waitFor(
        () => !server.handle.registry.hasRoom('doc-g-a'),
        'document A’s room to be evicted',
      );
      assert.equal(await durableText(server.store, 'doc-g-b'), 'private to B');
    } finally {
      clientA.destroy();
      clientB.destroy();
      await server.close();
    }

    const restarted = await startTestServer({ dataPath: dir });
    try {
      assert.equal(await durableText(restarted.store, 'doc-g-a'), 'private to A');
      assert.equal(await durableText(restarted.store, 'doc-g-b'), 'private to B');
    } finally {
      await restarted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scenario H — concurrent submission, ordered commit, ordered broadcast
 * ------------------------------------------------------------------ */

describe('Scenario H — concurrent submissions commit before broadcast', () => {
  it('holds the persist, proves nothing was broadcast, then commits and converges after restart', async () => {
    const dir = tempRoot();
    const opened = await openDocumentStore(dir);
    const controllable = new ControllableStore(opened.store);
    const server = await startTestServer({
      store: controllable,
      logger: { warn: () => undefined },
    });

    const peerOne = await TestClient.connect(server.url);
    const peerTwo = await TestClient.connect(server.url);
    const observer = await TestClient.connect(server.url);
    const docOne = new Y.Doc();
    const docTwo = new Y.Doc();
    const observerDoc = new Y.Doc();

    try {
      await joinAndSync(peerOne, docOne, 'doc-concurrent-commit');
      await joinAndSync(peerTwo, docTwo, 'doc-concurrent-commit');
      await joinAndSync(observer, observerDoc, 'doc-concurrent-commit');
      observer.clear();

      // Hold every append: while a persist is in flight, no peer may have been told anything.
      const appendsBefore = controllable.appendCalls;
      controllable.holdAppends();
      sendText(peerOne, docOne, 'from-one ');
      sendText(peerTwo, docTwo, 'from-two');

      await sleep(150);
      assert.equal(
        observer.binaryFrames().length,
        0,
        'no broadcast may happen before the corresponding append commits (D-044)',
      );

      controllable.releaseAppends();

      // Both updates must now arrive, each strictly after its own commit.
      await waitFor(
        () => observer.binaryFrames().length >= 2,
        'both updates to be broadcast after their commits',
      );
      assert.equal(
        controllable.appendCalls - appendsBefore,
        2,
        'exactly one append per submitted update',
      );

      // The log is a total order with strictly increasing sequences. (The handshake itself
      // appends a row per client, so this asserts the ordering property rather than an
      // absolute row count.)
      await waitFor(async () => {
        const stored = await server.store.load('doc-concurrent-commit');
        if (stored === null) return false;
        const sequences = stored.updates.map((row) => row.sequence);
        return (
          sequences.length >= 2 &&
          sequences.every((value, index) => index === 0 || value > (sequences[index - 1] as number))
        );
      }, 'a strictly increasing commit order');

      const durable = await durableText(server.store, 'doc-concurrent-commit');
      assert.ok(durable !== null);
      assert.ok(
        durable.includes('from-one'),
        `durable state must contain peer one's edit: ${durable}`,
      );
      assert.ok(
        durable.includes('from-two'),
        `durable state must contain peer two's edit: ${durable}`,
      );
    } finally {
      peerOne.destroy();
      peerTwo.destroy();
      observer.destroy();
      await server.close();
    }

    // ---- Restart: the two concurrent edits are both there, fully converged. ----
    const restarted = await startTestServer({ dataPath: dir });
    const reader = await TestClient.connect(restarted.url);
    const readerDoc = new Y.Doc();
    try {
      await joinAndSync(reader, readerDoc, 'doc-concurrent-commit');
      const text = readerDoc.getText('content').toString();
      assert.ok(text.includes('from-one') && text.includes('from-two'), `after restart: ${text}`);
      assert.equal(text, await durableText(restarted.store, 'doc-concurrent-commit'));
    } finally {
      reader.destroy();
      await restarted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scenario I — the first failure stops the pipeline
 * ------------------------------------------------------------------ */

describe('Scenario I — the pipeline stops permanently at the first failure', () => {
  it('skips the queued mutation, keeps committed history, and lets the author re-send', async () => {
    const dir = tempRoot();
    const opened = await openDocumentStore(dir);
    const faulty = new FaultInjectingStore(opened.store);
    const server = await startTestServer({ store: faulty, logger: { warn: () => undefined } });

    const author = await TestClient.connect(server.url);
    const observer = await TestClient.connect(server.url);
    // The author's own replica is what makes recovery possible without a special case
    // (`docs/DECISIONS.md` D-044 point 4). It is the *same* `Y.Doc` the author was editing —
    // same client id, same clocks — so re-sending its missing structs completes the server's
    // document rather than duplicating text.
    const authorDoc = new Y.Doc();
    const observerDoc = new Y.Doc();

    try {
      await joinAndSync(author, authorDoc, 'doc-pipeline-stop');
      await joinAndSync(observer, observerDoc, 'doc-pipeline-stop');
      observer.clear();

      // Attempt 1 (of the three below) commits, attempt 2 fails, attempt 3 is queued behind
      // it. `+ 2` rather than `+ 1` because each handshake also appends one row (the client
      // uploading its own state), so the first *edit* is not the first append overall.
      const attemptsBefore = faulty.attemptCount;
      faulty.failOnAttempt(attemptsBefore + 2);

      const firstUpdate = appendText(authorDoc, 'committed ');
      const secondUpdate = appendText(authorDoc, 'must-fail ');
      const thirdUpdate = appendText(authorDoc, 'queued-must-not-run');

      // All three are submitted in one tick, so 2 and 3 are genuinely queued when 2 fails.
      author.sendBinary(encodeSyncUpdate(firstUpdate));
      author.sendBinary(encodeSyncUpdate(secondUpdate));
      author.sendBinary(encodeSyncUpdate(thirdUpdate));

      await author.waitForError('INTERNAL_ERROR');
      await author.waitForClose();
      await observer.waitForClose();

      // ---- The queued mutation was never attempted (D-048 point 4). ----
      assert.equal(
        faulty.attemptCount - attemptsBefore,
        2,
        `only the committing and the failing append may have been attempted, got ` +
          `${faulty.attemptCount - attemptsBefore}`,
      );

      // ---- Nothing after the committed update was written or broadcast. ----
      await waitFor(
        () => !server.handle.registry.hasRoom('doc-pipeline-stop'),
        'the unhealthy room to be removed',
      );
      const durable = await durableText(server.store, 'doc-pipeline-stop');
      assert.equal(durable, 'committed ', 'only the pre-failure commit may be durable');
    } finally {
      author.destroy();
      observer.destroy();
      await server.close();
    }

    // ---- Restart with a healthy store: history before the failure survives. ----
    const restarted = await startTestServer({ dataPath: dir });
    try {
      assert.equal(await durableText(restarted.store, 'doc-pipeline-stop'), 'committed ');

      // ---- The author reconnects holding its replica and fills the gap. ----
      const resumed = await TestClient.connect(restarted.url);
      try {
        // `authorDoc` still holds all three edits, exactly as a real client's Y.Doc would: the
        // one that was never persisted and the one that was never even attempted.
        assert.equal(
          authorDoc.getText('content').toString(),
          'committed must-fail queued-must-not-run',
        );

        await joinAndSync(resumed, authorDoc, 'doc-pipeline-stop');

        await waitFor(
          async () =>
            (await durableText(restarted.store, 'doc-pipeline-stop')) ===
            'committed must-fail queued-must-not-run',
          'the reconnecting author to restore the missing edits',
        );
      } finally {
        resumed.destroy();
      }

      // ...and a brand-new client sees the restored document.
      const fresh = await TestClient.connect(restarted.url);
      const freshDoc = new Y.Doc();
      try {
        await joinAndSync(fresh, freshDoc, 'doc-pipeline-stop');
        assert.equal(
          freshDoc.getText('content').toString(),
          'committed must-fail queued-must-not-run',
        );
      } finally {
        fresh.destroy();
      }
    } finally {
      await restarted.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scenario J — single-flight hydration
 * ------------------------------------------------------------------ */

describe('Scenario J — concurrent joins share exactly one hydration', () => {
  it('loads a cold document once and gives every joiner the same replica', async () => {
    const dir = tempRoot();

    // Seed durable state before the server exists, so the document is genuinely "cold".
    const seeded = await openDocumentStore(dir);
    const seedDoc = new Y.Doc();
    const seedUpdate = appendText(seedDoc, 'existing content');
    await seeded.store.append('doc-single-flight', seedUpdate);
    seedDoc.destroy();
    await seeded.store.close();

    const opened = await openDocumentStore(dir);
    const gated = new ControllableStore(opened.store);
    // Hold the load so every join necessarily overlaps the same hydration.
    gated.holdLoads();

    const server = await startTestServer({ store: gated, logger: { warn: () => undefined } });
    const clients: TestClient[] = [];
    const docs: Y.Doc[] = [];

    try {
      const joiners = 5;
      for (let index = 0; index < joiners; index += 1) {
        const client = await TestClient.connect(server.url);
        clients.push(client);
        const doc = new Y.Doc();
        docs.push(doc);
        client.join('doc-single-flight');
      }

      // No acknowledgement may arrive while the barrier is closed (D-049: HYDRATING sends no
      // room-joined).
      await sleep(200);
      for (const [index, client] of clients.entries()) {
        assert.equal(
          client.textMessages().filter((message) => message.type === 'room-joined').length,
          0,
          `joiner ${index} must not be acknowledged before hydration completes`,
        );
      }

      assert.equal(gated.loadCalls, 1, 'concurrent joins must share one load, not one per socket');
      assert.equal(server.handle.registry.roomCount(), 1, 'exactly one room per document');

      // Release the barrier: everybody is acknowledged and hydrated from the same replica.
      gated.releaseLoads();

      await waitFor(
        () =>
          clients.every(
            (client) =>
              client.textMessages().filter((message) => message.type === 'room-joined').length ===
              1,
          ),
        'every joiner to be acknowledged exactly once',
      );

      // Every client must see the seeded content and the same single room's Y.Doc.
      const writers = clients.map((client, index) => ({ client, doc: docs[index] as Y.Doc }));
      for (const { client, doc } of writers) {
        await syncClient(client, doc);
        assert.equal(
          doc.getText('content').toString(),
          'existing content',
          'every joiner must hydrate the stored content',
        );
      }

      const snapshot = server.handle.registry.requireRoom('doc-single-flight').snapshot();
      assert.equal(snapshot.peerCount, clients.length, 'all joiners share one room');
    } finally {
      gated.releaseLoads();
      for (const client of clients) client.destroy();
      for (const doc of docs) doc.destroy();
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scenario K — hydration backlog overflow
 * ------------------------------------------------------------------ */

describe('Scenario K — backlog overflow is a lifecycle failure, not a frame-size failure', () => {
  it('answers INTERNAL_ERROR and closes, and never claims FRAME_TOO_LARGE', async () => {
    const dir = tempRoot();
    const opened = await openDocumentStore(dir);
    const gated = new ControllableStore(opened.store);
    gated.holdLoads();

    const server = await startTestServer({ store: gated, logger: { warn: () => undefined } });
    const client = await TestClient.connect(server.url);
    const doc = new Y.Doc();

    try {
      // Join while the room can never finish hydrating, so only the bounded backlog stands
      // between the client and the room.
      client.join('doc-backlog-overflow');
      await sleep(100);

      // More frames than the backlog allows. Each is individually a valid, small SYNC frame:
      // the failure being provoked is cumulative, which is exactly why it must not be reported
      // as an oversized frame (`docs/DECISIONS.md` D-050).
      const frames = 400;
      for (let index = 0; index < frames; index += 1) {
        const update = appendText(doc, 'x');
        client.sendBinary(encodeSyncUpdate(update));
      }

      const error = await client.waitForError('INTERNAL_ERROR', 15_000);
      assert.equal(error.payload.code, 'INTERNAL_ERROR');
      await client.waitForClose(15_000);

      // The forbidden outcome: telling the client its frame was too large would send it off
      // shrinking frames while the real problem is that the server never finished hydrating.
      const codes = client
        .textMessages()
        .flatMap((message) => (message.type === 'error' ? [message.payload.code] : []));
      assert.ok(
        !codes.includes('FRAME_TOO_LARGE'),
        `backlog overflow must never be reported as FRAME_TOO_LARGE, saw ${codes.join(', ')}`,
      );
      assert.ok(codes.includes('INTERNAL_ERROR'));

      // ---- The server itself must survive. ----
      await waitFor(
        () => !server.handle.registry.hasRoom('doc-backlog-overflow'),
        'the failed room to be removed',
      );
      const survivor = await TestClient.connect(server.url);
      assert.equal(
        server.handle.clientCount(),
        1,
        'the server accepts new connections after the failure',
      );
      survivor.destroy();
    } finally {
      gated.releaseLoads();
      client.destroy();
      doc.destroy();
      await server.close();
    }
  });
});
