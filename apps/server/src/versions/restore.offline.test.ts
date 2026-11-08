/**
 * P0-1 — **T8**: restore versus an offline peer's concurrent edit, and the reconnect that
 * merges them (`docs/agent-governance/P0-1-CONTRACTS.md` C1–C5; `docs/DECISIONS.md` D-090).
 *
 * ## What this suite is
 *
 * One real server (real HTTP API, real WebSocket transport, real SQLite database), two real
 * `ws` clients, and two real `Y.Doc` replicas. The peer that is "offline" is genuinely
 * disconnected: its socket is closed before the restore is issued, so it cannot have received
 * the restore broadcast. It then edits its **stale** replica and reconnects through the frozen
 * SyncStep handshake, which is the only recovery path the contract has.
 *
 * ## The two orders
 *
 * | Test | Wall-clock order |
 * | --- | --- |
 * | 1 | B edits its stale replica, **then** A restores `alpha` → `beta`, then B reconnects |
 * | 2 | A restores `alpha` → `beta`, **then** B edits its stale replica, then B reconnects |
 *
 * Both start from the same durable pair (version `beta`, live body `alpha`) and the same
 * pre-restore replica on B. The merge is a Yjs conflict between two edits that both rewrite
 * the same span of the same pre-restore text; it must converge on every replica and in the
 * durable log, and it must keep B's `ALPHA`.
 *
 * ## Why the text is recorded, not asserted
 *
 * Yjs orders concurrent insertions by internal client id, so the merged body can in principle
 * be `betALPHA` or `ALPHAbeta`. The measured result for this fixture is stable (`betALPHA`,
 * 2000/2000 in an isolated probe) but it is an implementation detail of Yjs' integration
 * order, not a contract P0-1 promises. The test therefore asserts **convergence and content**
 * (A === B === durable, contains `ALPHA`) and reports the actual merged text with
 * `t.diagnostic`. Restore promises the selected body once there is no concurrent edit; with a
 * concurrent edit it promises a deterministic merge, not a particular string.
 *
 * T7 lives in `versions/text-diff.test.ts`; T1–T6/T9–T14 live in
 * `versions/restore.integration.test.ts`.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  SYNC_MESSAGE_TYPES,
  decodeSyncFrame,
  encodeSyncStep1,
  encodeSyncStep2,
  readSyncMessageType,
  readSyncStep1StateVector,
} from '@insighthub/shared';
import { readSyncMessage } from 'y-protocols/sync';
import * as Y from 'yjs';

import { isDocumentMetaStore } from '../persistence/document-meta.js';
import {
  isDocumentVersionStore,
  type DocumentVersionStore,
} from '../persistence/document-versions.js';
import { applyStoredDocument } from '../persistence/hydrator.js';
import { DATABASE_FILE_NAME } from '../persistence/sqlite-store.js';
import { loadSqliteModule, type SqliteModule } from '../persistence/sqlite-runtime.js';
import type { DocumentStore } from '../persistence/types.js';
import {
  bootstrapSessionCookie,
  startTestServer,
  TestClient,
  TestDecoder,
  type TestServer,
} from '../rooms/test-harness.js';

/** Owner of this document in the demo fixture; only an Owner may restore (D-V1). */
const OWNER = 'demo-ada';
/** Editor on the same document; the offline peer must be allowed to write when it returns. */
const EDITOR = 'demo-grace';
/** `demo-document`: owned by `demo-ada`, `demo-grace` is an editor (`demo-fixture.ts`). */
const DOC = 'demo-document';

/** The version's own body: what `alpha` is restored to. */
const VERSION_TEXT = 'beta';
/** The durable body before the restore, and the state both peers start from. */
const LIVE_TEXT = 'alpha';
/** B's offline rewrite of the stale body. */
const OFFLINE_TEXT = 'ALPHA';

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

type FullStore = DocumentStore & DocumentVersionStore;

