/**
 * `GET /api/documents/:id/versions/:versionId/diff?baseRevision=<n>` — the HTTP half of the
 * version **diff preview** (P0-1 pre-requisite 2).
 *
 * ## What is proven here, on the real app
 *
 * | # | Claim |
 * | --- | --- |
 * | 1 | Owner, Editor and Viewer can all preview (`canRead`), and the body has exactly the frozen seven fields |
 * | 2 | no membership and an unknown document are both `404 not_found` (non-disclosure) |
 * | 3 | a version that belongs to another document is `404`, even when the caller may read that document |
 * | 4 | `baseRevision` that is not the current content revision is `409 stale_revision` + `currentRevision`, with no text |
 * | 5 | a matching `baseRevision` returns the version body, the current body and the rendered segments, including emoji handled by code point |
 * | 6 | `yjs_state` (and any other raw state) never appears in the response |
 * | 7 | the query is strict: missing, negative, fractional, exponent and repeated values are `400 invalid_request` |
 * | 8 | the route is `401` without a session and `400` only after authorization |
 *
 * Everything runs against a real server: real HTTP, the real authorization service, a real
 * `Y.Doc` room (hydrated from real SQLite) and the production `RoomRegistry` behind the version
 * service.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as Y from 'yjs';

import { isDocumentMetaStore } from '../persistence/document-meta.js';
import {
  isDocumentVersionStore,
  type DocumentVersionStore,
} from '../persistence/document-versions.js';
import { applyStoredDocument } from '../persistence/hydrator.js';
import type { DocumentStore } from '../persistence/types.js';
import {
  bootstrapSessionCookie,
  startTestServer,
  syncUpdateFrameFromBytes,
  TestClient,
  type TestServer,
} from '../rooms/test-harness.js';

/** Owner / Editor / Viewer in the demo fixture respectively. */
const OWNER = 'demo-ada';
const EDITOR = 'demo-grace';
const VIEWER = 'demo-linus';
const DOC = 'demo-document';
const PRIVATE_DOC = 'demo-private-notes';
const UNKNOWN_DOC = 'document-that-does-not-exist';

const T0 = Date.UTC(2026, 4, 2, 9, 0, 0);

const FAMILY = '👩‍👩‍👧';
const TARGET_TEXT = `Hello ${FAMILY} world`;
const CURRENT_TEXT = 'Hello 🌍 world';

const RESPONSE_KEYS = [
  'baseRevision',
  'currentRevision',
  'currentText',
  'diff',
  'stats',
  'targetText',
  'versionId',
] as const;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

type FullStore = DocumentStore & DocumentVersionStore;

function fullStore(store: DocumentStore): FullStore {
  assert.ok(isDocumentVersionStore(store), 'the harness store must serve versions');
  return store;
}

/**
 * Seed one `manual` version of `targetText`, then move the live body to `currentText`.
 *
 * Written through the store before the room is hydrated, exactly as an earlier session would
 * have left it.
 */
