/**
 * A5 P0-1 audit — **permission and state consistency** around server-side version restore.
 *
 * These are the cases the P0-1 integration suite (`restore.integration.test.ts`) does not pin:
 * not "does restore work", but "does authorization still decide it" when
 *
 * - the caller's membership changes **between** a successful restore and its idempotent retry
 *   (D-V1; non-disclosure; the op-id lookup must never be reachable before authorization);
 * - the same `operationId` is replayed with a **different request** (C3) — including a different
 *   selected version — and the refusal must disclose no `versionId`/`sequence`;
 * - the body is *nearly* valid (over-long/blank `operationId`, unsafe/typed `baseRevision`,
 *   extra fields, wrong top-level shape), and an invalid request must write 0 rows;
 * - the version list is read as a **viewer** and must carry metadata only: no `yjs_state`,
 *   no document text, and a `currentRevision` that is just the content revision.
 *
 * Every test boots the real app (`startTestServer`), a real SQLite database, the real
 * `AuthzService` on the HTTP layer, and the real cookie/session flow. Membership changes are
 * made directly in `authz_document_membership` — the same table the decision core reads — and
 * each test re-reads the role through `server.authz.roleFor` so "the server saw the change" is
 * asserted rather than assumed.
 *
 * Test map (A5 audit points):
 *
 * | # | Audit point |
 * | --- | --- |
 * | 1 | D-V1 retry after membership **removal**: 404, no result disclosure, 0 rows |
 * | 2 | D-V1 retry after **downgrade** to viewer: 403, list still readable (`canRead`), 0 rows |
 * | 3 | A refused (stale) attempt's `operationId` is not recorded; after downgrade the retry is 403 |
 * | 4 | Same op id + different `versionId` → 409 `operation_conflict`, no leak, 0 rows |
 * | 5 | Strict body (extended) + order identity → authz → body: 401/404/403 before 400, 0 rows |
 * | 6 | List shape: metadata only, no `yjs_state`/text, `currentRevision` = content revision |
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
import {
  bootstrapSessionCookie,
  startTestServer,
  type TestServer,
} from '../rooms/test-harness.js';

/** Owner of `demo-document` in the demo fixture (`demo-ada`); viewer is `demo-linus`. */
const DOC = 'demo-document';
/** The demo document `demo-linus` has no membership on (non-disclosure case). */
const PRIVATE_DOC = 'demo-private-notes';

type RawDb = InstanceType<SqliteModule['DatabaseSync']>;
type MembershipRole = 'viewer' | 'commenter' | 'editor' | 'owner';
type FullStore = DocumentStore & DocumentVersionStore;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function fullStore(store: DocumentStore): FullStore {
  assert.ok(isDocumentVersionStore(store), 'the server store must serve versions');
  return store;
}

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

  // One Yjs client chain: the later body is a *relative* update from the document that holds the
  // target text, exactly as a real editor would produce it.
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

/** The text rebuilt from the store alone — i.e. what a restart would serve. */
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
 * The write is a separate connection from the authz read connection on purpose: the tests must
 * prove the *running* server sees the change, not that a fixture was re-seeded.
 */
