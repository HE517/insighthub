/**
 * M4 B12.5 — `POST /api/documents` and the atomic three-row creation (D-084 method C).
 *
 * Layer: **Node only**, real HTTP server, real SQLite files, real `authz` and real identity
 * resolver. The claims:
 *
 * - authentication is resolved from the session; no session → `401 session_required`;
 * - the body is strict (only an optional `title`, trimmed 1..200) and rejection creates nothing;
 * - the id is a server-generated UUID and the owner is the resolved internal user;
 * - document + metadata + owner membership commit together; a real membership-insert failure
 *   rolls all three back and `GET /api/documents` never shows the half-created document;
 * - two concurrent POSTs create two distinct documents, each with its own owner row;
 * - another user still gets the non-disclosure `404`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createFakeSessionVerifier, type VerifiedIdentity } from './session-verifier.js';
import { comparableHeaders } from './test-support.js';
import { bootstrapSessionCookie, startTestServer, type TestServer } from '../rooms/test-harness.js';
import { isDocumentCreationStore } from '../persistence/document-creation.js';
import { isDocumentMetaStore } from '../persistence/document-meta.js';
import { DATABASE_FILE_NAME } from '../persistence/sqlite-store.js';
import { loadSqliteModule, type SqliteModule } from '../persistence/sqlite-runtime.js';

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) await server.close();
  }
});

async function newServer(): Promise<TestServer> {
  const server = await startTestServer({ authorization: 'enforced' });
  servers.push(server);
  return server;
}

function dataPathOf(server: TestServer): string {
  assert.ok(server.dataPath !== undefined, 'the harness owns a real data directory');
  return server.dataPath;
}

async function postDocument(
  server: TestServer,
  cookie: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers['cookie'] = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${server.httpUrl}/api/documents`, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
}

async function postRaw(server: TestServer, cookie: string | null, body: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== null) headers['cookie'] = cookie;
  return fetch(`${server.httpUrl}/api/documents`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(5_000),
  });
}

interface Counts {
  readonly document: number;
  readonly meta: number;
  readonly membership: number;
}

async function counts(server: TestServer): Promise<Counts> {
  const sqlite = await loadSqliteModule();
  const db = new sqlite.DatabaseSync(join(dataPathOf(server), DATABASE_FILE_NAME));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM document) AS document,
           (SELECT COUNT(*) FROM document_meta) AS meta,
           (SELECT COUNT(*) FROM authz_document_membership) AS membership`,
      )
      .get();
    return {
      document: Number(row?.['document'] ?? 0),
      meta: Number(row?.['meta'] ?? 0),
      membership: Number(row?.['membership'] ?? 0),
    };
  } finally {
    db.close();
  }
}

/**
 * Make the **real** third insert fail, through SQLite itself.
 *
 * This is a failure-injection seam that adds nothing to production code: a temporary trigger
 * aborts the membership insert, which is exactly the "third step fails" scenario D-084 #4 is
 * about. The document and metadata inserts that already ran must be rolled back by the store's
 * `BEGIN IMMEDIATE … COMMIT` primitive.
 */
