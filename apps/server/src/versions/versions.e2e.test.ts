/**
 * P0-1 — **the real versions path end to end**: one test, real HTTP + real WebSocket + real
 * SQLite + the real room registry, with the D-V2 clock injected so "ten minutes" is an
 * assignment rather than a wait (P0-1 pre-requisite 3).
 *
 * ## The scenario, in order
 *
 * 1. create a document through `POST /api/documents` (the creator becomes its Owner) and edit its
 *    body through a real socket → the first `auto` version appears;
 * 2. advance ten minutes, edit again → the version list shows at least two versions;
 * 3. preview a version with `baseRevision = currentRevision` → `200`, non-empty diff;
 * 4. a **second** client edits → the current revision advances by one;
 * 5. preview the same version with the old `baseRevision` → `409 stale_revision`;
 * 6. preview with the new `baseRevision` → `200`;
 * 7. restore that version with the new revision → `200`, body equals the version's text; the old
 *    revision is `409`.
 *
 * The row-count assertions in step 7 are the durable proof: before the restore the database holds
 * exactly 2 versions / 3 update rows / 0 operations; a successful restore adds 2 versions / 1
 * update / 1 operation; the stale attempt adds nothing.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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
import { AUTO_VERSION_MIN_INTERVAL_MS } from '../versions/auto-version.js';
import { versionText } from '../versions/restore.js';
import {
  bootstrapSessionCookie,
  startTestServer,
  syncUpdateFrame,
  syncUpdateFrameFromBytes,
  TestClient,
  type TestServer,
} from '../rooms/test-harness.js';

const OWNER = 'demo-ada';
const T0 = Date.UTC(2026, 5, 1, 8, 0, 0);

type RawDb = InstanceType<SqliteModule['DatabaseSync']>;
type FullStore = DocumentStore & DocumentVersionStore;

interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface RowCounts {
  readonly versions: number;
  readonly updates: number;
  readonly operations: number;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function fullStore(store: DocumentStore): FullStore {
  assert.ok(isDocumentVersionStore(store), 'the server store must serve versions');
  return store;
}

async function apiFetch(
  server: TestServer,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = { connection: 'close', cookie };
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

/** Poll until `predicate` holds; bounded so a bug fails rather than hanging the gate. */
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

/** Wait until the revision is `expected` and the document's FIFO slot is idle. */
async function waitForRevision(
  server: TestServer,
  documentId: string,
  expected: number,
): Promise<void> {
  await waitFor(
    async () => (await fullStore(server.store).documentContentRevision(documentId)) === expected,
    `the content revision is ${expected}`,
  );
  await waitFor(
    () => server.handle.registry.mutationQueueDepth(documentId) === 0,
    'the FIFO slot is idle',
  );
}

interface VersionRow {
  readonly id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly authorId: string;
}

async function listVersions(
  server: TestServer,
  cookie: string,
  documentId: string,
): Promise<{ versions: VersionRow[]; currentRevision: number }> {
  const response = await apiFetch(server, 'GET', `/api/documents/${documentId}/versions`, cookie);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return {
    versions: response.body['versions'] as VersionRow[],
    currentRevision: response.body['currentRevision'] as number,
  };
}

/* ------------------------------------------------------------------ *
 * The scenario
 * ------------------------------------------------------------------ */