function fullStore(store: DocumentStore): FullStore {
  assert.ok(isDocumentVersionStore(store), 'the server store must serve versions');
  return store;
}

function textOf(doc: Y.Doc): string {
  return doc.getText('content').toString();
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * Seed a restorable document: a version captured at `targetText`, then a later body.
 *
 * Written through the store before the server opens a room, so the room hydrates the state a
 * real user would have left behind. `baseRevision` is the content revision the restore request
 * must carry (D-RC1).
 */
async function seedRestorable(
  store: DocumentStore,
  documentId: string,
  targetText: string,
  currentText: string,
): Promise<{ versionId: string; baseRevision: number }> {
  const full = fullStore(store);
  assert.ok(isDocumentMetaStore(store), 'the SQLite store must own metadata');
  await store.ensureDocumentMeta(documentId, OWNER);

  // One Yjs client chain: the later body is a **relative** update from the document that holds
  // the target text, exactly as a real editor would produce it.
  const doc = new Y.Doc();
  try {
    doc.getText('content').insert(0, targetText);
    await store.append(documentId, Y.encodeStateAsUpdate(doc)); // content revision 1
    const version = await full.captureDocumentVersion({
      documentId,
      title: 'history',
      authorId: OWNER,
      state: Y.encodeStateAsUpdate(doc),
      kind: 'manual',
    });

    const stateVector = Y.encodeStateVector(doc);
    const text = doc.getText('content');
    text.delete(0, text.length);
    text.insert(0, currentText);
    await store.append(documentId, Y.encodeStateAsUpdate(doc, stateVector)); // revision 2

    return {
      versionId: version.id,
      baseRevision: await full.documentContentRevision(documentId),
    };
  } finally {
    doc.destroy();
  }
}

/** The text a fresh server would rebuild from the store alone. */
async function durableText(store: DocumentStore, documentId: string): Promise<string | null> {
  const stored = await store.load(documentId);
  if (stored === null) return null;
  const doc = new Y.Doc();
  try {
    applyStoredDocument(stored, doc);
    return textOf(doc);
  } finally {
    doc.destroy();
  }
}

type RawDb = InstanceType<SqliteModule['DatabaseSync']>;

async function withRawDb<T>(dataPath: string, body: (db: RawDb) => T): Promise<T> {
  const sqlite = await loadSqliteModule();
  const db = new sqlite.DatabaseSync(join(dataPath, DATABASE_FILE_NAME));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return body(db);
  } finally {
    db.close();
  }
}

interface RowCounts {
  readonly versions: number;
  readonly updates: number;
  readonly operations: number;
}