async function setMembershipRole(
  server: TestServer,
  documentId: string,
  userId: string,
  role: MembershipRole | null,
): Promise<void> {
  assert.notEqual(server.dataPath, undefined, 'this suite needs the harness-owned database');
  await withRawDb(server.dataPath as string, (db) => {
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

function versionsPath(documentId: string): string {
  return `/api/documents/${documentId}/versions`;
}

function restoreBody(baseRevision: number, operationId: string): Record<string, unknown> {
  return { baseRevision, operationId };
}

async function session(server: TestServer, userId: string): Promise<string> {
  return await bootstrapSessionCookie(server.httpUrl, userId);
}

/** The exact frozen refusal shapes this suite is allowed to observe. */
function expectRefusal(
  response: ApiResponse,
  status: number,
  error: string,
  context: string,
): void {
  assert.equal(response.status, status, `${context}: ${response.text}`);
  assert.deepEqual(response.body, { error }, context);
  assert.deepEqual(Object.keys(response.body), ['error'], `${context}: no extra body fields`);
  // C1/C4: a refusal never discloses the restored version id or its sequence.
  assert.equal(response.text.includes('versionId'), false, `${context}: no versionId`);
  assert.equal(response.text.includes('sequence'), false, `${context}: no sequence`);
}

/* ------------------------------------------------------------------ *
 * 1. Membership removal between a restore and its retry
 * ------------------------------------------------------------------ */

describe('A5/P0-1 — retry after the Owner loses membership (D-V1, C3)', () => {
  it('answers 404 not_found, adds 0 rows and never replays the original result', async () => {
    const server = await startTestServer({ authorization: 'enforced' });
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const cookie = await session(server, 'demo-ada');
      const operationId = 'op-a5-revoked-0001';
      const body = restoreBody(seeded.baseRevision, operationId);

      const first = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        body,
      );
      assert.equal(first.status, 200, first.text);
      const versionId = String(first.body['versionId']);
      const sequence = Number(first.body['sequence']);
      assert.match(versionId, /^[0-9a-f-]{36}$/);
      assert.equal(sequence, 3);
      const afterSuccess = await rowCounts(server, DOC);
      assert.deepEqual(afterSuccess, { versions: 3, updates: 3, operations: 1 });

      // Control: while the caller is still the Owner, the retry *is* an idempotent replay.
      // The next assertion group is therefore about authorization, not about the retry shape.
      const replay = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        body,
      );
      assert.equal(replay.status, 200, replay.text);
      assert.deepEqual(replay.body, { versionId, sequence });

      // Revoke: the identity (session cookie) survives, the document membership does not.
      await setMembershipRole(server, DOC, 'demo-ada', null);
      assert.equal(server.authz.roleFor(DOC, 'demo-ada'), null, 'the server must see the revoke');

      const retry = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        body,
      );
      expectRefusal(retry, 404, 'not_found', 'revoked Owner retrying the same operation id');
      assert.equal(retry.text.includes(versionId), false, 'the original version id must not leak');
      assert.deepEqual(await rowCounts(server, DOC), afterSuccess, 'a refused retry writes 0 rows');

      // The list is gated by `canRead` too: no membership is the same non-disclosure 404.
      const list = await apiFetch(server, 'GET', versionsPath(DOC), cookie);
      expectRefusal(list, 404, 'not_found', 'revoked member listing versions');

      // The document itself is unchanged by the refused retry; the first restore is durable.
      assert.equal(await durableText(server.store, DOC), 'target');
      const versions = await fullStore(server.store).listDocumentVersions(DOC);
      assert.equal(versions.length, afterSuccess.versions);
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. Downgrade Owner → viewer
 * ------------------------------------------------------------------ */

describe('A5/P0-1 — retry after the Owner is downgraded to viewer (D-V1)', () => {
  it('answers 403 forbidden for restore, keeps the list readable via canRead, writes 0 rows', async () => {
    const server = await startTestServer({ authorization: 'enforced' });
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const cookie = await session(server, 'demo-ada');
      const operationId = 'op-a5-downgrade-0001';
      const body = restoreBody(seeded.baseRevision, operationId);

      const first = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        body,
      );
      assert.equal(first.status, 200, first.text);
      const afterSuccess = await rowCounts(server, DOC);

      await setMembershipRole(server, DOC, 'demo-ada', 'viewer');
      assert.equal(server.authz.roleFor(DOC, 'demo-ada'), 'viewer');

      const retry = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        body,
      );
      expectRefusal(retry, 403, 'forbidden', 'downgraded viewer retrying the same operation id');
      assert.deepEqual(await rowCounts(server, DOC), afterSuccess, 'a refused retry writes 0 rows');
      assert.equal(await durableText(server.store, DOC), 'target');

      // The same caller is still a reader, so the version list must keep working (`canRead`).
      // A restore-only endpoint would wrongly refuse this; the list endpoint must not.
      const list = await apiFetch(server, 'GET', versionsPath(DOC), cookie);
      assert.equal(list.status, 200, list.text);
      const versions = list.body['versions'] as { id: string; sequence: number; kind: string }[];
      assert.equal(versions.length, afterSuccess.versions);
      assert.deepEqual(
        versions.map((version) => version.kind),
        ['restored', 'pre-restore', 'manual'],
      );
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. A refused attempt leaves no operation row to hit later
 * ------------------------------------------------------------------ */

describe('A5/P0-1 — a refused attempt does not record the operation id', () => {
  it('stale_revision leaves 0 operation rows; the same id is refused after a downgrade', async () => {
    const server = await startTestServer({ authorization: 'enforced' });
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const cookie = await session(server, 'demo-ada');
      const operationId = 'op-a5-stale-0001';
      const staleBody = restoreBody(seeded.baseRevision + 7, operationId);

      const before = await rowCounts(server, DOC);
      const stale = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        staleBody,
      );
      assert.equal(stale.status, 409, stale.text);
      assert.deepEqual(stale.body, {
        error: 'stale_revision',
        currentRevision: seeded.baseRevision,
      });
      assert.deepEqual(await rowCounts(server, DOC), before, 'a stale restore writes 0 rows');
      assert.equal(before.operations, 0, 'the failed attempt must not occupy the operation id');

      await setMembershipRole(server, DOC, 'demo-ada', 'viewer');
      const retry = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        staleBody,
      );
      expectRefusal(retry, 403, 'forbidden', 'downgraded caller retrying a stale operation id');
      assert.deepEqual(await rowCounts(server, DOC), before);
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. One operation id, a different selected version
 * ------------------------------------------------------------------ */

describe('A5/P0-1 — the same operationId with a different request is a conflict (C3)', () => {
  it('refuses a different versionId with 409 operation_conflict and discloses nothing', async () => {
    const server = await startTestServer({ authorization: 'enforced' });
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const full = fullStore(server.store);

      // A second, genuinely distinct version of the same document (the later body).
      const stored = await server.store.load(DOC);
      assert.notEqual(stored, null);
      if (stored === null) return;
      const live = new Y.Doc();
      let secondVersionId = '';
      try {
        applyStoredDocument(stored, live);
        const second = await full.captureDocumentVersion({
          documentId: DOC,
          title: 'later',
          authorId: 'demo-ada',
          state: Y.encodeStateAsUpdate(live),
          kind: 'manual',
        });
        secondVersionId = second.id;
      } finally {
        live.destroy();
      }
      assert.notEqual(secondVersionId, '');
      assert.notEqual(secondVersionId, seeded.versionId);

      const cookie = await session(server, 'demo-ada');
      const operationId = 'op-a5-conflict-0001';
      const first = await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        cookie,
        restoreBody(seeded.baseRevision, operationId),
      );
      assert.equal(first.status, 200, first.text);
      const firstVersionId = String(first.body['versionId']);
      const afterFirst = await rowCounts(server, DOC);
      assert.equal(afterFirst.operations, 1);

      // Same idempotency key, different **request** (another selected version). The op-id lookup
      // runs before the revision compare, so this must be `operation_conflict` — never a replay
      // of the first result and never a silent restore of the second version.
      const conflict = await apiFetch(
        server,
        'POST',
        restorePath(DOC, secondVersionId),
        cookie,
        restoreBody(seeded.baseRevision + 1, operationId),
      );
      expectRefusal(conflict, 409, 'operation_conflict', 'same operation id, different version');
      assert.equal(conflict.text.includes(firstVersionId), false, 'no original version id');
      assert.deepEqual(await rowCounts(server, DOC), afterFirst, 'a conflict writes 0 rows');
      assert.equal(await durableText(server.store, DOC), 'target', 'the second version was not applied');

      // Control: the same version with a fresh operation id is accepted, so the refusal above
      // came from the idempotency key and not from an invalid version.
      const fresh = await apiFetch(
        server,
        'POST',
        restorePath(DOC, secondVersionId),
        cookie,
        restoreBody(seeded.baseRevision + 1, 'op-a5-conflict-0002'),
      );
      assert.equal(fresh.status, 200, fresh.text);
      assert.equal(await durableText(server.store, DOC), 'base-later');
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. Body strictness, and the identity → authz → body order
 * ------------------------------------------------------------------ */

describe('A5/P0-1 — strict restore body, and identity/authz are decided before the body', () => {
  it('orders 401/404/403 before 400, and refuses every near-valid body with 0 rows', async () => {
    const server = await startTestServer({ authorization: 'enforced' });
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const ownerCookie = await session(server, 'demo-ada');
      const viewerCookie = await session(server, 'demo-linus');
      const before = await rowCounts(server, DOC);
      const path = restorePath(DOC, seeded.versionId);

      // The same malformed body, three identities/roles: the refusal is decided before parsing.
      const malformed = { baseRevision: 'not-a-number', operationId: 'op-a5-order-0001' };
      const anonymous = await apiFetch(server, 'POST', path, undefined, malformed);
      expectRefusal(anonymous, 401, 'session_required', 'malformed body without a session');
      const noMembership = await apiFetch(
        server,
        'POST',
        restorePath(PRIVATE_DOC, seeded.versionId),
        viewerCookie,
        malformed,
      );
      expectRefusal(noMembership, 404, 'not_found', 'malformed body without membership');
      const viewer = await apiFetch(server, 'POST', path, viewerCookie, malformed);
      expectRefusal(viewer, 403, 'forbidden', 'malformed body from a viewer');

      // Every near-valid body is `400 invalid_request`, from the Owner, with 0 rows written.
      const longOperationId = `op-a5-${'x'.repeat(125)}`; // 131 characters
      assert.equal(longOperationId.length, 131);
      const badBodies: { label: string; body: unknown }[] = [
        {
          label: 'operationId longer than 128',
          body: restoreBody(seeded.baseRevision, longOperationId),
        },
        {
          label: 'operationId of 8 spaces',
          body: restoreBody(seeded.baseRevision, '        '),
        },
        {
          label: 'baseRevision above Number.MAX_SAFE_INTEGER',
          body: restoreBody(Number.MAX_SAFE_INTEGER + 1, 'op-a5-unsafe-0001'),
        },
        {
          label: 'boolean baseRevision',
          body: { baseRevision: true, operationId: 'op-a5-bool-000001' },
        },
        {
          label: 'null baseRevision',
          body: { baseRevision: null, operationId: 'op-a5-null-000001' },
        },
        {
          label: 'unknown documentId field',
          body: {
            baseRevision: seeded.baseRevision,
            operationId: 'op-a5-extra-0001',
            documentId: DOC,
          },
        },
        {
          label: 'unknown versionId field',
          body: {
            baseRevision: seeded.baseRevision,
            operationId: 'op-a5-extra-0002',
            versionId: seeded.versionId,
          },
        },
        {
          label: 'array body',
          body: [seeded.baseRevision, 'op-a5-array-0001'],
        },
      ];

      for (const { label, body } of badBodies) {
        const response = await apiFetch(server, 'POST', path, ownerCookie, body);
        assert.equal(response.status, 400, `${label}: ${response.text}`);
        assert.deepEqual(response.body, { error: 'invalid_request' }, label);
      }
      assert.deepEqual(await rowCounts(server, DOC), before, 'no invalid body wrote a row');
      assert.equal(await durableText(server.store, DOC), 'base-later');
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. The version list as a viewer
 * ------------------------------------------------------------------ */

describe('A5/P0-1 — the version list exposes metadata only (no yjs_state, no body)', () => {
  it('returns the same metadata to Owner and viewer, with currentRevision = content revision', async () => {
    const server = await startTestServer({ authorization: 'enforced' });
    try {
      const seeded = await seedRestorable(server.store, DOC, 'target', 'base-later');
      const ownerCookie = await session(server, 'demo-ada');
      await apiFetch(
        server,
        'POST',
        restorePath(DOC, seeded.versionId),
        ownerCookie,
        restoreBody(seeded.baseRevision, 'op-a5-list-0001'),
      );

      const revision = await fullStore(server.store).documentContentRevision(DOC);
      assert.equal(revision, 3);

      for (const cookie of [ownerCookie, await session(server, 'demo-linus')]) {
        const list = await apiFetch(server, 'GET', versionsPath(DOC), cookie);
        assert.equal(list.status, 200, list.text);
        assert.deepEqual(Object.keys(list.body).sort(), ['currentRevision', 'versions']);
        assert.equal(list.body['currentRevision'], revision);

        const versions = list.body['versions'] as Record<string, unknown>[];
        assert.equal(versions.length, 3);
        assert.equal(versions[0]?.['sequence'], revision);
        for (const version of versions) {
          assert.deepEqual(
            Object.keys(version).sort(),
            ['authorId', 'createdAt', 'id', 'kind', 'sequence', 'title'],
            'a version summary is exactly the frozen six fields',
          );
          assert.equal(Object.hasOwn(version, 'state'), false);
          assert.equal(Object.hasOwn(version, 'yjsState'), false);
          assert.equal(Object.hasOwn(version, 'yjs_state'), false);
        }

        // No encoded state, in either encoding a client could receive, and no document text.
        const text = list.text;
        assert.equal(text.includes('yjs_state'), false);
        assert.equal(text.includes('"state"'), false);
        assert.equal(text.includes('base-later'), false, 'the current body must not leak');
        assert.equal(text.includes('target'), false, 'the restored body must not leak');
        await assertNoStateBlobInResponse(server, DOC, text);
      }
    } finally {
      await server.close();
    }
  });
});

/** Assert every stored `yjs_state` BLOB of the document is absent from the response text. */
async function assertNoStateBlobInResponse(
  server: TestServer,
  documentId: string,
  text: string,
): Promise<void> {
  assert.notEqual(server.dataPath, undefined);
  await withRawDb(server.dataPath as string, (db) => {
    const rows = db
      .prepare('SELECT id, yjs_state FROM document_version WHERE document_id = ?')
      .all(documentId);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      const state = row['yjs_state'];
      assert.ok(state instanceof Uint8Array, 'stored state must be a BLOB');
      assert.equal(text.includes(Buffer.from(state).toString('hex')), false, 'no hex yjs_state');
      assert.equal(
        text.includes(Buffer.from(state).toString('base64')),
        false,
        'no base64 yjs_state',
      );
    }
  });
}