async function seedVersion(
  store: DocumentStore,
  documentId: string,
  targetText: string,
  currentText: string,
): Promise<{ versionId: string; baseRevision: number }> {
  const full = fullStore(store);
  assert.ok(isDocumentMetaStore(store), 'the store must own document metadata');
  await store.ensureDocumentMeta(documentId, OWNER);

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
      now: T0,
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

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function apiFetch(
  server: TestServer,
  path: string,
  cookie: string | undefined,
): Promise<ApiResponse> {
  const headers: Record<string, string> = { connection: 'close' };
  if (cookie !== undefined) headers['cookie'] = cookie;
  const response = await fetch(`${server.httpUrl}${path}`, {
    headers,
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

function diffPath(documentId: string, versionId: string, baseRevision: unknown): string {
  return `/api/documents/${documentId}/versions/${versionId}/diff?baseRevision=${String(baseRevision)}`;
}

async function session(server: TestServer, userId: string): Promise<string> {
  return await bootstrapSessionCookie(server.httpUrl, userId);
}

async function currentRevision(server: TestServer, cookie: string): Promise<number> {
  const response = await apiFetch(server, `/api/documents/${DOC}/versions`, cookie);
  assert.equal(response.status, 200);
  const value = response.body['currentRevision'];
  assert.equal(typeof value, 'number');
  return value as number;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('GET …/versions/:versionId/diff — permissions and shape', () => {
  it('lets Owner, Editor and Viewer preview, returning exactly the frozen fields', async () => {
    let server: TestServer | null = null;
    try {
      server = await startTestServer({ authorization: 'enforced' });
      const { versionId, baseRevision } = await seedVersion(
        server.store,
        DOC,
        TARGET_TEXT,
        CURRENT_TEXT,
      );

      for (const userId of [OWNER, EDITOR, VIEWER]) {
        const cookie = await session(server, userId);
        const response = await apiFetch(server, diffPath(DOC, versionId, baseRevision), cookie);
        assert.equal(
          response.status,
          200,
          `${userId} must be able to preview: ${JSON.stringify(response.body)}`,
        );

        assert.deepEqual(Object.keys(response.body).sort(), [...RESPONSE_KEYS].sort());
        assert.equal(response.body['versionId'], versionId);
        assert.equal(response.body['baseRevision'], baseRevision);
        assert.equal(response.body['currentRevision'], baseRevision);
        assert.equal(response.body['targetText'], TARGET_TEXT);
        assert.equal(response.body['currentText'], CURRENT_TEXT);
        // The diff is computed from `currentText` to `targetText`: the live globe is deleted and
        // the version's family emoji is inserted.
        assert.deepEqual(response.body['diff'], [
          { type: 'equal', text: 'Hello ' },
          { type: 'delete', text: '🌍' },
          { type: 'insert', text: FAMILY },
          { type: 'equal', text: ' world' },
        ]);
        assert.deepEqual(response.body['stats'], { inserted: 5, deleted: 1 });

        // Claim 6: no encoded state and no author/actor data — text and counts only.
        const serialized = JSON.stringify(response.body);
        assert.equal(serialized.includes('yjs_state'), false);
        assert.equal(serialized.includes('"state"'), false);
        assert.equal(serialized.includes('"authorId"'), false);
      }
    } finally {
      await server?.close();
    }
  });

  it('answers 404 for no membership and for an unknown document', async () => {
    let server: TestServer | null = null;
    try {
      server = await startTestServer({ authorization: 'enforced' });
      const seeded = await seedVersion(server.store, DOC, TARGET_TEXT, CURRENT_TEXT);

      // demo-linus has no membership on demo-private-notes; the version id is real, which makes
      // the non-disclosure property meaningful.
      const outsider = await session(server, VIEWER);
      const noMembership = await apiFetch(
        server,
        diffPath(PRIVATE_DOC, seeded.versionId, 0),
        outsider,
      );
      assert.equal(noMembership.status, 404);
      assert.deepEqual(noMembership.body, { error: 'not_found' });

      const owner = await session(server, OWNER);
      const unknown = await apiFetch(
        server,
        diffPath(UNKNOWN_DOC, seeded.versionId, seeded.baseRevision),
        owner,
      );
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.body, { error: 'not_found' });
    } finally {
      await server?.close();
    }
  });

  it('answers 404 for a version that belongs to another document', async () => {
    let server: TestServer | null = null;
    try {
      server = await startTestServer({ authorization: 'enforced' });
      const seeded = await seedVersion(server.store, DOC, TARGET_TEXT, CURRENT_TEXT);
      const cookie = await session(server, OWNER);

      // `demo-private-notes` is readable by the owner but has its own content revision (0).
      const response = await apiFetch(server, diffPath(PRIVATE_DOC, seeded.versionId, 0), cookie);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: 'not_found' });

      // An id that exists nowhere is the same answer.
      const missing = await apiFetch(
        server,
        diffPath(DOC, 'version-that-does-not-exist', seeded.baseRevision),
        cookie,
      );
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.body, { error: 'not_found' });
    } finally {
      await server?.close();
    }
  });
});

describe('GET …/versions/:versionId/diff — baseRevision', () => {
  it('answers 409 stale_revision with the currentRevision and no text', async () => {
    let server: TestServer | null = null;
    try {
      server = await startTestServer({ authorization: 'enforced' });
      const seeded = await seedVersion(server.store, DOC, TARGET_TEXT, CURRENT_TEXT);
      const cookie = await session(server, OWNER);
      const current = await currentRevision(server, cookie);
      assert.equal(current, seeded.baseRevision);

      const stale = await apiFetch(
        server,
        diffPath(DOC, seeded.versionId, seeded.baseRevision - 1),
        cookie,
      );
      assert.equal(stale.status, 409);
      assert.deepEqual(stale.body, { error: 'stale_revision', currentRevision: current });
      assert.equal('targetText' in stale.body, false);
      assert.equal('currentText' in stale.body, false);
      assert.equal('diff' in stale.body, false);
      assert.equal('stats' in stale.body, false);

      // A revision ahead of the server is stale too (the client cannot preview the future).
      const ahead = await apiFetch(
        server,
        diffPath(DOC, seeded.versionId, seeded.baseRevision + 1),
        cookie,
      );
      assert.equal(ahead.status, 409);
      assert.deepEqual(ahead.body, { error: 'stale_revision', currentRevision: current });
    } finally {
      await server?.close();
    }
  });

  it('returns an empty diff when the version body already is the current body', async () => {
    let server: TestServer | null = null;
    try {
      server = await startTestServer({ authorization: 'enforced' });
      const seeded = await seedVersion(server.store, DOC, 'same body', 'same body');
      const cookie = await session(server, OWNER);
      const response = await apiFetch(
        server,
        diffPath(DOC, seeded.versionId, seeded.baseRevision),
        cookie,
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body['diff'], [{ type: 'equal', text: 'same body' }]);
      assert.deepEqual(response.body['stats'], { inserted: 0, deleted: 0 });
    } finally {
      await server?.close();
    }
  });

  it('runs the revision check against the live content revision after a real edit', async () => {
    // A real socket edit advances the content revision, so the revision the client previewed
    // before it is immediately stale — the endpoint is not reading a cached or log-position
    // number.
    let server: TestServer | null = null;
    try {
      server = await startTestServer({ authorization: 'enforced' });
      const seeded = await seedVersion(server.store, DOC, 'v1', 'v2');
      const cookie = await session(server, OWNER);

      const beforeEdit = await apiFetch(
        server,
        diffPath(DOC, seeded.versionId, seeded.baseRevision),
        cookie,
      );
      assert.equal(beforeEdit.status, 200);

      const client = await TestClient.connect(server.url, { cookie });
      try {
        await client.joinAndWait(DOC);
        const doc = new Y.Doc();
        try {
          const stored = await server.store.load(DOC);
          assert.notEqual(stored, null);
          if (stored === null) return;
          applyStoredDocument(stored, doc);
          const stateVector = Y.encodeStateVector(doc);
          doc.getText('content').insert(doc.getText('content').length, '!');
          client.sendBinary(syncUpdateFrameFromBytes(Y.encodeStateAsUpdate(doc, stateVector)));
          // The append is the moment the revision advances; poll the store, not a timer.
          const deadline = Date.now() + 8_000;
          for (;;) {
            const revision = await fullStore(server.store).documentContentRevision(DOC);
            if (revision === seeded.baseRevision + 1) break;
            if (Date.now() > deadline) assert.fail('the edit did not advance the content revision');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } finally {
          doc.destroy();
        }

        const afterEdit = await apiFetch(
          server,
          diffPath(DOC, seeded.versionId, seeded.baseRevision),
          cookie,
        );
        assert.equal(afterEdit.status, 409);
        assert.deepEqual(afterEdit.body, {
          error: 'stale_revision',
          currentRevision: seeded.baseRevision + 1,
        });

        const fresh = await apiFetch(
          server,
          diffPath(DOC, seeded.versionId, seeded.baseRevision + 1),
          cookie,
        );
        assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
        assert.equal(fresh.body['currentText'], 'v2!');
        assert.equal(fresh.body['targetText'], 'v1');
      } finally {
        client.socket.close();
      }
    } finally {
      await server?.close();
    }
  });
});

describe('GET …/versions/:versionId/diff — request validation', () => {
  it('refuses a session-less caller with 401', async () => {
    let server: TestServer | null = null;
    try {
      server = await startTestServer({ authorization: 'enforced' });
      const seeded = await seedVersion(server.store, DOC, TARGET_TEXT, CURRENT_TEXT);
      const response = await apiFetch(
        server,
        diffPath(DOC, seeded.versionId, seeded.baseRevision),
        undefined,
      );
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: 'session_required' });
    } finally {
      await server?.close();
    }
  });

  it('refuses a missing, negative, fractional, exponent or repeated baseRevision with 400', async () => {
    let server: TestServer | null = null;
    try {
      server = await startTestServer({ authorization: 'enforced' });
      const seeded = await seedVersion(server.store, DOC, TARGET_TEXT, CURRENT_TEXT);
      const cookie = await session(server, OWNER);
      const base = `/api/documents/${DOC}/versions/${seeded.versionId}/diff`;

      const invalid = [
        '',
        '?baseRevision=',
        '?baseRevision=-1',
        '?baseRevision=1.5',
        '?baseRevision=1e3',
        '?baseRevision=+2',
        '?baseRevision=%202',
        '?baseRevision=2&baseRevision=3',
        '?other=2',
      ];
      for (const query of invalid) {
        const response = await apiFetch(server, `${base}${query}`, cookie);
        assert.equal(response.status, 400, `query ${query} must be 400, got ${response.status}`);
        assert.deepEqual(response.body, { error: 'invalid_request' });
      }
    } finally {
      await server?.close();
    }
  });

  it('authorizes before it validates the query', async () => {
    // No membership + malformed query: the answer must be the non-disclosure 404, not 400.
    let server: TestServer | null = null;
    try {
      server = await startTestServer({ authorization: 'enforced' });
      const seeded = await seedVersion(server.store, DOC, TARGET_TEXT, CURRENT_TEXT);
      const outsider = await session(server, VIEWER);
      const response = await apiFetch(
        server,
        `/api/documents/${PRIVATE_DOC}/versions/${seeded.versionId}/diff?baseRevision=nope`,
        outsider,
      );
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: 'not_found' });
    } finally {
      await server?.close();
    }
  });
});