async function installMembershipFailureTrigger(server: TestServer): Promise<void> {
  const sqlite: SqliteModule = await loadSqliteModule();
  const db = new sqlite.DatabaseSync(join(dataPathOf(server), DATABASE_FILE_NAME));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      CREATE TRIGGER inject_membership_failure
      BEFORE INSERT ON authz_document_membership
      BEGIN
        SELECT RAISE(ABORT, 'injected membership insert failure');
      END
    `);
  } finally {
    db.close();
  }
}

async function dropMembershipFailureTrigger(server: TestServer): Promise<void> {
  const sqlite = await loadSqliteModule();
  const db = new sqlite.DatabaseSync(join(dataPathOf(server), DATABASE_FILE_NAME));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('DROP TRIGGER inject_membership_failure');
  } finally {
    db.close();
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

describe('POST /api/documents — authenticated atomic creation', () => {
  it('creates document + metadata + owner membership, and the API immediately sees it', async () => {
    const server = await newServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');
    const before = await counts(server);

    const response = await postDocument(server, cookie, { title: '  My first document  ' });
    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;

    // Exactly two fields: no owner, revision, timestamp or capability leaks back.
    assert.deepEqual(Object.keys(body).sort(), ['documentId', 'title']);
    assert.equal(body['title'], 'My first document', 'title is trimmed');
    const documentId = body['documentId'];
    assert.equal(typeof documentId, 'string');
    assert.ok(isUuid(documentId as string), 'the id is a server-generated UUID');
    assert.notEqual(documentId, 'demo-document');

    const after = await counts(server);
    assert.equal(after.document, before.document + 1, 'one document row');
    assert.equal(after.meta, before.meta + 1, 'one metadata row');
    assert.equal(after.membership, before.membership + 1, 'one owner membership row');

    assert.equal(server.authz.roleFor(documentId as string, 'demo-ada'), 'owner');

    const list = await fetch(`${server.httpUrl}/api/documents`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as { documents: Array<Record<string, unknown>> };
    const listed = listBody.documents.find((document) => document['id'] === documentId);
    assert.ok(listed, 'GET /api/documents immediately includes the new document');
    assert.equal(listed['title'], 'My first document');
    assert.equal(listed['ownerId'], 'demo-ada');
    assert.equal(listed['revision'], 0);

    const read = await fetch(`${server.httpUrl}/api/documents/${String(documentId)}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(read.status, 200);
  });

  it('defaults the title and accepts exactly the 200-character maximum', async () => {
    const server = await newServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');

    const defaulted = await postDocument(server, cookie);
    assert.equal(defaulted.status, 201);
    assert.equal(
      ((await defaulted.json()) as Record<string, unknown>)['title'],
      'Untitled document',
    );

    const maxTitle = 'x'.repeat(200);
    const maxed = await postDocument(server, cookie, { title: maxTitle });
    assert.equal(maxed.status, 201);
    const maxedBody = (await maxed.json()) as Record<string, unknown>;
    assert.equal(maxedBody['title'], maxTitle);
    assert.equal((maxedBody['title'] as string).length, 200);
  });

  it('answers 401 session_required without a session and creates nothing', async () => {
    const server = await newServer();
    const before = await counts(server);

    const response = await postDocument(server, null, { title: 'Anonymous document' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'session_required' });
    assert.deepEqual(await counts(server), before, 'an unauthenticated request creates no rows');
  });

  it('keeps the existing Origin guard: a foreign state-changing request is 403 origin_not_allowed', async () => {
    const server = await newServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');
    const before = await counts(server);

    const response = await fetch(`${server.httpUrl}/api/documents`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: 'http://evil.example',
      },
      body: JSON.stringify({ title: 'Cross-origin document' }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'origin_not_allowed' });
    assert.deepEqual(await counts(server), before, 'the refused request never reaches creation');
  });

  it('rejects every strict-body violation with 400 invalid_request and creates nothing', async () => {
    const server = await newServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');
    const before = await counts(server);

    const invalidBodies: unknown[] = [
      { ownerId: 'demo-grace' },
      { ownerUserId: 'demo-grace' },
      { role: 'owner' },
      { documentId: randomUUID() },
      { title: 42 },
      { title: null },
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(201) },
      { title: 'valid', extra: true },
      [],
      'a string body',
    ];

    for (const body of invalidBodies) {
      const response = await postDocument(server, cookie, body);
      assert.equal(response.status, 400, `body ${JSON.stringify(body)}`);
      assert.deepEqual(await response.json(), { error: 'invalid_request' });
    }

    const malformed = await postRaw(server, cookie, '{ not json');
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'invalid_request' });

    assert.deepEqual(await counts(server), before, 'no rejected request created any row');
  });

  it('creates two distinct documents for two concurrent POSTs by the same user', async () => {
    const server = await newServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');
    const before = await counts(server);

    const responses = await Promise.all([
      postDocument(server, cookie, { title: 'Concurrent A' }),
      postDocument(server, cookie, { title: 'Concurrent B' }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [201, 201],
    );

    const ids = await Promise.all(
      responses.map(async (response) => {
        const body = (await response.json()) as Record<string, unknown>;
        return body['documentId'] as string;
      }),
    );
    assert.notEqual(ids[0], ids[1], 'two POSTs mean two different documents (D-084 #6)');
    for (const id of ids) {
      assert.ok(isUuid(id));
      assert.equal(server.authz.roleFor(id, 'demo-ada'), 'owner');
    }

    const after = await counts(server);
    assert.equal(after.document, before.document + 2);
    assert.equal(after.meta, before.meta + 2);
    assert.equal(after.membership, before.membership + 2, 'each document has its own owner row');
  });

  it('keeps another user on the non-disclosure 404, identical to an unknown document', async () => {
    const server = await newServer();
    const ada = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');
    const grace = await bootstrapSessionCookie(server.httpUrl, 'demo-grace');

    const created = await postDocument(server, ada, { title: 'Private to Ada' });
    assert.equal(created.status, 201);
    const documentId = ((await created.json()) as Record<string, unknown>)['documentId'] as string;

    const other = await fetch(`${server.httpUrl}/api/documents/${documentId}`, {
      headers: { cookie: grace },
      signal: AbortSignal.timeout(5_000),
    });
    const unknown = await fetch(`${server.httpUrl}/api/documents/${randomUUID()}`, {
      headers: { cookie: grace },
      signal: AbortSignal.timeout(5_000),
    });

    assert.equal(other.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await other.json(), await unknown.json(), 'bodies are identical');
    assert.deepEqual(comparableHeaders(other), comparableHeaders(unknown), 'headers are identical');

    const list = await fetch(`${server.httpUrl}/api/documents`, {
      headers: { cookie: grace },
      signal: AbortSignal.timeout(5_000),
    });
    const listBody = (await list.json()) as { documents: Array<Record<string, unknown>> };
    assert.ok(
      !listBody.documents.some((document) => document['id'] === documentId),
      'the other user does not see the document in the list',
    );
  });
});

