/**
 * P0-1 — server-side version restore, end to end over the real HTTP API and real WebSocket
 * transport (`docs/agent-governance/P0-1-CONTRACTS.md` C1–C5; `docs/DECISIONS.md` D-090).
 *
 * ## What this suite is
 *
 * Every test boots a real server (`startTestServer`) with a real SQLite database and, where the
 * scenario needs a socket, real `ws` clients. Nothing is mocked: the claims are about the HTTP
 * status codes, the rows in the database, the frames on the wire and the room's state machine.
 *
 * ## Test map (A7 §4)
 *
 * | ID | Proven here |
 * | --- | --- |
 * | T1 | restore and a concurrent client update share one FIFO slot: apply/log/broadcast order |
 * | T2 | a failure in any of the four writes: 0 rows, room unhealthy, no broadcast, HTTP 500 |
 * | T3 | same operation id retried (including across a store reopen): original result, 0 rows |
 * | T4 | row counts for success / retry / failed transaction / post-commit restart |
 * | T5 | the `pre-restore` state is the text **before** the apply |
 * | T6 | two concurrent restores: one 200, one `409 stale_revision`, no double apply |
 * | T9 | restore with nobody online: durable, room evicted, a later join hydrates it |
 * | T10 | restore → evict + compact → reopen: text and `pre-restore` survive |
 * | T11 | permissions: Owner 200, Editor 403, no membership 404, unauthenticated 401 |
 * | T12 | a join's empty update does not advance the content revision (no false 409) |
 * | T13 | an operation id reused on another document does not leak the first result |
 * | T14 | no optimistic apply: the body accepts no client-computed update, and a normal edit is not a restore |
 * | R-5 | restoring a version whose text already is the current text: 200, unchanged revision, four rows, no broadcast |
 * | C3 | same operation id retried with an expired `baseRevision`: original result, 0 rows, no second broadcast; a different request is a 409 |
 *
 * T7 lives in `versions/text-diff.test.ts`; T8 (offline merge) belongs to A6 and is **not**
 * implemented here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  decodeSyncFrame,
  readSyncUpdatePayload,
} from '@insighthub/shared';
import * as Y from 'yjs';

import { isDocumentMetaStore } from '../persistence/document-meta.js';
import {
  isDocumentVersionStore,
  type DocumentVersionStore,
} from '../persistence/document-versions.js';
import { applyStoredDocument } from '../persistence/hydrator.js';
import { openDocumentStore } from '../persistence/open-store.js';
import { DATABASE_FILE_NAME } from '../persistence/sqlite-store.js';
import { loadSqliteModule, type SqliteModule } from '../persistence/sqlite-runtime.js';
import { WrappedStore } from '../persistence/test-stores.js';
import type { AppendRestoreInput, AppendRestoreOutcome, DocumentStore } from '../persistence/types.js';
import {
  bootstrapSessionCookie,
  startTestServer,
  syncStep2Frame,
  syncUpdateFrameFromBytes,
  TestClient,
  type TestServer,
} from '../rooms/test-harness.js';

/** Owner of this document in the demo fixture (`demo-ada`). */
const DOC = 'demo-document';
/** Owner-only document from the demo fixture, used for the no-leak cases. */
const PRIVATE_DOC = 'demo-private-notes';

type RawDb = InstanceType<SqliteModule['DatabaseSync']>;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function textOfState(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    if (state.byteLength > 0) Y.applyUpdate(doc, state);
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
  }
}

/** A store that serves every capability this suite uses. */
type FullStore = DocumentStore & DocumentVersionStore;

function fullStore(store: DocumentStore): FullStore {
  assert.ok(isDocumentVersionStore(store), 'the server store must serve versions');
  return store;
}

/**
 * Seed a restorable document: a version captured at `targetText`, then a later body.
 *
 * Written through the store before the server opens a room, so the room hydrates the same
 * state a real user would have left behind.
 */
async function seedRestorable(
  store: DocumentStore,
  documentId: string,
  targetText: string,
  currentText: string,
): Promise<{ versionId: string; baseRevision: number }> {
  const full = fullStore(store);
  assert.ok(isDocumentMetaStore(store), 'the SQLite store must own metadata');
  await store.ensureDocumentMeta(documentId, 'demo-ada');

  // One Yjs client chain: the later body is a **relative** update from the document that holds
  // the target text, exactly as a real editor would produce it. Appending two independent
  // documents' full states would merge two unrelated struct sequences and the resulting text
  // order would depend on client ids.
  const doc = new Y.Doc();
  try {
    doc.getText('content').insert(0, targetText);
    await store.append(documentId, Y.encodeStateAsUpdate(doc)); // content revision 1
    const version = await full.captureDocumentVersion({
      documentId,
      title: 'history',
      authorId: 'demo-ada',
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
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
  }
}

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
    const scalar = (sql: string): number =>
      Number(db.prepare(sql).get(documentId)?.['total'] ?? 0);
    return {
      versions: scalar('SELECT COUNT(*) AS total FROM document_version WHERE document_id = ?'),
      updates: scalar('SELECT COUNT(*) AS total FROM document_update WHERE document_id = ?'),
      operations: scalar('SELECT COUNT(*) AS total FROM restore_operation WHERE document_id = ?'),
    };
  });
}

/**
 * Byte length of the newest `document_update` row.
 *
 * A no-op restore must still write its update row (C1 counts four rows), so the point of this
 * helper is that the row exists **and** is empty — the body did not change.
 */