describe('P0-1 real path: auto versions → diff → stale → restore', () => {
  it('covers create/edit/version/diff/stale/re-preview/restore in one real run', async () => {
    const clock = { now: T0 };
    /** Held only for cleanup; the test body uses the narrowed `server` const below. */
    let owned: TestServer | null = null;
    const clients: TestClient[] = [];
    const docs: Y.Doc[] = [];
    try {
      const server = await startTestServer({ authorization: 'enforced', now: () => clock.now });
      owned = server;
      const cookie = await bootstrapSessionCookie(server.httpUrl, OWNER);

      // ---- 0. a real document, created through the API --------------------------------
      const created = await apiFetch(server, 'POST', '/api/documents', cookie, {
        title: 'E2E version history',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const documentId = String(created.body['documentId']);
      assert.notEqual(documentId.length, 0);
      assert.ok(isDocumentMetaStore(server.store));

      const meta = await server.store.documentMeta(documentId);
      assert.equal(meta?.title, 'E2E version history');

      const clientA = await TestClient.connect(server.url, { cookie });
      clients.push(clientA);
      await clientA.joinAndWait(documentId);

      // ---- 1. first real edit → the first auto version --------------------------------
      const docA = new Y.Doc();
      docs.push(docA);
      docA.getText('content').insert(0, 'v1');
      clientA.sendBinary(syncUpdateFrame(docA));
      await waitForRevision(server, documentId, 1);

      // The capture runs after the broadcast in the same FIFO task; `waitForRevision` already
      // waited for the slot to drain, so the list is now settled.
      let listed = await listVersions(server, cookie, documentId);
      assert.equal(listed.currentRevision, 1);
      assert.equal(listed.versions.length, 1, 'the first body change captures one version');
      const firstVersion = listed.versions[0] as VersionRow;
      assert.equal(firstVersion.kind, 'auto');
      assert.equal(firstVersion.authorId, OWNER);
      assert.equal(firstVersion.sequence, 1);

      const firstStored = await fullStore(server.store).readDocumentVersion(
        documentId,
        firstVersion.id,
      );
      assert.notEqual(firstStored, null);
      if (firstStored === null) return;
      assert.equal(versionText(firstStored), 'v1');

      // ---- 2. ten minutes later, another edit → at least two versions -----------------
      clock.now = T0 + AUTO_VERSION_MIN_INTERVAL_MS;
      const beforeSecond = Y.encodeStateVector(docA);
      docA.getText('content').insert(docA.getText('content').length, ' v2');
      clientA.sendBinary(syncUpdateFrameFromBytes(Y.encodeStateAsUpdate(docA, beforeSecond)));
      await waitForRevision(server, documentId, 2);

      listed = await listVersions(server, cookie, documentId);
      assert.equal(listed.currentRevision, 2);
      assert.ok(
        listed.versions.length >= 2,
        `expected >= 2 versions, got ${listed.versions.length}`,
      );
      assert.equal(listed.versions.filter((version) => version.kind === 'auto').length, 2);
      assert.deepEqual(
        listed.versions.map((version) => version.sequence),
        [2, 1],
        'the list is newest-first by content revision',
      );

      // ---- 3. diff with the current baseRevision → 200 and a non-empty diff -----------
      const preview = await apiFetch(
        server,
        'GET',
        `/api/documents/${documentId}/versions/${firstVersion.id}/diff?baseRevision=2`,
        cookie,
      );
      assert.equal(preview.status, 200, JSON.stringify(preview.body));
      assert.equal(preview.body['versionId'], firstVersion.id);
      assert.equal(preview.body['baseRevision'], 2);
      assert.equal(preview.body['currentRevision'], 2);
      assert.equal(preview.body['targetText'], 'v1');
      assert.equal(preview.body['currentText'], 'v1 v2');
      assert.deepEqual(preview.body['diff'], [
        { type: 'equal', text: 'v1' },
        { type: 'delete', text: ' v2' },
      ]);
      assert.deepEqual(preview.body['stats'], { inserted: 0, deleted: 3 });
      assert.equal(JSON.stringify(preview.body).includes('yjs_state'), false);

      // ---- 4. another client edits → revision +1 -------------------------------------
      const clientB = await TestClient.connect(server.url, { cookie });
      clients.push(clientB);
      await clientB.joinAndWait(documentId);

      const docB = new Y.Doc();
      docs.push(docB);
      const storedForB = await server.store.load(documentId);
      assert.notEqual(storedForB, null);
      if (storedForB === null) return;
      applyStoredDocument(storedForB, docB);
      const beforeB = Y.encodeStateVector(docB);
      docB.getText('content').insert(docB.getText('content').length, ' v3');
      clientB.sendBinary(syncUpdateFrameFromBytes(Y.encodeStateAsUpdate(docB, beforeB)));
      await waitForRevision(server, documentId, 3);

      // No third auto version: the second was captured at the same instant as the clock change,
      // so this edit falls inside the interval.
      const afterB = await listVersions(server, cookie, documentId);
      assert.equal(afterB.currentRevision, 3);
      assert.equal(afterB.versions.length, 2, 'the third edit is inside the interval: no auto row');

      // ---- 5. the old baseRevision is stale ------------------------------------------
      const stale = await apiFetch(
        server,
        'GET',
        `/api/documents/${documentId}/versions/${firstVersion.id}/diff?baseRevision=2`,
        cookie,
      );
      assert.equal(stale.status, 409, JSON.stringify(stale.body));
      assert.deepEqual(stale.body, { error: 'stale_revision', currentRevision: 3 });
      assert.equal('targetText' in stale.body, false);

      // ---- 6. the new baseRevision previews ------------------------------------------
      const fresh = await apiFetch(
        server,
        'GET',
        `/api/documents/${documentId}/versions/${firstVersion.id}/diff?baseRevision=3`,
        cookie,
      );
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
      assert.equal(fresh.body['currentText'], 'v1 v2 v3');
      assert.equal(fresh.body['targetText'], 'v1');
      assert.deepEqual(fresh.body['stats'], { inserted: 0, deleted: 6 });

      // ---- 7. restore with the new revision, then the old one is stale ----------------
      const beforeRestore = await rowCounts(server, documentId);
      assert.deepEqual(beforeRestore, { versions: 2, updates: 3, operations: 0 });

      const restored = await apiFetch(
        server,
        'POST',
        `/api/documents/${documentId}/versions/${firstVersion.id}/restore`,
        cookie,
        { baseRevision: 3, operationId: 'op-e2e-restore-0001' },
      );
      assert.equal(restored.status, 200, JSON.stringify(restored.body));
      assert.equal(typeof restored.body['versionId'], 'string');
      assert.equal(restored.body['sequence'], 4, 'the restore advances the content revision');

      await waitFor(
        async () => (await durableText(server.store, documentId)) === 'v1',
        'the restore is durable',
      );
      const restoredText = await durableText(server.store, documentId);
      assert.equal(restoredText, 'v1', 'the body equals the version target');
      assert.equal(
        server.handle.registry.requireRoom(documentId).doc.getText('content').toString(),
        'v1',
        'the live room holds the restored body',
      );

      // A successful restore writes exactly four rows: two versions, one update, one operation.
      const afterRestore = await rowCounts(server, documentId);
      assert.deepEqual(afterRestore, {
        versions: beforeRestore.versions + 2,
        updates: beforeRestore.updates + 1,
        operations: beforeRestore.operations + 1,
      });

      const oldRevision = await apiFetch(
        server,
        'POST',
        `/api/documents/${documentId}/versions/${firstVersion.id}/restore`,
        cookie,
        { baseRevision: 2, operationId: 'op-e2e-stale-0001' },
      );
      assert.equal(oldRevision.status, 409, JSON.stringify(oldRevision.body));
      assert.deepEqual(oldRevision.body, { error: 'stale_revision', currentRevision: 4 });

      const afterStale = await rowCounts(server, documentId);
      assert.deepEqual(afterStale, afterRestore, 'a stale restore writes nothing');
      assert.equal(await durableText(server.store, documentId), 'v1');

      // The version rows the restore wrote are visible through the API: the list now has the
      // two auto versions plus `pre-restore` and `restored`.
      const finalList = await listVersions(server, cookie, documentId);
      assert.equal(finalList.currentRevision, 4);
      assert.deepEqual([...finalList.versions.map((version) => version.kind)].sort(), [
        'auto',
        'auto',
        'pre-restore',
        'restored',
      ]);
    } finally {
      for (const client of clients) client.socket.close();
      for (const doc of docs) doc.destroy();
      await owned?.close();
    }
  });
});
