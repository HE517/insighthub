/**
 * G1 — the restore's authorization is re-checked **inside the document's FIFO slot**
 * (`docs/CONTRACTS.md` §12.1 G1; `docs/DECISIONS.md` D-090 §10).
 *
 * ## What this suite is
 *
 * Every test boots the real app (`startTestServer`) on a real SQLite file, with the real
 * `AuthzService` deciding both the HTTP entry check and the in-slot re-check, real `ws` clients
 * joined to the room, and a store wrapper that **holds `append` open**. Holding a store call open
 * is what makes the queue observable instead of inferred: the first task is pinned inside the
 * document's FIFO slot while the restore HTTP request arrives, passes the entry check and is
 * enqueued behind it. Only then is the membership changed, so the refusal under test can only
 * come from the re-check — the entry check already passed, by construction.
 *
 * ## The mechanism, stated
 *
 * ```text
 * holdAppends()                       ← the wrapper's gate
 * client sends an empty SyncStep2     → queue slot #1 blocks inside store.append
 * POST …/restore                      → entry authz (Owner) passes, enqueued as slot #2
 * waitFor(mutationQueueDepth === 2)   ← explicit proof the restore is waiting in the queue
 * revoke / downgrade the Owner        ← the membership the entry check saw is now gone
 * releaseAppends()                    → slot #1 commits, slot #2 runs its re-check
 * ```
 *
 * Without G1, slot #2 reads the operation row (replay test) or the version/revision and restores,
 * because its only permission decision happened before it queued.
 *
 * ## Test map
 *
 * | # | Proven here |
 * | --- | --- |
 * | 1 | Owner membership deleted while queued → 404 `not_found`, 0 new versions/ops, no restore broadcast, body unchanged |
 * | 2 | Owner downgraded to `viewer` while queued → 403 `forbidden`, same 0-row/no-broadcast outcome |
 * | 3 | the same committed `operationId` retried after revocation mid-queue → 404, **not** a 200 replay |
 * | 4 | control: unchanged permission in the same queued position → 200 and the normal four rows + broadcast |
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { decodeSyncFrame, readSyncUpdatePayload } from '@insighthub/shared';
import * as Y from 'yjs';

import { isDocumentMetaStore } from '../persistence/document-meta.js';
import {
  isDocumentVersionStore,
  type CaptureDocumentVersionInput,
  type DocumentVersionStore,
  type DocumentVersionSummary,
  type StoredDocumentVersion,
} from '../persistence/document-versions.js';
import { applyStoredDocument } from '../persistence/hydrator.js';
import { openDocumentStore } from '../persistence/open-store.js';
import { DATABASE_FILE_NAME } from '../persistence/sqlite-store.js';
import { loadSqliteModule, type SqliteModule } from '../persistence/sqlite-runtime.js';
import { ControllableStore } from '../persistence/test-stores.js';
import type { DocumentStore } from '../persistence/types.js';
import {
  bootstrapSessionCookie,
  startTestServer,
  syncStep2Frame,
  TestClient,
  type TestServer,
} from '../rooms/test-harness.js';

/** Owner of this document in the demo fixture (`demo-ada`). */
const DOC = 'demo-document';

type RawDb = InstanceType<SqliteModule['DatabaseSync']>;
type FullStore = DocumentStore & DocumentVersionStore;
type MembershipRole = 'viewer' | 'commenter' | 'editor' | 'owner';

/* ------------------------------------------------------------------ *
 * The store wrapper
 * ------------------------------------------------------------------ */

/**
 * Holds `append` open and forwards the version capability.
 *
 * `ControllableStore` is the existing FIFO-occupancy tool (M2 scenarios). The forwarding matters:
 * the registry probes the injected object for the version capability, and a plain wrapper would
 * hide it, making every restore answer `restore_failed` before reaching the code under test.
 */
class GatedAppendStore extends ControllableStore {
  async listDocumentVersions(documentId: string): Promise<readonly DocumentVersionSummary[]> {
    return await fullStore(this.inner).listDocumentVersions(documentId);
  }

  async readDocumentVersion(
    documentId: string,
    versionId: string,
  ): Promise<StoredDocumentVersion | null> {
    return await fullStore(this.inner).readDocumentVersion(documentId, versionId);
  }

  async captureDocumentVersion(
    input: CaptureDocumentVersionInput,
  ): Promise<DocumentVersionSummary> {
    return await fullStore(this.inner).captureDocumentVersion(input);
  }

  async documentContentRevision(documentId: string): Promise<number> {
    return await fullStore(this.inner).documentContentRevision(documentId);
  }
}

