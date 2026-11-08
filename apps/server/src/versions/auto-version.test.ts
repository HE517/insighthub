/**
 * D-V2 — **automatic document versions** (P0-1 pre-requisite 1).
 *
 * ## What is proven here
 *
 * | # | Claim |
 * | --- | --- |
 * | 1 | the policy is "first body change immediately, then at most once per 10 minutes" and nothing else captures |
 * | 2 | a real socket edit through the real registry, real `Y.Doc` room and real SQLite produces exactly one `auto` row |
 * | 3 | a second real edit inside the interval produces no row; advancing the injected clock makes the next edit produce one |
 * | 4 | an empty update (a join's `SyncStep2`) and a repeated identical body never produce a row |
 * | 5 | a failing capture leaves the edit committed, the room healthy and the author unerrored; the next edit retries successfully |
 *
 * ## Why the clock is injected instead of slept
 *
 * The interval is ten minutes. The registry takes `now` (`RoomRegistryOptions.now`) and the
 * capture passes the same instant to the store, so "advance ten minutes" is one assignment. The
 * rest of the path is untouched: real `ws` clients, a real `Y.Doc` room, real SQLite, the real
 * authorization service.
 *
 * `contentChanged` is the D-RC1 signal from the `Y.Text` delta, so claim 4 is not "the update
 * bytes were different" — it is "the body did not change", which is what the product rule says.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import * as Y from 'yjs';

import { isDocumentMetaStore } from '../persistence/document-meta.js';
import {
  isDocumentVersionStore,
  type DocumentVersionStore,
  type StoredDocumentVersion,
} from '../persistence/document-versions.js';
import { applyStoredDocument } from '../persistence/hydrator.js';
import { openDocumentStore } from '../persistence/open-store.js';
import { WrappedStore } from '../persistence/test-stores.js';
import type { DocumentStore } from '../persistence/types.js';
import {
  AUTO_VERSION_MIN_INTERVAL_MS,
  AUTO_VERSION_SYSTEM_AUTHOR,
  decideAutoVersionCapture,
  latestAutoVersionCapturedAt,
} from '../versions/auto-version.js';
import { versionText } from '../versions/restore.js';
import {
  bootstrapSessionCookie,
  startTestServer,
  syncUpdateFrame,
  syncUpdateFrameFromBytes,
  TestClient,
  type TestServer,
} from '../rooms/test-harness.js';

/** Owner of `demo-document` in the demo fixture. */
const DOC = 'demo-document';
/** Owner-only demo document, used where an untouched document is needed. */
const PRIVATE_DOC = 'demo-private-notes';
const OWNER = 'demo-ada';
const EDITOR = 'demo-grace';

const T0 = Date.UTC(2026, 4, 1, 9, 0, 0);

/* ------------------------------------------------------------------ *
 * Pure policy
 * ------------------------------------------------------------------ */

describe('D-V2 auto-version policy', () => {
  const base = { contentChanged: true, now: T0 };

  it('captures the first real body change immediately', () => {
    assert.deepEqual(decideAutoVersionCapture({ ...base, lastAutoCapturedAt: null }), {
      capture: true,
      reason: 'first',
    });
  });

  it('does not capture inside the ten-minute interval', () => {
    assert.deepEqual(
      decideAutoVersionCapture({
        ...base,
        lastAutoCapturedAt: T0 - (AUTO_VERSION_MIN_INTERVAL_MS - 1),
      }),
      { capture: false, reason: 'too_soon' },
    );
  });

  it('captures at exactly ten minutes and later', () => {
    assert.deepEqual(
      decideAutoVersionCapture({
        ...base,
        lastAutoCapturedAt: T0 - AUTO_VERSION_MIN_INTERVAL_MS,
      }),
      { capture: true, reason: 'due' },
    );
    assert.deepEqual(
      decideAutoVersionCapture({
        ...base,
        lastAutoCapturedAt: T0 - AUTO_VERSION_MIN_INTERVAL_MS - 1,
      }),
      { capture: true, reason: 'due' },
    );
  });

  it('never captures an unchanged body, even when the interval has elapsed', () => {
    assert.deepEqual(
      decideAutoVersionCapture({
        contentChanged: false,
        lastAutoCapturedAt: T0 - AUTO_VERSION_MIN_INTERVAL_MS * 10,
        now: T0,
      }),
      { capture: false, reason: 'unchanged' },
    );
  });

  it('treats a backwards clock as "too soon" rather than "due"', () => {
    assert.deepEqual(decideAutoVersionCapture({ ...base, lastAutoCapturedAt: T0 + 60_000 }), {
      capture: false,
      reason: 'too_soon',
    });
  });

  it('reads the newest auto timestamp, ignoring other kinds and unparsable rows', () => {
    const versions = [
      { kind: 'pre-restore', createdAt: new Date(T0).toISOString() },
      { kind: 'auto', createdAt: new Date(T0 - 20 * 60_000).toISOString() },
      { kind: 'auto', createdAt: new Date(T0 - 5 * 60_000).toISOString() },
      { kind: 'manual', createdAt: new Date(T0 - 60_000).toISOString() },
      { kind: 'auto', createdAt: 'not-a-date' },
    ] as unknown as Parameters<typeof latestAutoVersionCapturedAt>[0];
    assert.equal(latestAutoVersionCapturedAt(versions), T0 - 5 * 60_000);
    assert.equal(latestAutoVersionCapturedAt([]), null);
  });
});