async function rowCounts(server: TestServer, documentId: string): Promise<RowCounts> {
  assert.notEqual(server.dataPath, undefined, 'this suite needs the harness-owned database');
  return await withRawDb(server.dataPath as string, (db) => {
    const scalar = (sql: string): number => Number(db.prepare(sql).get(documentId)?.['total'] ?? 0);
    return {
      versions: scalar('SELECT COUNT(*) AS total FROM document_version WHERE document_id = ?'),
      updates: scalar('SELECT COUNT(*) AS total FROM document_update WHERE document_id = ?'),
      operations: scalar('SELECT COUNT(*) AS total FROM restore_operation WHERE document_id = ?'),
    };
  });
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function apiFetch(
  server: TestServer,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = { connection: 'close' };
  if (cookie !== undefined) headers['cookie'] = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${server.httpUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed as Record<string, unknown> };
}

function restorePath(documentId: string, versionId: string): string {
  return `/api/documents/${documentId}/versions/${versionId}/restore`;
}

function restoreBody(baseRevision: number, operationId: string): Record<string, unknown> {
  return { baseRevision, operationId };
}

async function session(server: TestServer, userId: string): Promise<string> {
  return await bootstrapSessionCookie(server.httpUrl, userId);
}

/** Poll until `predicate` holds; bounded so a bug is a failure, not a hung gate. */
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

/** A server on the harness-owned database (real SQLite, real authz); the caller owns `close`. */
async function bootServer(): Promise<TestServer> {
  return await startTestServer({ authorization: 'enforced' });
}

/* ------------------------------------------------------------------ *
 * Client half of the sync protocol
 * ------------------------------------------------------------------ */

/**
 * Merge every not-yet-seen SYNC frame into `doc`, and answer a server `SyncStep1`.
 *
 * Answering matters: the frozen handshake is client-initiated, but the server's reply is
 * `SyncStep2` **followed by its own `SyncStep1`**, and that second message is how the server
 * asks for the offline edits it is missing. A client that ignores it can push nothing.
 *
 * `readSyncMessage` is `y-protocols`' own reader rather than a test-local reimplementation, so
 * convergence is proven by the same protocol code a browser uses (`TestDecoder` is only the
 * lib0-shaped adapter pnpm does not expose to this package).
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
    if (Date.now() > deadline) assert.fail('timed out waiting for the sync exchange to settle');
    await sleep(10);
  }
}

/**
 * Pump frames from `fromIndex` onward until `predicate` holds for the local replica.
 *
 * Returns the next index, so a caller can keep pumping the same buffer across stages: the
 * buffer is append-only and re-processing a frame would re-answer an already answered
 * `SyncStep1` (a second empty update in the log, which would break the row accounting).
 */
async function drainUntil(
  client: TestClient,
  doc: Y.Doc,
  fromIndex: number,
  predicate: () => boolean,
  description: string,
  timeoutMs = 8_000,
): Promise<number> {
  let index = fromIndex;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return index;
    if (client.binaryFrames().length > index) {
      index = await pumpFrames(client, doc, index);
      continue;
    }
    if (Date.now() > deadline) {
      const types = client.binaryFrames().map((frame) => {
        const decoded = decodeSyncFrame(frame);
        return decoded === null ? 'non-sync' : readSyncMessageType(decoded);
      });
      assert.fail(
        `timed out waiting until ${description}; frames=${client.binaryFrames().length}, ` +
          `types=${JSON.stringify(types)}, text=${JSON.stringify(textOf(doc))}`,
      );
    }
    await sleep(10);
  }
}

/**
 * B's offline edit, computed on its **stale** replica: delete the old body and insert `ALPHA`.
 *
 * One local transaction, exactly as an editor would batch a select-all overwrite. The resulting
 * update is derived from B's pre-edit state vector, so the test never hand-builds Yjs structs:
 * the text operations are the fixture and Yjs encodes them.
 */
function rewriteOfflineReplica(doc: Y.Doc): void {
  const text = doc.getText('content');
  doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, OFFLINE_TEXT);
  });
}

/**
 * One full T8 scenario.
 *
 * `order` only moves B's offline edit to the other side of the restore request; the state B
 * starts from, and therefore the conflict being merged, is identical.
 */