describe('POST /api/documents — a real membership-insert failure is atomic', () => {
  it('returns 500 and leaves no document, metadata or membership behind', async () => {
    const server = await newServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');
    const before = await counts(server);

    await installMembershipFailureTrigger(server);
    try {
      const response = await postDocument(server, cookie, { title: 'Must not survive' });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'internal_error' });
    } finally {
      await dropMembershipFailureTrigger(server);
    }

    assert.deepEqual(await counts(server), before, 'all three inserts rolled back');

    const list = await fetch(`${server.httpUrl}/api/documents`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5_000),
    });
    const listBody = (await list.json()) as { documents: unknown[] };
    assert.deepEqual(listBody.documents, [], 'the half-created document is not listed');

    // The server is still healthy: the same request succeeds once the injected failure is gone.
    const retry = await postDocument(server, cookie, { title: 'After the failure' });
    assert.equal(retry.status, 201);
  });

  it('rolls back inside the store seam: load and metadata are both null after the failure', async () => {
    const server = await newServer();
    const store = server.store;
    assert.ok(isDocumentCreationStore(store), 'the SQLite store is the creation seam');
    assert.ok(isDocumentMetaStore(store), 'the SQLite store owns metadata');

    const documentId = randomUUID();
    await installMembershipFailureTrigger(server);
    try {
      await assert.rejects(
        () =>
          store.createDocumentWithOwner({
            documentId,
            title: 'Injected failure',
            ownerUserId: 'demo-ada',
          }),
        'the membership insert failure must reject the creation',
      );
    } finally {
      await dropMembershipFailureTrigger(server);
    }

    assert.equal(await store.load(documentId), null, 'no document row');
    assert.equal(await store.documentMeta(documentId), null, 'no metadata row');
    assert.equal(server.authz.roleFor(documentId, 'demo-ada'), null, 'no owner membership row');

    // Same seam, same id, after the failure: it succeeds as one unit.
    await store.createDocumentWithOwner({
      documentId,
      title: 'After the failure',
      ownerUserId: 'demo-ada',
    });
    assert.notEqual(await store.load(documentId), null);
    assert.equal((await store.documentMeta(documentId))?.title, 'After the failure');
    assert.equal(server.authz.roleFor(documentId, 'demo-ada'), 'owner');
  });
});

describe('POST /api/documents — verified Clerk identity (production mode)', () => {
  const ADA: VerifiedIdentity = {
    clerkUserId: 'user_clerk_ada_b125',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
  };
  const GRACE: VerifiedIdentity = {
    clerkUserId: 'user_clerk_grace_b125',
    email: 'grace@example.com',
    displayName: 'Grace Hopper',
  };
  const ADA_COOKIE = 'clerk_session=b125-ada';
  const GRACE_COOKIE = 'clerk_session=b125-grace';
  const verifier = createFakeSessionVerifier(({ cookie }) => {
    if (cookie === ADA_COOKIE) return ADA;
    if (cookie === GRACE_COOKIE) return GRACE;
    return null;
  });

  it('derives the owner from the verified internal user, never from the body', async () => {
    const server = await startTestServer({
      authMode: 'clerk',
      verifier,
      authorization: 'enforced',
    });
    servers.push(server);

    const session = await fetch(`${server.httpUrl}/api/session`, {
      headers: { cookie: ADA_COOKIE },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(session.status, 200);
    const sessionBody = (await session.json()) as Record<string, unknown>;
    const internalUserId = sessionBody['userId'] as string;
    assert.notEqual(internalUserId, ADA.clerkUserId, 'the Clerk sub never becomes the owner id');

    const created = await postDocument(server, ADA_COOKIE, { title: 'Clerk-created document' });
    assert.equal(created.status, 201);
    const documentId = ((await created.json()) as Record<string, unknown>)['documentId'] as string;
    assert.equal(server.authz.roleFor(documentId, internalUserId), 'owner');
    assert.equal(server.authz.roleFor(documentId, 'demo-ada'), null);

    const list = await fetch(`${server.httpUrl}/api/documents`, {
      headers: { cookie: ADA_COOKIE },
      signal: AbortSignal.timeout(5_000),
    });
    const listBody = (await list.json()) as { documents: Array<Record<string, unknown>> };
    assert.ok(listBody.documents.some((document) => document['id'] === documentId));

    // A different verified user is still a non-disclosure 404 on the new document.
    const other = await fetch(`${server.httpUrl}/api/documents/${documentId}`, {
      headers: { cookie: GRACE_COOKIE },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(other.status, 404);
    assert.deepEqual(await other.json(), { error: 'not_found' });

    const anonymous = await postDocument(server, null, { title: 'No session' });
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: 'session_required' });
  });
});