async function lastUpdateByteLength(server: TestServer, documentId: string): Promise<number> {
  assert.notEqual(server.dataPath, undefined, 'this suite needs the harness-owned database');
  return await withRawDb(server.dataPath as string, (db) =>
    Number(
      db
        .prepare(
          `SELECT length(update_bytes) AS bytes FROM document_update
           WHERE document_id = ? ORDER BY seq DESC LIMIT 1`,
        )
        .get(documentId)?.['bytes'] ?? -1,
    ),
  );
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

/** Poll until `predicate` holds; bounded so a bug is a failure, not a hung gate. */async function waitFor(
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

/** A server on the harness-owned database; the caller owns `close`. */
async function bootServer(): Promise<TestServer> {
  return await startTestServer({ authorization: 'enforced' });
}

/* ------------------------------------------------------------------ *
 * T1 — the restore is in the document's FIFO slot
 * ------------------------------------------------------------------ */

/**
 * A store that delegates everything but holds `appendRestore` open, so a test can prove what
 * happens **between** the apply and the persist.
 */
class GatedRestoreStore extends WrappedStore {
  #release: (() => void) | null = null;
  readonly #gate: Promise<void>;
  restoreStarted = false;
  restoreFinished = false;
  appendCalls = 0;
  lastRestoreInput: AppendRestoreInput | null = null;

  constructor(inner: DocumentStore) {
    super(inner);
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  releaseRestore(): void {
    this.#release?.();
  }

  override async append(
    documentId: string,
    update: Uint8Array,
    options?: Parameters<DocumentStore['append']>[2],
  ): Promise<number> {
    this.appendCalls += 1;
    return this.inner.append(documentId, update, options);
  }

  override async appendRestore(input: AppendRestoreInput): Promise<AppendRestoreOutcome> {
    this.restoreStarted = true;
    this.lastRestoreInput = input;
    await this.#gate;
    const outcome = await this.inner.appendRestore(input);
    this.restoreFinished = true;
    return outcome;
  }

  /* The version capability, forwarded: the registry checks it on the wrapped store. */
  async listDocumentVersions(documentId: string) {
    return await fullStore(this.inner).listDocumentVersions(documentId);
  }
  async readDocumentVersion(documentId: string, versionId: string) {
    return await fullStore(this.inner).readDocumentVersion(documentId, versionId);
  }
  async captureDocumentVersion(input: Parameters<DocumentVersionStore['captureDocumentVersion']>[0]) {
    return await fullStore(this.inner).captureDocumentVersion(input);
  }
  async documentContentRevision(documentId: string) {
    return await fullStore(this.inner).documentContentRevision(documentId);
  }
}

describe('T1 — restore shares the per-document FIFO slot', () => {
  it('applies, persists and broadcasts the restore before a queued client update', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'insighthub-restore-t1-'));
    const opened = await openDocumentStore(dataPath);
    const gated = new GatedRestoreStore(opened.store);
    let server: TestServer | null = null;
    const clients: TestClient[] = [];
    try {
      const seeded = await seedRestorable(opened.store, DOC, 'target', 'base-later');

      // The observer is who proves the broadcast order; the sender is a second session so its
      // own update (which the server does not echo back to its author) cannot be confused with
      // the restore broadcast.
      server = await startTestServer({ store: gated, authorization: 'enforced' });
      const observer = await TestClient.connect(server.url, {
        cookie: await session(server, 'demo-ada'),
      });
      const sender = await TestClient.connect(server.url, {
        cookie: await session(server, 'demo-ada'),
      });
      clients.push(observer, sender);
      await observer.joinAndWait(DOC);
      await sender.joinAndWait(DOC);

      // The client edit is computed against the **pre-restore** state, exactly as a browser
      // that had not yet seen the restore would compute it.
      const currentDoc = new Y.Doc();
      try {
        const stored = await opened.store.load(DOC);
        assert.notEqual(stored, null);
        if (stored === null) return;
        applyStoredDocument(stored, currentDoc);
        const before = Y.encodeStateVector(currentDoc);
        const text = currentDoc.getText('content');
        text.insert(text.length, '!');
        const editUpdate = Y.encodeStateAsUpdate(currentDoc, before);

        observer.clear();
        sender.clear();

        const restorePromise = apiFetch(
          server,
          'POST',
          restorePath(DOC, seeded.versionId),
          await session(server, 'demo-ada'),
          restoreBody(seeded.baseRevision, 'op-t1-fifo-0001'),
        );

        // Wait until the restore is *inside* the slot, between apply and persist.
        await waitFor(() => gated.restoreStarted, 'the restore reached appendRestore');
        assert.equal(gated.restoreFinished, false);

        // The restore is applied to the room, but nothing is on the wire yet.
        const registry = server.handle.registry;
        assert.equal(
          registry.requireRoom(DOC).doc.getText('content').toString(),
          'target',
          'the server-authored update is applied inside the slot',
        );
        const appendsBefore = gated.appendCalls;
        sender.sendBinary(syncUpdateFrameFromBytes(editUpdate));

        // The client's update is queued behind the restore: it is neither applied nor persisted.
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.equal(gated.appendCalls, appendsBefore, 'the client update must not persist first');
        assert.equal(observer.binaryFrames().length, 0, 'nothing may be broadcast before commit');
        assert.equal(
          registry.requireRoom(DOC).doc.getText('content').toString(),
          'target',
          'the queued update must not be applied before the restore commits',
        );

        gated.releaseRestore();
        const restoreResponse = await restorePromise;
        assert.equal(restoreResponse.status, 200, JSON.stringify(restoreResponse.body));
        assert.equal(typeof restoreResponse.body['versionId'], 'string');

        // Both durable writes landed in slot order: restore update, then the client's edit.
        await waitFor(
          async () => ((await opened.store.load(DOC))?.updates.length ?? 0) === 4,
          'the client update is persisted after the restore',
        );
        const afterUpdates = await opened.store.load(DOC);
        const updates = afterUpdates?.updates ?? [];
        assert.equal(updates.length, 4);
        assert.notEqual(gated.lastRestoreInput, null);
        const restoreUpdate = gated.lastRestoreInput?.restoreUpdate ?? new Uint8Array();
        assert.deepEqual(
          Buffer.from(updates[2]?.update ?? new Uint8Array()),
          Buffer.from(restoreUpdate),
          'the restore update is the third log row',
        );
        assert.deepEqual(
          Buffer.from(updates[3]?.update ?? new Uint8Array()),
          Buffer.from(editUpdate),
          'the client update is the fourth log row',
        );

        // The observer saw the restore first, then the client edit.
        await waitFor(
          () => observer.binaryFrames().length >= 2,
          'the observer receives both broadcasts',
        );
        const payloads = observer.binaryFrames().map((frame) => {
          const decoded = decodeSyncFrame(frame);
          return decoded === null ? null : readSyncUpdatePayload(decoded);
        });
        const restoreIndex = payloads.findIndex(
          (payload) => payload !== null && Buffer.from(payload).equals(Buffer.from(restoreUpdate)),
        );
        const editIndex = payloads.findIndex(
          (payload) => payload !== null && Buffer.from(payload).equals(Buffer.from(editUpdate)),
        );
        assert.notEqual(restoreIndex, -1, 'the restore broadcast must reach the observer');
        assert.notEqual(editIndex, -1, 'the client update broadcast must reach the observer');
        assert.ok(
          restoreIndex < editIndex,
          `restore broadcast (${restoreIndex}) must precede the edit (${editIndex})`,
        );

        // The body advanced twice: once for the restore, once for the edit.
        assert.equal(await fullStore(opened.store).documentContentRevision(DOC), 4);
      } finally {
        currentDoc.destroy();
      }
    } finally {
      gated.releaseRestore();
      for (const client of clients) client.destroy();
      if (server !== null) await server.close();
      await opened.store.close();
      rmSync(dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

/* ------------------------------------------------------------------ *
 * T2 — a failed transaction writes nothing, broadcasts nothing, fails the room
 * ------------------------------------------------------------------ */

async function expectFailedRestore(input: { trigger: string }): Promise<void> {
  const server = await bootServer();
  const clients: TestClient[] = [];
  try {
    const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
    const observer = await TestClient.connect(server.url, {
      cookie: await session(server, 'demo-ada'),
    });
    clients.push(observer);
    await observer.joinAndWait(DOC);
    observer.clear();
    const before = await rowCounts(server, DOC);

    await withRawDb(server.dataPath as string, (db) => db.exec(input.trigger));

    const response = await apiFetch(
      server,
      'POST',
      restorePath(DOC, seeded.versionId),
      await session(server, 'demo-ada'),
      restoreBody(seeded.baseRevision, 'op-t2-failure-0001'),
    );
    assert.equal(response.status, 500, JSON.stringify(response.body));
    assert.deepEqual(response.body, { error: 'restore_failed' });

    // 0 new rows of any kind.
    assert.deepEqual(await rowCounts(server, DOC), before);
    assert.equal(await durableText(server.store, DOC), 'base-later', 'the live text is unchanged');

    // Nothing was broadcast; the participant is told the room failed and the socket closes
    // with WebSocket 1011 ("internal error"), not a policy close (1008) or a transport drop
    // (1006). The server cannot serve this room any more and says so.
    assert.equal(observer.binaryFrames().length, 0, 'a failed restore must not broadcast');
    const error = await observer.waitForError('INTERNAL_ERROR');
    assert.equal(error.type, 'error');
    const closed = await observer.waitForClose();
    assert.equal(closed.code, 1011, 'a persist failure closes with code 1011');
    assert.equal(closed.reason, 'INTERNAL_ERROR');

    // The room is gone (unhealthy rooms are destroyed), and the next join rehydrates the
    // durable state — the failure did not half-kill the document.
    assert.equal(server.handle.registry.hasRoom(DOC), false);
    const recovered = await TestClient.connect(server.url, {
      cookie: await session(server, 'demo-ada'),
    });
    clients.push(recovered);
    await recovered.joinAndWait(DOC);
    assert.equal(server.handle.registry.requireRoom(DOC).doc.getText('content').toString(), 'base-later');

    await withRawDb(server.dataPath as string, (db) => db.exec('DROP TRIGGER injected_failure'));
  } finally {
    for (const client of clients) client.destroy();
    await server.close();
  }
}

describe('T2 — a failure at each write: 0 rows, no broadcast, 500, unhealthy room', () => {
  it('fails the pre-restore version write', async () => {
    await expectFailedRestore({
      trigger: `CREATE TRIGGER injected_failure BEFORE INSERT ON document_version
                WHEN NEW.kind = 'pre-restore'
                BEGIN SELECT RAISE(ABORT, 'injected pre-restore failure'); END`,
    });
  });

  it('fails the restore update write', async () => {
    await expectFailedRestore({
      trigger: `CREATE TRIGGER injected_failure BEFORE INSERT ON document_update
                BEGIN SELECT RAISE(ABORT, 'injected update failure'); END`,
    });
  });

  it('fails the restored version write', async () => {
    await expectFailedRestore({
      trigger: `CREATE TRIGGER injected_failure BEFORE INSERT ON document_version
                WHEN NEW.kind = 'restored'
                BEGIN SELECT RAISE(ABORT, 'injected restored failure'); END`,
    });
  });

  it('fails the operation write', async () => {
    await expectFailedRestore({
      trigger: `CREATE TRIGGER injected_failure BEFORE INSERT ON restore_operation
                BEGIN SELECT RAISE(ABORT, 'injected operation failure'); END`,
    });
  });
});

/* ------------------------------------------------------------------ *
 * T3/T4 — idempotency and row counts
 * ------------------------------------------------------------------ */

describe('T3/T4 — operation id idempotency and the four-row accounting', () => {
  it('retries N times, reopens the store, and always returns the original result with 0 rows', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'insighthub-restore-t3-'));
    let first = await startTestServer({ dataPath });
    const createdByFirst = first.dataPath !== undefined;
    try {
      const seeded = await seedRestorable(first.store, DOC, 'target', 'base-later');
      const cookie = await session(first, 'demo-ada');
      const before = await rowCounts(first, DOC);

      const firstResponse = await apiFetch(
        first,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        restoreBody(seeded.baseRevision, 'op-t3-retry-0001'),
      );
      assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse.body));
      const versionId = String(firstResponse.body['versionId']);
      const sequence = Number(firstResponse.body['sequence']);
      assert.equal(typeof versionId, 'string');
      assert.equal(sequence, 3, 'the restored version progresses the content revision');

      // T4: success writes exactly four rows — two versions, one update, one operation.
      const afterSuccess = await rowCounts(first, DOC);
      assert.equal(afterSuccess.versions, before.versions + 2);
      assert.equal(afterSuccess.updates, before.updates + 1);
      assert.equal(afterSuccess.operations, before.operations + 1);

      // Retries with the **stale** base revision still hit the operation row (lookup first).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const retry = await apiFetch(
          first,
          'POST',
          restorePath(DOC, seeded.versionId),
          cookie,
          restoreBody(seeded.baseRevision, 'op-t3-retry-0001'),
        );
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        assert.deepEqual(retry.body, { versionId, sequence });
        assert.deepEqual(await rowCounts(first, DOC), afterSuccess, 'a retry writes 0 rows');
      }

      // Same operation id, different request: 409 operation_conflict, no result disclosed.
      const conflicting = await apiFetch(
        first,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        restoreBody(seeded.baseRevision + 1, 'op-t3-retry-0001'),
      );
      assert.equal(conflicting.status, 409);
      assert.deepEqual(conflicting.body, { error: 'operation_conflict' });
      assert.deepEqual(await rowCounts(first, DOC), afterSuccess);

      // Post-commit restart: a new process (store reopened) still answers from the row.
      await first.close();
      first = await startTestServer({ dataPath });
      const reopenedCookie = await session(first, 'demo-ada');
      const afterRestart = await rowCounts(first, DOC);
      assert.deepEqual(afterRestart, afterSuccess, 'the rows survived the restart');
      const replay = await apiFetch(
        first,
        'POST',
        restorePath(DOC, seeded.versionId),
        reopenedCookie,
        restoreBody(seeded.baseRevision, 'op-t3-retry-0001'),
      );
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.deepEqual(replay.body, { versionId, sequence });
      assert.deepEqual(await rowCounts(first, DOC), afterSuccess, '0 rows after the restart');

      // The durable text is the restored one, and the version list has all three rows.
      assert.equal(await durableText(first.store, DOC), 'target');
      const versionsResponse = await apiFetch(
        first,
        'GET',
        `/api/documents/${DOC}/versions`,
        reopenedCookie,
      );
      assert.equal(versionsResponse.status, 200);
      const versions = versionsResponse.body['versions'] as { kind: string; sequence: number }[];
      assert.deepEqual(
        versions.map((version) => version.kind),
        ['restored', 'pre-restore', 'manual'],
      );
      // The list carries the content revision the next preview must use as `baseRevision`.
      assert.equal(
        versionsResponse.body['currentRevision'],
        versions[0]?.sequence,
        'currentRevision must equal the newest version content revision',
      );
    } finally {
      await first.close();
      if (createdByFirst) {
        rmSync(dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * T5/T9/T10 — pre-restore content, offline restore, eviction + compaction
 * ------------------------------------------------------------------ */

describe('T5/T9/T10 — pre-restore content and room lifecycle', () => {
  it('captures the pre-restore text before apply and survives eviction and compaction', async () => {
    const server = await bootServer();
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const cookie = await session(server, 'demo-ada');

      // T9: nobody is online. The restore still works and the room is evicted afterwards.
      assert.equal(server.handle.registry.hasRoom(DOC), false);
      const response = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        restoreBody(seeded.baseRevision, 'op-t9-offline-0001'),
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(await durableText(server.store, DOC), 'target');
      assert.equal(
        server.handle.registry.hasRoom(DOC),
        false,
        'the lease is released and the empty room is evicted',
      );

      // T5: the pre-restore version holds the text as it was **before** the apply.
      const versions = await fullStore(server.store).listDocumentVersions(DOC);
      const preRestore = versions.find((version) => version.kind === 'pre-restore');
      assert.notEqual(preRestore, undefined);
      if (preRestore === undefined) return;
      const preState = await fullStore(server.store).readDocumentVersion(DOC, preRestore.id);
      assert.equal(textOfState(preState?.state ?? new Uint8Array()), 'base-later');

      // T10: force a compaction (eviction already happened above), then reopen the store.
      const stored = await server.store.load(DOC);
      assert.notEqual(stored, null);
      if (stored === null) return;
      const live = new Y.Doc();
      try {
        applyStoredDocument(stored, live);
        const meta = isDocumentMetaStore(server.store)
          ? await server.store.documentMeta(DOC)
          : null;
        const through = meta?.revision ?? 0;
        assert.ok(through > 0);
        await server.store.compact(DOC, Y.encodeStateAsUpdate(live), through);
      } finally {
        live.destroy();
      }

      // After compaction the log is empty, so the only way to see the restore is the version
      // row and the snapshot. Replaying the durable state must still produce the restored text.
      assert.equal(await durableText(server.store, DOC), 'target');
      const afterCompact = await fullStore(server.store).listDocumentVersions(DOC);
      assert.equal(afterCompact.length, versions.length, 'compaction does not touch versions');
      const stillThere = await fullStore(server.store).readDocumentVersion(DOC, preRestore.id);
      assert.equal(textOfState(stillThere?.state ?? new Uint8Array()), 'base-later');

      // A later join hydrates the restored document from the compacted store.
      const client = await TestClient.connect(server.url, {
        cookie: await session(server, 'demo-ada'),
      });
      try {
        await client.joinAndWait(DOC);
        assert.equal(
          server.handle.registry.requireRoom(DOC).doc.getText('content').toString(),
          'target',
        );
      } finally {
        client.destroy();
      }
    } finally {
      await server.close();
    }
  });

  it('evicts a restore-created room even if the last participant leaves mid-restore', async () => {
    // T9's "last person leaves" half: the lease is what keeps the room alive until the restore
    // has finished. Proven through the registry's introspection rather than a sleep: after the
    // restore returns, the room must be gone, which can only be true if eviction waited.
    const server = await bootServer();
    const client = await TestClient.connect(server.url, {
      cookie: await session(server, 'demo-ada'),
    });
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      await client.joinAndWait(DOC);
      assert.equal(server.handle.registry.hasRoom(DOC), true);

      const response = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        await session(server, 'demo-ada'),
        restoreBody(seeded.baseRevision, 'op-t9-leave-0001'),
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      // The participant is still there, so the room stays; it is not evicted out from under it.
      assert.equal(server.handle.registry.hasRoom(DOC), true);
      assert.equal(server.handle.registry.requireRoom(DOC).doc.getText('content').toString(), 'target');

      client.leave(DOC);
      await waitFor(
        () => server.handle.registry.hasRoom(DOC) === false,
        'the room is evicted after the last participant leaves',
      );
    } finally {
      client.destroy();
      await server.close();
    }
  });
  it('defers eviction while an in-flight restore holds the room lease', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'insighthub-restore-drain-'));
    const opened = await openDocumentStore(dataPath);
    const gated = new GatedRestoreStore(opened.store);
    let server: TestServer | null = null;
    let client: TestClient | null = null;
    try {
      const seeded = await seedRestorable(opened.store, DOC, 'target', 'base-later');
      server = await startTestServer({ store: gated, authorization: 'enforced' });
      client = await TestClient.connect(server.url, {
        cookie: await session(server, 'demo-ada'),
      });
      await client.joinAndWait(DOC);

      const restorePromise = apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        await session(server, 'demo-ada'),
        restoreBody(seeded.baseRevision, 'op-t9-drain-0001'),
      );
      await waitFor(() => gated.restoreStarted, 'the restore reached appendRestore');

      // The last participant leaves while the restore is between apply and persist. The room
      // must not be destroyed under the task: the lease defers the eviction.
      client.destroy();
      client = null;
      await waitFor(
        () =>
          server !== null &&
          server.handle.registry.hasRoom(DOC) &&
          server.handle.registry.requireRoom(DOC).isEmpty,
        'the room is empty but still leased',
      );
      assert.equal(
        server.handle.registry.hasRoom(DOC),
        true,
        'an in-flight restore keeps the room alive',
      );

      gated.releaseRestore();
      const response = await restorePromise;
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(await durableText(opened.store, DOC), 'target');

      // Only after the lease is released does normal eviction policy run.
      await waitFor(
        () => server !== null && server.handle.registry.hasRoom(DOC) === false,
        'the room is evicted after the lease is released',
      );
    } finally {
      gated.releaseRestore();
      client?.destroy();
      if (server !== null) await server.close();
      await opened.store.close();
      rmSync(dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

/* ------------------------------------------------------------------ *
 * T6 — concurrent restores
 * ------------------------------------------------------------------ */

describe('T6 — two concurrent restores cannot both apply', () => {
  it('serialises them: one 200 and one 409 stale_revision', async () => {
    const server = await bootServer();
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const cookie = await session(server, 'demo-ada');
      const before = await rowCounts(server, DOC);

      const [left, right] = await Promise.all([
        apiFetch(
          server,
          'POST',
          restorePath(DOC, seeded.versionId),
          cookie,
          restoreBody(seeded.baseRevision, 'op-t6-left-0001'),
        ),
        apiFetch(
          server,
          'POST',
          restorePath(DOC, seeded.versionId),
          cookie,
          restoreBody(seeded.baseRevision, 'op-t6-right-0001'),
        ),
      ]);

      const statuses = [left.status, right.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 409], `statuses: ${left.status}/${right.status}`);

      // Exactly one commit: 2 versions + 1 update + 1 operation.
      const after = await rowCounts(server, DOC);
      assert.deepEqual(after, {
        versions: before.versions + 2,
        updates: before.updates + 1,
        operations: before.operations + 1,
      });
      assert.equal(await durableText(server.store, DOC), 'target');

      const refused = left.status === 409 ? left : right;
      assert.deepEqual(refused.body, {
        error: 'stale_revision',
        currentRevision: seeded.baseRevision + 1,
      });
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * T11 — permissions (D-V1: Owner only)
 * ------------------------------------------------------------------ */

describe('T11 — permissions: Owner 200, Editor 403, no membership 404, anonymous 401', () => {
  it('lets the Owner restore', async () => {
    const server = await bootServer();
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const response = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        await session(server, 'demo-ada'),
        restoreBody(seeded.baseRevision, 'op-t11-owner-0001'),
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(await durableText(server.store, DOC), 'target');
    } finally {
      await server.close();
    }
  });

  it('refuses an Editor with 403 and writes nothing', async () => {
    const server = await bootServer();
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const before = await rowCounts(server, DOC);
      const response = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        await session(server, 'demo-grace'),
        restoreBody(seeded.baseRevision, 'op-t11-editor-0001'),
      );
      assert.equal(response.status, 403);
      assert.deepEqual(response.body, { error: 'forbidden' });
      assert.deepEqual(await rowCounts(server, DOC), before);
      assert.equal(await durableText(server.store, DOC), 'base-later');
    } finally {
      await server.close();
    }
  });

  it('answers 404 for no membership and for an unknown document (non-disclosure)', async () => {
    const server = await bootServer();
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      // `demo-linus` has no membership on `demo-private-notes`; the document is otherwise real.
      const noMembership = await apiFetch(
        server,
        'POST',
        restorePath(PRIVATE_DOC, seeded.versionId),
        await session(server, 'demo-linus'),
        restoreBody(seeded.baseRevision, 'op-t11-nomember-01'),
      );
      assert.equal(noMembership.status, 404);
      assert.deepEqual(noMembership.body, { error: 'not_found' });

      const unknownDocument = await apiFetch(
        server,
        'POST',
        restorePath('document-that-does-not-exist', seeded.versionId),
        await session(server, 'demo-ada'),
        restoreBody(seeded.baseRevision, 'op-t11-unknown-01'),
      );
      assert.equal(unknownDocument.status, 404);
      assert.deepEqual(unknownDocument.body, { error: 'not_found' });
    } finally {
      await server.close();
    }
  });

  it('requires a session: 401 session_required, for restore and for the list', async () => {
    const server = await bootServer();
    try {
      const restore = await apiFetch(server, 'POST', restorePath(DOC, 'some-version'), undefined, {
        baseRevision: 0,
        operationId: 'op-t11-anon-0001',
      });
      assert.equal(restore.status, 401);
      assert.deepEqual(restore.body, { error: 'session_required' });

      const list = await apiFetch(server, 'GET', `/api/documents/${DOC}/versions`, undefined);
      assert.equal(list.status, 401);
      assert.deepEqual(list.body, { error: 'session_required' });
    } finally {
      await server.close();
    }
  });

  it('lets a viewer list versions but not restore (canRead vs Owner-only)', async () => {
    const server = await bootServer();
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const cookie = await session(server, 'demo-linus'); // viewer
      const list = await apiFetch(server, 'GET', `/api/documents/${DOC}/versions`, cookie);
      assert.equal(list.status, 200);
      const versions = list.body['versions'] as { id: string; sequence: number; kind: string }[];
      assert.equal(versions.length, 1);
      assert.equal(versions[0]?.id, seeded.versionId);
      assert.equal(
        Object.hasOwn(versions[0] ?? {}, 'state'),
        false,
        'the list never carries yjs_state',
      );

      const restore = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        restoreBody(seeded.baseRevision, 'op-t11-viewer-0001'),
      );
      assert.equal(restore.status, 403);
    } finally {
      await server.close();
    }
  });

  it('does not list versions of a document the caller cannot read', async () => {
    const server = await bootServer();
    try {
      await seedRestorable(server.store, PRIVATE_DOC, 'secret', 'secret-later');
      const response = await apiFetch(
        server,
        'GET',
        `/api/documents/${PRIVATE_DOC}/versions`,
        await session(server, 'demo-linus'),
      );
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: 'not_found' });
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * T12 — a join's empty update does not invalidate a preview
 * ------------------------------------------------------------------ */

describe('T12 — join empty update does not advance the content revision', () => {
  it('a SyncStep2 with no content changes the log but not the revision, so no false 409', async () => {
    const server = await bootServer();
    const client = await TestClient.connect(server.url, {
      cookie: await session(server, 'demo-ada'),
    });
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      await client.joinAndWait(DOC);
      const revisionBefore = await fullStore(server.store).documentContentRevision(DOC);
      const logBefore = (await server.store.load(DOC))?.updates.length ?? 0;

      // A real client answering the server's SyncStep1 with an empty document's state.
      const emptyDoc = new Y.Doc();
      client.sendBinary(syncStep2Frame(emptyDoc));
      emptyDoc.destroy();

      await waitFor(
        async () => ((await server.store.load(DOC))?.updates.length ?? 0) > logBefore,
        'the empty update is appended to the log',
      );
      assert.equal(
        await fullStore(server.store).documentContentRevision(DOC),
        revisionBefore,
        'the body did not change, so the revision must not move',
      );

      // The preview taken before the join is still valid: no false 409.
      const response = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        await session(server, 'demo-ada'),
        restoreBody(seeded.baseRevision, 'op-t12-join-0001'),
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(await durableText(server.store, DOC), 'target');
    } finally {
      client.destroy();
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * T13 — operation ids are per document
 * ------------------------------------------------------------------ */

describe('T13 — an operation id reused on another document does not leak', () => {
  it('treats it as an independent operation and never exposes the first document’s version', async () => {
    const server = await bootServer();
    try {
      const seededA = await seedRestorable(server.store, DOC, 'target-a', 'later-a');
      const seededB = await seedRestorable(server.store, PRIVATE_DOC, 'target-b', 'later-b');
      const cookie = await session(server, 'demo-ada');

      const first = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seededA.versionId),
        cookie,
        restoreBody(seededA.baseRevision, 'op-t13-shared-0001'),
      );
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const versionA = String(first.body['versionId']);

      const second = await apiFetch(
        server,
        'POST',
        restorePath(PRIVATE_DOC, seededB.versionId),
        cookie,
        restoreBody(seededB.baseRevision, 'op-t13-shared-0001'),
      );
      assert.equal(second.status, 200, JSON.stringify(second.body));
      const versionB = String(second.body['versionId']);
      assert.notEqual(versionB, versionA, 'the second document must get its own version');

      // B's version list does not contain A's version, and A's version id is not restorable
      // through B (scoped read).
      const listB = await apiFetch(server, 'GET', `/api/documents/${PRIVATE_DOC}/versions`, cookie);
      assert.equal(listB.status, 200);
      const ids = (listB.body['versions'] as { id: string }[]).map((version) => version.id);
      assert.equal(ids.includes(versionA), false);

      const crossRestore = await apiFetch(
        server,
        'POST',
        restorePath(PRIVATE_DOC, versionA),
        cookie,
        restoreBody(seededB.baseRevision + 1, 'op-t13-cross-0001'),
      );
      assert.equal(crossRestore.status, 404);
      assert.deepEqual(crossRestore.body, { error: 'not_found' });
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * T14 — no client-computed restore
 * ------------------------------------------------------------------ */

describe('T14 — the server does not trust a client-computed restore', () => {
  it('rejects any body that carries an update/target/actor', async () => {
    const server = await bootServer();
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const cookie = await session(server, 'demo-ada');
      const before = await rowCounts(server, DOC);

      const badBodies: unknown[] = [
        { baseRevision: seeded.baseRevision, operationId: 'op-t14-extra-0001', update: 'AAAA' },
        { baseRevision: seeded.baseRevision, operationId: 'op-t14-extra-0002', text: 'target' },
        { baseRevision: seeded.baseRevision, operationId: 'op-t14-extra-0003', actorId: 'demo-grace' },
        { baseRevision: seeded.baseRevision },
        { baseRevision: seeded.baseRevision, operationId: 'short' },
        { baseRevision: -1, operationId: 'op-t14-negative-1' },
        { baseRevision: 1.5, operationId: 'op-t14-fraction-1' },
        { baseRevision: '2', operationId: 'op-t14-string-01' },
      ];

      for (const body of badBodies) {
        const response = await apiFetch(
          server,
          'POST',
          restorePath(DOC, seeded.versionId),
          cookie,
          body,
        );
        assert.equal(response.status, 400, `body ${JSON.stringify(body)}`);
        assert.deepEqual(response.body, { error: 'invalid_request' });
      }
      assert.deepEqual(await rowCounts(server, DOC), before, 'no invalid request wrote a row');

      // A normal client update keeps being a normal update: persisted, broadcast, and **not**
      // a restore (no version row, no operation row). This is the contract's whole point —
      // there is no path that turns a client's bytes into a restore.
      const client = await TestClient.connect(server.url, {
        cookie: await session(server, 'demo-ada'),
      });
      try {
        await client.joinAndWait(DOC);
        const logBefore = (await server.store.load(DOC))?.updates.length ?? 0;
        const docs = new Y.Doc();
        docs.getText('content').insert(0, 'X');
        const update = Y.encodeStateAsUpdate(docs);
        docs.destroy();
        client.sendBinary(syncUpdateFrameFromBytes(update));
        await waitFor(
          async () => ((await server.store.load(DOC))?.updates.length ?? 0) > logBefore,
          'the ordinary update is persisted',
        );
        const afterEdit = await rowCounts(server, DOC);
        assert.equal(afterEdit.versions, before.versions, 'an edit is not a version capture');
        assert.equal(afterEdit.operations, before.operations, 'an edit is not a restore operation');
      } finally {
        client.destroy();
      }
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * R-5 — restoring a version whose body already is the current body
 * ------------------------------------------------------------------ */

/**
 * The **text-level no-op** restore (A7 R-5).
 *
 * `computeRestoreUpdate` returns `changed: false` when the selected version's text equals the
 * current text, and `#runRestore` skips both `applyServerUpdate` and `broadcastUpdate` on that
 * path. It is still a real restore request: `appendRestore` commits the same four rows as any
 * successful restore, with a **zero-byte** update, and — because the body did not change — the
 * content revision does not advance (so the response `sequence` equals the request's
 * `baseRevision`, and a preview taken before it stays valid).
 *
 * This pins the HTTP-observable contract of that branch; only the store half was covered before
 * (`restore-store.test.ts`, "does not advance the content revision when the selected text is
 * already current").
 */
describe('R-5 — restore whose target text already is the current text', () => {
  it('returns 200 with an unchanged revision, writes four rows (empty update), and broadcasts nothing', async () => {
    const server = await bootServer();
    const clients: TestClient[] = [];
    try {
      // The version was captured at `same-body`; the later body is the same text again. The two
      // Yjs states still differ (the second append deletes and re-inserts the text), so this is
      // a real text-level no-op rather than two identical states.
      const seeded = await seedRestorable(server.store, DOC, 'same-body', 'same-body');
      const cookie = await session(server, 'demo-ada');

      const observer = await TestClient.connect(server.url, { cookie });
      clients.push(observer);
      await observer.joinAndWait(DOC);
      // Let the join handshake's SyncStep1 land, then look only at what the restore sends.
      await observer.settle(100);
      observer.clear();

      const before = await rowCounts(server, DOC);
      const revisionBefore = await fullStore(server.store).documentContentRevision(DOC);
      assert.equal(seeded.baseRevision, revisionBefore);
      assert.ok(
        (await durableText(server.store, DOC)) === 'same-body',
        'the fixture starts with the target body already current',
      );
      assert.ok((await lastUpdateByteLength(server, DOC)) > 0, 'the seeded update is not empty');

      const response = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        restoreBody(seeded.baseRevision, 'op-r5-noop-0001'),
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(typeof response.body['versionId'], 'string');
      assert.equal(
        response.body['sequence'],
        seeded.baseRevision,
        'a no-op restore returns the unchanged content revision',
      );

      // C1's accounting is four rows even when the body did not change ...
      const after = await rowCounts(server, DOC);
      assert.deepEqual(after, {
        versions: before.versions + 2,
        updates: before.updates + 1,
        operations: before.operations + 1,
      });
      // ... but the new update row is empty and the content revision did not move.
      assert.equal(await lastUpdateByteLength(server, DOC), 0, 'the restore update is zero bytes');
      assert.equal(await fullStore(server.store).documentContentRevision(DOC), revisionBefore);

      // A body that did not change has nothing to broadcast.
      await observer.settle(250);
      assert.equal(
        observer.binaryFrames().length,
        0,
        'a no-op restore must not broadcast a binary update',
      );
      assert.equal(await durableText(server.store, DOC), 'same-body');

      // Both new version rows carry the unchanged revision; the response names the `restored` one.
      const versions = await fullStore(server.store).listDocumentVersions(DOC);
      assert.equal(versions.length, 3, 'manual + pre-restore + restored');
      const restoredRow = versions.find((version) => version.kind === 'restored');
      const preRestoreRow = versions.find((version) => version.kind === 'pre-restore');
      assert.equal(restoredRow?.sequence, revisionBefore);
      assert.equal(preRestoreRow?.sequence, revisionBefore);
      assert.equal(response.body['versionId'], restoredRow?.id);

      // The room is evicted after the last participant leaves, and a later join hydrates the
      // same body from the durable log (empty restore update included).
      observer.destroy();
      await waitFor(
        () => server.handle.registry.hasRoom(DOC) === false,
        'the room is evicted after the last participant leaves',
      );
      const recovered = await TestClient.connect(server.url, { cookie });
      clients.push(recovered);
      await recovered.joinAndWait(DOC);
      assert.equal(
        server.handle.registry.requireRoom(DOC).doc.getText('content').toString(),
        'same-body',
        'a later join still hydrates the unchanged body',
      );
    } finally {
      for (const client of clients) client.destroy();
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * C3 — retrying an operation id, and reusing it for a different request
 * ------------------------------------------------------------------ */

/**
 * The retry path end to end, with a real observer socket (A7 R-2's sibling: "no second
 * broadcast" is a wire fact, not an inference).
 *
 * The retry deliberately carries the **preview** `baseRevision`, which the first attempt already
 * advanced. The operation-id lookup runs before the revision compare (C3, C4 "同一 op id 重试
 * （含 `baseRevision` 已过期）返回原结果"), so the answer is the original `{versionId, sequence}`
 * with zero new rows and zero new binary frames. Under the same operation id, a different valid
 * request body hashes differently and is refused as `409 operation_conflict` — also with no rows
 * and no broadcast.
 */
describe('C3 — the same operation id retried and reused', () => {
  it('replays the original result for an expired baseRevision, then refuses a different request', async () => {
    const server = await bootServer();
    const clients: TestClient[] = [];
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const cookie = await session(server, 'demo-ada');

      const observer = await TestClient.connect(server.url, { cookie });
      clients.push(observer);
      await observer.joinAndWait(DOC);
      await observer.settle(100);
      observer.clear();

      const before = await rowCounts(server, DOC);
      const operationId = 'op-c3-retry-0001';
      const first = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        restoreBody(seeded.baseRevision, operationId),
      );
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const versionId = String(first.body['versionId']);
      const sequence = Number(first.body['sequence']);
      assert.equal(sequence, seeded.baseRevision + 1);

      const afterFirst = await rowCounts(server, DOC);
      assert.deepEqual(afterFirst, {
        versions: before.versions + 2,
        updates: before.updates + 1,
        operations: before.operations + 1,
      });
      await waitFor(
        () => observer.binaryFrames().length === 1,
        'the first restore broadcasts exactly one update',
      );
      observer.clear();

      // Same request, same operation id, expired `baseRevision` (the revision the client
      // previewed; the first attempt has since advanced it). The op-id lookup wins.
      const retry = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        restoreBody(seeded.baseRevision, operationId),
      );
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.deepEqual(retry.body, { versionId, sequence }, 'the original result is replayed');
      assert.deepEqual(await rowCounts(server, DOC), afterFirst, 'a retry writes 0 new rows');

      await observer.settle(250);
      assert.equal(
        observer.binaryFrames().length,
        0,
        'a replayed retry must not broadcast a second update',
      );
      assert.equal(await durableText(server.store, DOC), 'target');

      // Same operation id, different valid request body → different request hash → 409. The
      // second case changes the selected version (the restored row is a real version id), so
      // the conflict is not merely "stale revision" under another name.
      const conflicts = [
        {
          label: 'different baseRevision',
          path: restorePath(DOC, seeded.versionId),
          body: restoreBody(seeded.baseRevision + 5, operationId),
        },
        {
          label: 'different selected version',
          path: restorePath(DOC, versionId),
          body: restoreBody(seeded.baseRevision, operationId),
        },
      ];
      for (const conflict of conflicts) {
        const response = await apiFetch(server, 'POST', conflict.path, cookie, conflict.body);
        assert.equal(response.status, 409, `${conflict.label}: ${JSON.stringify(response.body)}`);
        assert.deepEqual(response.body, { error: 'operation_conflict' });
        assert.deepEqual(
          await rowCounts(server, DOC),
          afterFirst,
          `${conflict.label}: a conflict writes 0 rows`,
        );
      }

      await observer.settle(250);
      assert.equal(
        observer.binaryFrames().length,
        0,
        'a conflict must not broadcast a binary update',
      );
      assert.equal(await durableText(server.store, DOC), 'target');
    } finally {
      for (const client of clients) client.destroy();
      await server.close();
    }
  });
});