async function runOfflineMergeScenario(
  order: 'edit-before-restore' | 'restore-before-edit',
  t: TestContext,
): Promise<void> {
  const server = await bootServer();
  const clients: TestClient[] = [];
  const docA = new Y.Doc();
  const docB = new Y.Doc();

  try {
    const seeded = await seedRestorable(server.store, DOC, VERSION_TEXT, LIVE_TEXT);
    const ownerCookie = await session(server, OWNER);
    const editorCookie = await session(server, EDITOR);

    // ---- A online: the editor who performs the restore ----
    const a = await TestClient.connect(server.url, { cookie: ownerCookie });
    clients.push(a);
    await a.joinAndWait(DOC);
    await syncClient(a, docA);
    assert.equal(textOf(docA), LIVE_TEXT, 'A starts from the durable pre-restore body');
    // Frames are append-only: remember where A's initial handshake ended, so later stages
    // process exactly the frames that arrived after it (and never re-answer a SyncStep1).
    let aFrameIndex = a.binaryFrames().length;

    // ---- B online: it must hold the same pre-restore text before it goes away ----
    const b = await TestClient.connect(server.url, { cookie: editorCookie });
    clients.push(b);
    await b.joinAndWait(DOC);
    await syncClient(b, docB);
    assert.equal(textOf(docB), LIVE_TEXT, 'B starts from the same pre-restore body');

    // Each join answers the server's SyncStep1 with an empty update. The log records those
    // rows without advancing the content revision (T12 in `restore.integration.test.ts`), so
    // wait for both writes before taking the accounting baseline.
    await waitFor(
      async () => (await rowCounts(server, DOC)).updates === 4,
      'both joins are durably logged',
    );
    const beforeRestore = await rowCounts(server, DOC);
    assert.deepEqual(
      beforeRestore,
      { versions: 1, updates: 4, operations: 0 },
      'one captured version, two seeded updates, one empty update per join, no restore yet',
    );
    assert.equal(
      await fullStore(server.store).documentContentRevision(DOC),
      seeded.baseRevision,
      'the join empty updates did not advance the content revision',
    );

    // ---- B goes offline *before* the restore; it cannot receive the broadcast ----
    b.close();
    await b.waitForClose();
    await waitFor(
      () => server.handle.registry.connectionCount === 1,
      'B is disconnected from the room',
    );

    if (order === 'edit-before-restore') {
      rewriteOfflineReplica(docB);
      assert.equal(textOf(docB), OFFLINE_TEXT, 'B rewrites the stale body while it is offline');
    }

    // ---- A restores the document to the version's body ----
    const restore = await apiFetch(
      server,
      'POST',
      restorePath(DOC, seeded.versionId),
      ownerCookie,
      restoreBody(seeded.baseRevision, 'op-t8-offline-0001'),
    );
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    const restoredVersionId = String(restore.body['versionId']);
    assert.equal(typeof restore.body['versionId'], 'string');
    assert.equal(
      restore.body['sequence'],
      seeded.baseRevision + 1,
      'the restore advances the content revision exactly once',
    );

    // A is still online, so it applies the restore like any other remote update. Its frame
    // buffer may also hold B's join empty update (broadcast between joins); `aFrameIndex`
    // makes the pump skip only frames already applied, never the restore itself.
    aFrameIndex = await drainUntil(
      a,
      docA,
      aFrameIndex,
      () => textOf(docA) === VERSION_TEXT,
      'A applies the restore',
    );
    assert.equal(textOf(docA), VERSION_TEXT, 'A now holds the restored body');
    assert.equal(
      textOf(docB),
      order === 'restore-before-edit' ? LIVE_TEXT : OFFLINE_TEXT,
      'B has not seen the restore',
    );

    if (order === 'restore-before-edit') {
      rewriteOfflineReplica(docB);
      assert.equal(textOf(docB), OFFLINE_TEXT, 'B rewrites the stale body after the restore');
    }

    // ---- Accounting: the restore wrote exactly four rows once ----
    assert.deepEqual(
      await rowCounts(server, DOC),
      {
        versions: beforeRestore.versions + 2,
        updates: beforeRestore.updates + 1,
        operations: beforeRestore.operations + 1,
      },
      'one restore = pre-restore + restored versions, one update, one operation',
    );

    // ---- B reconnects and discovers the delta through SyncStep ----
    const reconnected = await TestClient.connect(server.url, { cookie: editorCookie });
    clients.push(reconnected);
    await reconnected.joinAndWait(DOC);
    await syncClient(reconnected, docB);

    const syncTypes = reconnected.binaryFrames().flatMap((frame) => {
      const decoded = decodeSyncFrame(frame);
      if (decoded === null) return [];
      const type = readSyncMessageType(decoded);
      return type === null ? [] : [type];
    });
    assert.ok(
      syncTypes.includes(SYNC_MESSAGE_TYPES.step2),
      `the server must send SyncStep2 with the missing restore delta; got ${JSON.stringify(syncTypes)}`,
    );
    assert.ok(
      syncTypes.includes(SYNC_MESSAGE_TYPES.step1),
      `the server must send its SyncStep1 asking for B's offline edit; got ${JSON.stringify(syncTypes)}`,
    );

    // The durable log now holds B's edit as the one new row for the reconnect.
    await waitFor(
      async () =>
        ((await server.store.load(DOC))?.updates.length ?? 0) === beforeRestore.updates + 2,
      "B's offline edit is persisted",
    );

    // A receives the merged update; nothing else may be written.
    aFrameIndex = await drainUntil(
      a,
      docA,
      aFrameIndex,
      () => textOf(docA).includes(OFFLINE_TEXT),
      "A receives B's merged offline edit",
    );

    // ---- The claim: every replica and the durable log hold the same text ----
    const finalA = textOf(docA);
    const finalB = textOf(docB);
    const durable = await durableText(server.store, DOC);
    assert.equal(
      finalA,
      finalB,
      `A (${JSON.stringify(finalA)}) and B (${JSON.stringify(finalB)}) must converge`,
    );
    assert.equal(
      finalA,
      durable,
      `the durable log (${JSON.stringify(durable)}) must match the replicas ` +
        `(${JSON.stringify(finalA)})`,
    );
    assert.ok(
      finalA.includes(OFFLINE_TEXT),
      `the merged text must keep B's offline edit ${JSON.stringify(OFFLINE_TEXT)}: ` +
        JSON.stringify(finalA),
    );
    // Recorded, not asserted: Yjs' conflict order for two concurrent rewrites of the same span
    // is not part of P0-1's contract. The measured result for this fixture is `betALPHA`.
    t.diagnostic(`T8 mergedText=${JSON.stringify(finalA)} (order=${order})`);

    // B's edit added one update row. The restore added its two version rows and one operation;
    // the reconnect itself adds no *second* version/operation row. D-V2 adds one row on top:
    // B's offline edit is the document's first body-changing client update, so it captures a
    // single `auto` version inside the same FIFO slot (best-effort, after the append).
    await waitFor(
      () => server.handle.registry.mutationQueueDepth(DOC) === 0,
      "B's reconnect slot is idle",
    );
    const afterMerge = await rowCounts(server, DOC);
    assert.deepEqual(
      afterMerge,
      {
        versions: beforeRestore.versions + 3,
        updates: beforeRestore.updates + 2,
        operations: beforeRestore.operations + 1,
      },
      "B's reconnect adds one update row and one D-V2 auto version, never a restore row",
    );

    // ---- Replaying the same operation id must not apply the restore a second time ----
    const retry = await apiFetch(
      server,
      'POST',
      restorePath(DOC, seeded.versionId),
      ownerCookie,
      restoreBody(seeded.baseRevision, 'op-t8-offline-0001'),
    );
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body['versionId'], restoredVersionId, 'the retry replays the first result');
    assert.equal(retry.body['sequence'], seeded.baseRevision + 1);
    assert.deepEqual(
      await rowCounts(server, DOC),
      afterMerge,
      'a same-operation-id retry writes no rows: the restore was applied exactly once',
    );
    assert.equal(await durableText(server.store, DOC), finalA, 'the retry did not change the body');
  } finally {
    for (const client of clients) client.destroy();
    docA.destroy();
    docB.destroy();
    await server.close();
  }
}

/* ------------------------------------------------------------------ *
 * T8 — the two orders
 * ------------------------------------------------------------------ */

describe("T8 — restore vs an offline peer's concurrent edit", () => {
  it('converges when the offline edit happens before the restore', async (t) => {
    await runOfflineMergeScenario('edit-before-restore', t);
  });

  it('converges when the restore happens before the offline edit', async (t) => {
    await runOfflineMergeScenario('restore-before-edit', t);
  });
});