/* ------------------------------------------------------------------ *
 * Real store / room / socket integration
 * ------------------------------------------------------------------ */

interface Harness {
  readonly server: TestServer;
  readonly store: DocumentStore;
  readonly clock: { now: number };
  close(): Promise<void>;
}

async function boot(
  options: { wrapStore?: (store: DocumentStore) => DocumentStore } = {},
): Promise<Harness> {
  const clock = { now: T0 };
  const server = await startTestServer({
    authorization: 'enforced',
    now: () => clock.now,
    ...(options.wrapStore === undefined ? {} : { wrapStore: options.wrapStore }),
  });
  return {
    server,
    store: server.store,
    clock,
    close: async () => {
      await server.close();
    },
  };
}

async function session(server: TestServer, userId = OWNER): Promise<string> {
  return await bootstrapSessionCookie(server.httpUrl, userId);
}

/**
 * Poll until `predicate` holds; bounded so a bug fails instead of hanging the gate.
 *
 * The auto capture runs *after* the broadcast inside the FIFO task, so "the update is persisted"
 * is not enough to prove it finished. Tests therefore wait for `mutationQueueDepth === 0` after
 * the expected log length: only then has the capture had its turn.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function updateCount(store: DocumentStore, documentId: string): Promise<number> {
  return (await store.load(documentId))?.updates.length ?? 0;
}

async function durableText(store: DocumentStore, documentId: string): Promise<string | null> {
  const stored = await store.load(documentId);
  if (stored === null) return null;
  const doc = new Y.Doc();
  try {
    applyStoredDocument(stored, doc);
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
  }
}

async function autoVersions(
  store: DocumentStore,
  documentId: string,
): Promise<readonly StoredDocumentVersion[]> {
  assert.ok(isDocumentVersionStore(store), 'the harness store must serve versions');
  const summaries = await store.listDocumentVersions(documentId);
  const rows: StoredDocumentVersion[] = [];
  for (const summary of summaries) {
    if (summary.kind !== 'auto') continue;
    const stored = await store.readDocumentVersion(documentId, summary.id);
    assert.notEqual(stored, null);
    if (stored !== null) rows.push(stored);
  }
  return rows;
}

/** Wait until the room's FIFO has no task for the document (the capture has run or been skipped). */
async function waitForSlotIdle(server: TestServer, documentId: string): Promise<void> {
  await waitFor(
    () => server.handle.registry.mutationQueueDepth(documentId) === 0,
    'the FIFO slot is idle',
  );
}