function fullStore(store: DocumentStore): FullStore {
  assert.ok(isDocumentVersionStore(store), 'the real SQLite store must serve versions');
  return store;
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Seed one `manual` version of `targetText`, then move the live body to `currentText`. */
async function seedRestorable(
  store: DocumentStore,
  documentId: string,
  targetText: string,
  currentText: string,
): Promise<{ versionId: string; baseRevision: number }> {
  const full = fullStore(store);
  assert.ok(isDocumentMetaStore(store), 'the SQLite store must own metadata');
  await store.ensureDocumentMeta(documentId, 'demo-ada');

  // One Yjs client chain: the later body is a relative update from the document that holds the
  // target text, so restoring the version is a real text change.
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

/**
 * Change (or delete) one membership row in the table the decision core reads.
 *
 * A separate connection on purpose: the test must prove the running server sees the change, not
 * that a fixture was re-seeded (`restore.authz.test.ts` establishes the same pattern).
 */
async function setMembershipRole(
  dataPath: string,
  documentId: string,
  userId: string,
  role: MembershipRole | null,
): Promise<void> {
  await withRawDb(dataPath, (db) => {
    if (role === null) {
      const result = db
        .prepare('DELETE FROM authz_document_membership WHERE document_id = ? AND user_id = ?')
        .run(documentId, userId);
      assert.equal(Number(result.changes), 1, 'the membership row being revoked must exist');
      return;
    }
    const result = db
      .prepare(
        'UPDATE authz_document_membership SET role = ? WHERE document_id = ? AND user_id = ?',
      )
      .run(role, documentId, userId);
    assert.equal(Number(result.changes), 1, 'the membership row being changed must exist');
  });
}

interface RowCounts {
  readonly versions: number;
  readonly updates: number;
  readonly operations: number;
}

async function rowCountsAt(dataPath: string, documentId: string): Promise<RowCounts> {
  return await withRawDb(dataPath, (db) => {
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
  readonly text: string;
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
  return { status: response.status, text, body: parsed as Record<string, unknown> };
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A refusal must be the frozen body and must disclose nothing about the restored version. */
function expectRefusal(
  response: ApiResponse,
  status: number,
  error: string,
  context: string,
): void {
  assert.equal(response.status, status, `${context}: ${response.text}`);
  assert.deepEqual(response.body, { error }, context);
  assert.equal(response.text.includes('versionId'), false, `${context}: no versionId`);
  assert.equal(response.text.includes('sequence'), false, `${context}: no sequence`);
}

/** Decode every binary frame an observer received into its raw sync payload. */
function syncPayloads(client: TestClient): (Uint8Array | null)[] {
  return client.binaryFrames().map((frame) => {
    const decoded = decodeSyncFrame(frame);
    return decoded === null ? null : readSyncUpdatePayload(decoded);
  });
}

/* ------------------------------------------------------------------ *
 * The gated server
 * ------------------------------------------------------------------ */

interface GatedServer {
  readonly server: TestServer;
  readonly gated: GatedAppendStore;
  readonly dataPath: string;
  readonly seeded: { versionId: string; baseRevision: number };
}

/**
 * Boot the real server on a real file with `append` gated.
 *
 * The store is seeded **before** the harness opens it, so the wrapper does not have to expose
 * metadata capture just to build the fixture; `server.dataPath` still names the same database the
 * authz table lives in, which is what lets this suite revoke a membership mid-queue.
 */
async function bootGatedServer(): Promise<GatedServer> {
  const dataPath = mkdtempSync(join(tmpdir(), 'insighthub-restore-g1-'));

  const opened = await openDocumentStore(dataPath);
  let seeded: { versionId: string; baseRevision: number };
  try {
    seeded = await seedRestorable(opened.store, DOC, 'target', 'base-later');
  } finally {
    await opened.store.close();
  }

  const holder: { gated?: GatedAppendStore } = {};
  const server = await startTestServer({
    dataPath,
    wrapStore: (inner) => {
      const gated = new GatedAppendStore(inner);
      holder.gated = gated;
      return gated;
    },
    authorization: 'enforced',
  });

  const gated = holder.gated;
  assert.ok(gated !== undefined, 'wrapStore must have been applied to the harness store');
  return { server, gated, dataPath, seeded };
}

async function closeGatedServer(context: GatedServer): Promise<void> {
  await context.server.close();
  rmSync(context.dataPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/**
 * Join two clients: a `sender` (its frames are not echoed back to it) and an `observer` (which is
 * how "no restore broadcast" becomes observable).
 */
async function joinRoom(server: TestServer): Promise<{ observer: TestClient; sender: TestClient }> {
  const cookie = await session(server, 'demo-ada');
  const observer = await TestClient.connect(server.url, { cookie });
  const sender = await TestClient.connect(server.url, { cookie });
  await observer.joinAndWait(DOC);
  await sender.joinAndWait(DOC);
  return { observer, sender };
}

/**
 * Queue one restore behind a deliberately blocked client append, then run `whileQueued` and let
 * the queue drain.
 *
 * The empty `SyncStep2` is the FIFO occupant: it appends a 2-byte update, but D-RC1's
 * `contentChanged` is false, so the content revision does not move and the restore's
 * `baseRevision` stays valid — if the restore were allowed to run, it would really restore.
 *
 * Returns the HTTP response and the exact bytes the occupying task broadcast, so a caller can
 * assert both "the restore was refused" and "the only frame on the wire was the preceding task's".
 */
async function runQueuedRestore(input: {
  readonly server: TestServer;
  readonly gated: GatedAppendStore;
  readonly sender: TestClient;
  readonly observer: TestClient;
  readonly cookie: string;
  readonly versionId: string;
  readonly baseRevision: number;
  readonly operationId: string;
  readonly whileQueued: () => Promise<void>;
}): Promise<{ readonly response: ApiResponse; readonly occupyingUpdate: Uint8Array }> {
  const emptyDoc = new Y.Doc();
  const occupyingUpdate = Y.encodeStateAsUpdate(emptyDoc);
  const appendsBefore = input.gated.appendCalls;
  let responseSettled = false;

  try {
    input.observer.clear();
    input.sender.clear();
    input.gated.holdAppends();

    input.sender.sendBinary(syncStep2Frame(emptyDoc));
    await waitFor(
      () => input.gated.appendCalls === appendsBefore + 1,
      'the preceding append reached the store and is holding the FIFO slot',
    );
    assert.equal(
      input.observer.binaryFrames().length,
      0,
      'nothing may be broadcast while the slot is held',
    );

    const pending = apiFetch(
      input.server,
      'POST',
      restorePath(DOC, input.versionId),
      input.cookie,
      restoreBody(input.baseRevision, input.operationId),
    ).then((response) => {
      responseSettled = true;
      return response;
    });

    // The explicit queue evidence: the request has been enqueued (running append + waiting
    // restore) and has not resolved, so whatever happens next is decided inside the slot.
    await waitFor(
      () => input.server.handle.registry.mutationQueueDepth(DOC) === 2,
      'the restore is enqueued behind the blocked append',
    );
    assert.equal(
      responseSettled,
      false,
      'the restore must still be waiting while the FIFO slot is occupied',
    );

    await input.whileQueued();
    assert.equal(
      responseSettled,
      false,
      'changing the membership must not resolve the queued request on its own',
    );

    input.gated.releaseAppends();
    const response = await pending;

    // The occupying task commits after the gate opens and is the only thing that may be
    // broadcast: a refused restore has no update of its own to send.
    await waitFor(
      () => input.observer.binaryFrames().length >= 1,
      'the occupying append is broadcast after it commits',
    );
    return { response, occupyingUpdate };
  } finally {
    input.gated.releaseAppends();
    emptyDoc.destroy();
  }
}

/* ------------------------------------------------------------------ *
 * 1. Membership removal while queued → 404
 * ------------------------------------------------------------------ */

describe('G1 — the restore is re-checked inside the FIFO slot (D-090 §10)', () => {
  it('answers 404 and writes/broadcasts nothing when the Owner membership is deleted mid-queue', async () => {
    const context = await bootGatedServer();
    const { server, gated, dataPath, seeded } = context;
    let clients: { observer: TestClient; sender: TestClient } | null = null;
    try {
      clients = await joinRoom(server);

      const before = await rowCountsAt(dataPath, DOC);
      assert.deepEqual(before, { versions: 1, updates: 2, operations: 0 });

      const { response, occupyingUpdate } = await runQueuedRestore({
        server,
        gated,
        sender: clients.sender,
        observer: clients.observer,
        cookie: await session(server, 'demo-ada'),
        versionId: seeded.versionId,
        baseRevision: seeded.baseRevision,
        operationId: 'op-g1-revoke-delete-0001',
        whileQueued: async () => {
          await setMembershipRole(dataPath, DOC, 'demo-ada', null);
          // The server itself must see the change, not only the raw table.
          assert.equal(server.authz.roleFor(DOC, 'demo-ada'), null);
        },
      });

      expectRefusal(response, 404, 'not_found', 'revoked Owner after the queue wait');

      // The refused restore wrote no version and no operation, and applied no update; the only
      // new log row is the preceding empty append.
      assert.deepEqual(
        await rowCountsAt(dataPath, DOC),
        { versions: before.versions, updates: before.updates + 1, operations: before.operations },
        'a refused restore must write versions/updates/operations of its own',
      );
      assert.equal(await durableText(server.store, DOC), 'base-later', 'the body is unchanged');
      assert.equal(
        server.handle.registry.requireRoom(DOC).doc.getText('content').toString(),
        'base-later',
        'the live room body is unchanged too',
      );
      const preRestoreCaptures = (await fullStore(server.store).listDocumentVersions(DOC)).filter(
        (version) => version.kind === 'pre-restore',
      );
      assert.deepEqual(preRestoreCaptures, [], 'no pre-restore version may be captured');

      // Exactly one frame: the occupying append. No restore broadcast exists to miss.
      await clients.observer.settle(150);
      const payloads = syncPayloads(clients.observer);
      assert.equal(payloads.length, 1, 'the only broadcast is the preceding append');
      assert.deepEqual(
        Buffer.from(payloads[0] ?? new Uint8Array()),
        Buffer.from(occupyingUpdate),
        'the frame is the empty update, not a restore',
      );
    } finally {
      clients?.observer.destroy();
      clients?.sender.destroy();
      await closeGatedServer(context);
    }
  });

  /* ---------------------------------------------------------------- *
   * 2. Downgrade while queued → 403
   * ---------------------------------------------------------------- */

  it('answers 403 when the Owner is downgraded to viewer mid-queue, and still writes nothing', async () => {
    const context = await bootGatedServer();
    const { server, gated, dataPath, seeded } = context;
    let clients: { observer: TestClient; sender: TestClient } | null = null;
    try {
      clients = await joinRoom(server);

      const before = await rowCountsAt(dataPath, DOC);

      const { response } = await runQueuedRestore({
        server,
        gated,
        sender: clients.sender,
        observer: clients.observer,
        cookie: await session(server, 'demo-ada'),
        versionId: seeded.versionId,
        baseRevision: seeded.baseRevision,
        operationId: 'op-g1-revoke-downgrade-0001',
        whileQueued: async () => {
          await setMembershipRole(dataPath, DOC, 'demo-ada', 'viewer');
          assert.equal(server.authz.roleFor(DOC, 'demo-ada'), 'viewer');
        },
      });

      expectRefusal(response, 403, 'forbidden', 'downgraded Owner after the queue wait');

      assert.deepEqual(
        await rowCountsAt(dataPath, DOC),
        { versions: before.versions, updates: before.updates + 1, operations: before.operations },
        'a refused restore must write versions/updates/operations of its own',
      );
      assert.equal(await durableText(server.store, DOC), 'base-later');

      // Still a reader: the version list keeps working, which distinguishes `forbidden` from a
      // blanket denial of the caller.
      const list = await apiFetch(
        server,
        'GET',
        `/api/documents/${DOC}/versions`,
        await session(server, 'demo-ada'),
      );
      assert.equal(list.status, 200, list.text);

      await clients.observer.settle(150);
      assert.equal(
        clients.observer.binaryFrames().length,
        1,
        'the only broadcast is the preceding append',
      );
    } finally {
      clients?.observer.destroy();
      clients?.sender.destroy();
      await closeGatedServer(context);
    }
  });

  /* ---------------------------------------------------------------- *
   * 3. A committed operation id must not be replayed after revocation
   * ---------------------------------------------------------------- */

  it('does not replay a committed operation id when the Owner is revoked mid-queue', async () => {
    const context = await bootGatedServer();
    const { server, gated, dataPath, seeded } = context;
    let clients: { observer: TestClient; sender: TestClient } | null = null;
    try {
      clients = await joinRoom(server);
      const cookie = await session(server, 'demo-ada');
      const operationId = 'op-g1-replay-0001';

      // A real, committed restore first: the operation id now has a result to replay.
      const first = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        restoreBody(seeded.baseRevision, operationId),
      );
      assert.equal(first.status, 200, first.text);
      const firstVersionId = String(first.body['versionId']);
      assert.equal(await durableText(server.store, DOC), 'target');
      assert.deepEqual(await rowCountsAt(dataPath, DOC), {
        versions: 3,
        updates: 3,
        operations: 1,
      });

      // The same request (same operation id, same body) is then made to wait, and the Owner is
      // revoked while it waits. Replaying the operation row would be a 200 that discloses the
      // old result; G1 requires the permission answer to come first.
      const { response } = await runQueuedRestore({
        server,
        gated,
        sender: clients.sender,
        observer: clients.observer,
        cookie,
        versionId: seeded.versionId,
        baseRevision: seeded.baseRevision,
        operationId,
        whileQueued: async () => {
          await setMembershipRole(dataPath, DOC, 'demo-ada', null);
          assert.equal(server.authz.roleFor(DOC, 'demo-ada'), null);
        },
      });

      expectRefusal(response, 404, 'not_found', 'revoked Owner retrying a committed operation');
      assert.equal(
        response.text.includes(firstVersionId),
        false,
        'the committed result must not leak through the refused retry',
      );

      // Only the preceding empty append was written; the restore and its operation row were not
      // touched, and the body is still the first restore's result.
      assert.deepEqual(
        await rowCountsAt(dataPath, DOC),
        { versions: 3, updates: 4, operations: 1 },
        'the queued retry wrote nothing of its own and did not replay',
      );
      assert.equal(await durableText(server.store, DOC), 'target');

      await clients.observer.settle(150);
      assert.equal(
        clients.observer.binaryFrames().length,
        1,
        'a replayed/refused retry must not broadcast a restore',
      );
    } finally {
      clients?.observer.destroy();
      clients?.sender.destroy();
      await closeGatedServer(context);
    }
  });

  /* ---------------------------------------------------------------- *
   * 4. Control — the same queued position succeeds when permission is unchanged
   * ---------------------------------------------------------------- */

  it('succeeds in the same queued position when the owner keeps their membership', async () => {
    const context = await bootGatedServer();
    const { server, gated, dataPath, seeded } = context;
    let clients: { observer: TestClient; sender: TestClient } | null = null;
    try {
      clients = await joinRoom(server);
      const before = await rowCountsAt(dataPath, DOC);

      const { response, occupyingUpdate } = await runQueuedRestore({
        server,
        gated,
        sender: clients.sender,
        observer: clients.observer,
        cookie: await session(server, 'demo-ada'),
        versionId: seeded.versionId,
        baseRevision: seeded.baseRevision,
        operationId: 'op-g1-control-0001',
        whileQueued: async () => {
          // The control's point: the restore really waited, and it still succeeds. Without this,
          // the refusals above could be an artefact of "the request never queued".
          assert.equal(server.authz.roleFor(DOC, 'demo-ada'), 'owner');
        },
      });

      assert.equal(response.status, 200, response.text);
      assert.equal(typeof response.body['versionId'], 'string');
      assert.equal(response.body['sequence'], 3);
      assert.equal(await durableText(server.store, DOC), 'target');

      // The normal success path is unchanged: four rows (pre-restore version, update, restored
      // version, operation), on top of the seeded two updates and the occupying empty append.
      assert.deepEqual(await rowCountsAt(dataPath, DOC), {
        versions: before.versions + 2,
        updates: before.updates + 2,
        operations: before.operations + 1,
      });

      // Two broadcasts: the occupying empty append, then the restore.
      await waitFor(
        () => clients !== null && clients.observer.binaryFrames().length >= 2,
        'the observer receives the restore broadcast after the preceding append',
      );
      const payloads = syncPayloads(clients.observer);
      assert.equal(payloads.length, 2, 'exactly the append and the restore were broadcast');
      assert.deepEqual(
        Buffer.from(payloads[0] ?? new Uint8Array()),
        Buffer.from(occupyingUpdate),
        'the first frame is the occupying empty update',
      );

      // The restore payload is the one that turns the pre-restore state into the restored text.
      const preRestore = (await fullStore(server.store).listDocumentVersions(DOC)).find(
        (version) => version.kind === 'pre-restore',
      );
      assert.notEqual(preRestore, undefined);
      if (preRestore === undefined) return;
      const preState = await fullStore(server.store).readDocumentVersion(DOC, preRestore.id);
      assert.notEqual(preState, null);
      if (preState === null) return;
      const replay = new Y.Doc();
      try {
        Y.applyUpdate(replay, preState.state);
        Y.applyUpdate(replay, payloads[1] ?? new Uint8Array());
        assert.equal(
          replay.getText('content').toString(),
          'target',
          'the second broadcast is the restore update',
        );
      } finally {
        replay.destroy();
      }
    } finally {
      clients?.observer.destroy();
      clients?.sender.destroy();
      await closeGatedServer(context);
    }
  });
});