describe('D-V2 auto-version capture on the real path', () => {
  it('captures exactly one auto version for the first body change, then respects the interval', async () => {
    let harness: Harness | null = null;
    let client: TestClient | null = null;
    try {
      harness = await boot();
      const { server, store, clock } = harness;
      client = await TestClient.connect(server.url, { cookie: await session(server) });
      await client.joinAndWait(DOC);

      // ---- first real edit: the "first version" -------------------------------------------
      const doc = new Y.Doc();
      try {
        doc.getText('content').insert(0, 'hello');
        client.sendBinary(syncUpdateFrame(doc));
        await waitFor(async () => (await updateCount(store, DOC)) === 1, 'the edit is persisted');
        await waitForSlotIdle(server, DOC);

        const first = await autoVersions(store, DOC);
        assert.equal(first.length, 1, 'the first body change captures one auto version');
        const revision = await (
          store as DocumentStore & DocumentVersionStore
        ).documentContentRevision(DOC);
        assert.equal(first[0]?.sequence, revision, 'sequence is the content revision it captured');
        assert.equal(first[0]?.authorId, OWNER, 'author is the commit participant');
        assert.equal(first[0]?.kind, 'auto');
        assert.equal(versionText(first[0] as StoredDocumentVersion), 'hello');
        assert.equal(first[0]?.createdAt, new Date(clock.now).toISOString());

        // ---- second edit inside ten minutes: no row ----------------------------------------
        clock.now = T0 + AUTO_VERSION_MIN_INTERVAL_MS - 60_000;
        const beforeSecond = Y.encodeStateVector(doc);
        doc.getText('content').insert(doc.getText('content').length, ' world');
        client.sendBinary(syncUpdateFrameFromBytes(Y.encodeStateAsUpdate(doc, beforeSecond)));
        await waitFor(
          async () => (await updateCount(store, DOC)) === 2,
          'the second edit persists',
        );
        await waitForSlotIdle(server, DOC);
        assert.equal(
          (await autoVersions(store, DOC)).length,
          1,
          'a second edit inside the interval must not capture',
        );
        assert.equal(await durableText(store, DOC), 'hello world', 'the edit itself is committed');

        // ---- clock advances ten minutes: the next edit captures ----------------------------
        clock.now = T0 + AUTO_VERSION_MIN_INTERVAL_MS;
        const beforeThird = Y.encodeStateVector(doc);
        doc.getText('content').insert(doc.getText('content').length, '!');
        client.sendBinary(syncUpdateFrameFromBytes(Y.encodeStateAsUpdate(doc, beforeThird)));
        await waitFor(async () => (await updateCount(store, DOC)) === 3, 'the third edit persists');
        await waitForSlotIdle(server, DOC);

        const second = await autoVersions(store, DOC);
        assert.equal(second.length, 2, 'the elapsed interval captures again');
        assert.equal(versionText(second[0] as StoredDocumentVersion), 'hello world!');
        assert.equal(
          second[0]?.sequence,
          await (store as DocumentStore & DocumentVersionStore).documentContentRevision(DOC),
        );
      } finally {
        doc.destroy();
      }
    } finally {
      client?.socket.close();
      await harness?.close();
    }
  });

  it('does not capture for an empty update and does capture for the first real edit after it', async () => {
    let harness: Harness | null = null;
    let client: TestClient | null = null;
    try {
      harness = await boot();
      const { server, store } = harness;
      client = await TestClient.connect(server.url, { cookie: await session(server) });
      await client.joinAndWait(PRIVATE_DOC);

      // A join's empty `SyncStep2`: no text structs, so no body change.
      const empty = new Y.Doc();
      try {
        client.sendBinary(syncUpdateFrame(empty));
        await waitFor(
          async () => (await updateCount(store, PRIVATE_DOC)) === 1,
          'the empty update is persisted',
        );
        await waitForSlotIdle(server, PRIVATE_DOC);
        assert.equal(
          (await autoVersions(store, PRIVATE_DOC)).length,
          0,
          'an empty update must not consume the first-version slot',
        );
      } finally {
        empty.destroy();
      }

      const real = new Y.Doc();
      try {
        real.getText('content').insert(0, 'real content');
        client.sendBinary(syncUpdateFrame(real));
        await waitFor(
          async () => (await updateCount(store, PRIVATE_DOC)) === 2,
          'the real edit is persisted',
        );
        await waitForSlotIdle(server, PRIVATE_DOC);
        const captured = await autoVersions(store, PRIVATE_DOC);
        assert.equal(captured.length, 1);
        assert.equal(versionText(captured[0] as StoredDocumentVersion), 'real content');
      } finally {
        real.destroy();
      }
    } finally {
      client?.socket.close();
      await harness?.close();
    }
  });

  it('does not capture when the same body is sent again, even after ten minutes', async () => {
    let harness: Harness | null = null;
    let client: TestClient | null = null;
    try {
      harness = await boot();
      const { server, store, clock } = harness;
      client = await TestClient.connect(server.url, { cookie: await session(server) });
      await client.joinAndWait(DOC);

      const doc = new Y.Doc();
      try {
        doc.getText('content').insert(0, 'same body');
        const frame = syncUpdateFrame(doc);
        client.sendBinary(frame);
        await waitFor(async () => (await updateCount(store, DOC)) === 1, 'the edit is persisted');
        await waitForSlotIdle(server, DOC);
        assert.equal((await autoVersions(store, DOC)).length, 1);

        // Same state, ten minutes later: `contentChanged` is false, so the interval is irrelevant.
        clock.now = T0 + AUTO_VERSION_MIN_INTERVAL_MS * 2;
        client.sendBinary(frame);
        await waitFor(
          async () => (await updateCount(store, DOC)) === 2,
          'the repeated update is persisted',
        );
        await waitForSlotIdle(server, DOC);
        assert.equal(
          (await autoVersions(store, DOC)).length,
          1,
          'a repeated body must not capture a second version',
        );
      } finally {
        doc.destroy();
      }
    } finally {
      client?.socket.close();
      await harness?.close();
    }
  });

  it('keeps the interval across room eviction by reading the durable auto rows again', async () => {
    let harness: Harness | null = null;
    let first: TestClient | null = null;
    let second: TestClient | null = null;
    try {
      harness = await boot();
      const { server, store, clock } = harness;

      first = await TestClient.connect(server.url, { cookie: await session(server) });
      await first.joinAndWait(DOC);
      const doc = new Y.Doc();
      try {
        doc.getText('content').insert(0, 'v1');
        first.sendBinary(syncUpdateFrame(doc));
        await waitFor(async () => (await updateCount(store, DOC)) === 1, 'the first edit persists');
        await waitForSlotIdle(server, DOC);
        assert.equal((await autoVersions(store, DOC)).length, 1);
      } finally {
        doc.destroy();
      }

      // Last participant leaves → the room (and its interval cache) is evicted.
      first.socket.close();
      first = null;
      await waitFor(() => !server.handle.registry.hasRoom(DOC), 'the room is evicted');

      // Rejoin inside the interval: the first edit of the new room must not duplicate the auto
      // version whose timestamp it re-reads from SQLite.
      second = await TestClient.connect(server.url, { cookie: await session(server) });
      await second.joinAndWait(DOC);
      clock.now = T0 + 8 * 60_000;
      const reconnected = new Y.Doc();
      try {
        const stored = await store.load(DOC);
        assert.notEqual(stored, null);
        if (stored === null) return;
        applyStoredDocument(stored, reconnected);
        const before = Y.encodeStateVector(reconnected);
        reconnected.getText('content').insert(reconnected.getText('content').length, ' v2');
        second.sendBinary(syncUpdateFrameFromBytes(Y.encodeStateAsUpdate(reconnected, before)));
        await waitFor(
          async () => (await updateCount(store, DOC)) === 2,
          'the post-rejoin edit persists',
        );
        await waitForSlotIdle(server, DOC);
        assert.equal(
          (await autoVersions(store, DOC)).length,
          1,
          'the durable timestamp survives eviction: still inside the interval',
        );

        // Once the interval has elapsed, the next edit captures again.
        clock.now = T0 + AUTO_VERSION_MIN_INTERVAL_MS;
        const beforeThird = Y.encodeStateVector(reconnected);
        reconnected.getText('content').insert(reconnected.getText('content').length, '!');
        second.sendBinary(
          syncUpdateFrameFromBytes(Y.encodeStateAsUpdate(reconnected, beforeThird)),
        );
        await waitFor(async () => (await updateCount(store, DOC)) === 3, 'the third edit persists');
        await waitForSlotIdle(server, DOC);
        assert.equal((await autoVersions(store, DOC)).length, 2);
      } finally {
        reconnected.destroy();
      }
    } finally {
      first?.socket.close();
      second?.socket.close();
      await harness?.close();
    }
  });

  it('keeps the edit and retries on the next edit when the capture fails', async () => {
    // A wrapper that fails the first `captureDocumentVersion` and otherwise delegates.
    class FailingCaptureStore extends WrappedStore {
      captureAttempts = 0;
      #failuresLeft = 1;

      async captureDocumentVersion(
        input: Parameters<DocumentVersionStore['captureDocumentVersion']>[0],
      ) {
        assert.ok(isDocumentVersionStore(this.inner));
        this.captureAttempts += 1;
        if (this.#failuresLeft > 0) {
          this.#failuresLeft -= 1;
          throw new Error('injected version capture failure');
        }
        return await this.inner.captureDocumentVersion(input);
      }

      async listDocumentVersions(documentId: string) {
        assert.ok(isDocumentVersionStore(this.inner));
        return await this.inner.listDocumentVersions(documentId);
      }

      async readDocumentVersion(documentId: string, versionId: string) {
        assert.ok(isDocumentVersionStore(this.inner));
        return await this.inner.readDocumentVersion(documentId, versionId);
      }

      async documentContentRevision(documentId: string) {
        assert.ok(isDocumentVersionStore(this.inner));
        return await this.inner.documentContentRevision(documentId);
      }
    }

    const dataPath = mkdtempSync(join(tmpdir(), 'insighthub-auto-fail-'));
    const opened = await openDocumentStore(dataPath);
    const wrapped = new FailingCaptureStore(opened.store);
    let server: TestServer | null = null;
    let client: TestClient | null = null;
    try {
      const clock = { now: T0 };
      server = await startTestServer({
        store: wrapped,
        authorization: 'enforced',
        now: () => clock.now,
      });
      client = await TestClient.connect(server.url, { cookie: await session(server) });
      await client.joinAndWait(DOC);

      const doc = new Y.Doc();
      try {
        doc.getText('content').insert(0, 'hello');
        client.sendBinary(syncUpdateFrame(doc));
        await waitFor(async () => (await updateCount(wrapped, DOC)) === 1, 'the edit is persisted');
        await waitForSlotIdle(server, DOC);

        // The capture was attempted, failed, and changed nothing about the committed edit.
        assert.equal(wrapped.captureAttempts, 1, 'the capture was attempted');
        assert.equal((await autoVersions(wrapped, DOC)).length, 0);
        assert.equal(await durableText(wrapped, DOC), 'hello', 'the edit stays committed');
        assert.equal(server.handle.registry.requireRoom(DOC).state, 'ready');
        assert.equal(
          client.textMessages().filter((message) => message.type === 'error').length,
          0,
          'a capture failure must not be reported to the author as an error',
        );

        // The next real edit retries and succeeds; no clock advance is needed because no auto
        // row exists yet.
        const before = Y.encodeStateVector(doc);
        doc.getText('content').insert(doc.getText('content').length, ' world');
        client.sendBinary(syncUpdateFrameFromBytes(Y.encodeStateAsUpdate(doc, before)));
        await waitFor(
          async () => (await updateCount(wrapped, DOC)) === 2,
          'the retry edit persists',
        );
        await waitForSlotIdle(server, DOC);

        assert.equal(wrapped.captureAttempts, 2, 'the next edit retries the capture');
        const captured = await autoVersions(wrapped, DOC);
        assert.equal(captured.length, 1);
        assert.equal(versionText(captured[0] as StoredDocumentVersion), 'hello world');
        assert.equal(await durableText(wrapped, DOC), 'hello world');
      } finally {
        doc.destroy();
      }
    } finally {
      client?.socket.close();
      await server?.close();
      // `server.close()` closed the wrapper's inner store; the harness-owned directory is ours.
      rmSync(dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('records the editing participant as the author, not the document owner', async () => {
    let harness: Harness | null = null;
    let client: TestClient | null = null;
    try {
      harness = await boot();
      const { server, store } = harness;
      // demo-grace is an `editor` on demo-document; demo-ada is its owner.
      client = await TestClient.connect(server.url, { cookie: await session(server, EDITOR) });
      await client.joinAndWait(DOC);

      const doc = new Y.Doc();
      try {
        doc.getText('content').insert(0, 'written by the editor');
        client.sendBinary(syncUpdateFrame(doc));
        await waitFor(async () => (await updateCount(store, DOC)) === 1, 'the edit is persisted');
        await waitForSlotIdle(server, DOC);

        const captured = await autoVersions(store, DOC);
        assert.equal(captured.length, 1);
        assert.equal(captured[0]?.authorId, EDITOR, 'the commit participant authors the snapshot');
      } finally {
        doc.destroy();
      }
    } finally {
      client?.socket.close();
      await harness?.close();
    }
  });

  it('uses "system" as the author when the transport has no resolved identity', () => {
    // The fallback is a constant with a documented meaning; this assertion pins the vocabulary
    // so a later refactor cannot silently write a made-up user id into `author_id`.
    assert.equal(AUTO_VERSION_SYSTEM_AUTHOR, 'system');
  });
});

/** Guard: the demo metadata capability must exist where the title comes from in production. */
describe('D-V2 auto-version title source', () => {
  it('is the durable document metadata when the store serves it', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'insighthub-auto-title-'));
    const opened = await openDocumentStore(dataPath);
    try {
      assert.ok(isDocumentMetaStore(opened.store));
      await opened.store.ensureDocumentMeta(DOC, OWNER);
      const meta = await opened.store.documentMeta(DOC);
      assert.notEqual(meta, null);
    } finally {
      await opened.store.close();
      rmSync(dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
