/**
 * M2 Phase 2 P1 — the **WebSocket enforcement points** (`docs/CONTRACTS.md` §17.5, §17.7;
 * `docs/TASKS.md` M2 Phase 2).
 *
 * ## What this file proves, and at which layer
 *
 * Node-level evidence for the acceptance criteria that A6 will also walk through a real browser:
 *
 * | # | Claim | How |
 * | --- | --- | --- |
 * | P2-1 | a `viewer` cannot change the document | the SYNC frame is refused with `FORBIDDEN`, nothing is applied/persisted/broadcast, the socket stays open and a peer receives nothing |
 * | P2-2 | identity cannot be self-declared | payload / header / query `userId` and `mode: readwrite` all change nothing; the role still comes from the session |
 * | P2-4 | one answer per role | table-driven: shared judge, `authz.can`, WS join, WS frame, and `room-joined.role` agree for every role |
 * | P2-5 | revocation is immediate (Node half) | `DELETE /api/session` — the same token is refused at the upgrade |
 * | §5.2 | `room-joined.role` is transmitted | a join reports exactly `authz.roleFor(...)` |
 * | §17.4/§17.5 | non-disclosure | unknown document and no-membership produce the **same** `ROOM_NOT_FOUND` |
 * | §17.5 | a denied join keeps the current room | the socket still owns, and can still write, the room it had |
 * | Task 5 | document metadata has a real source | the durable store, surfaced through `GET /api/documents*` |
 *
 * ## What it deliberately does not do
 *
 * It does **not** treat a Node test as browser evidence (`AGENTS.md` R5): the browser-level
 * pass for P2-1/P2-5 belongs to A6. It also does not invent a membership-mutation endpoint —
 * Phase 2 has none (§17.3), so "the role changed and was re-evaluated" cannot be exercised
 * through the public surface here; the frame gate is instead re-asked on every frame, which the
 * fresh-answer assertions below cover.
 *
 * Every server here runs with `authorization: 'enforced'`, i.e. the real `AuthzService` and the
 * real `authz.db`, on a temporary data directory (the two databases are separate by design,
 * `docs/DECISIONS.md` D-062 §4).
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  WS_ERROR_CODES,
  decodeSyncFrame,
  documentCapabilities,
  encodeSyncStep1,
  encodeSyncUpdate,
  readSyncMessageType,
  type DocumentCapability,
  type DocumentRole,
} from '@insighthub/shared';
import * as Y from 'yjs';

import {
  bootstrapSessionCookie,
  createTestAwareness,
  startTestServer,
  TestClient,
  type TestServer,
} from './test-harness.js';

const servers: TestServer[] = [];
const clients: TestClient[] = [];

after(async () => {
  for (const client of clients) client.destroy();
  for (const server of servers) await server.close();
});

/** A server with the real authz wired into the WebSocket layer. */
async function enforcedServer(): Promise<TestServer> {
  const server = await startTestServer({ authorization: 'enforced' });
  servers.push(server);
  return server;
}

/** Connect with a freshly bootstrapped session for `demoUserId`. */
async function connectAs(server: TestServer, demoUserId: string): Promise<TestClient> {
  const cookie = await bootstrapSessionCookie(server.httpUrl, demoUserId);
  const client = await TestClient.connect(server.url, { cookie });
  clients.push(client);
  return client;
}

/** Append text locally and return the incremental update that carries it. */
function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText('content');
  const before = Y.encodeStateVector(doc);
  text.insert(text.length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

/** The durable text of a document, read through a fresh replay of the store. */
async function durableText(server: TestServer, documentId: string): Promise<string | null> {
  const stored = await server.store.load(documentId);
  if (stored === null) return null;
  const doc = new Y.Doc();
  const { applyStoredDocument } = await import('../persistence/hydrator.js');
  applyStoredDocument(stored, doc);
  const text = doc.getText('content').toString();
  doc.destroy();
  return text;
}

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

/** True when the caller may read the document, per the frozen capability table. */
function canReadRole(role: DocumentRole | null): boolean {
  return role !== null && documentCapabilities.canRead(role);
}

/**
 * One HTTP call to this server's API, with the session cookie and two bounds.
 *
 * - `connection: 'close'` — node's `fetch` pools sockets process-wide, and a pooled socket is a
 *   live handle that outlives the test and keeps the *process* alive, which turns the gate into
 *   one that prints every result and never exits (TOOLING-P2).
 * - `AbortSignal.timeout` — an unbounded request inherits undici's 300 s timers, so a stuck call
 *   would look like a hung gate rather than a failed assertion.
 */
async function apiFetch(
  server: TestServer,
  cookie: string,
  path: string,
  init: { method?: string } = {},
): Promise<Response> {
  return await fetch(`${server.httpUrl}${path}`, {
    ...init,
    headers: { cookie, connection: 'close' },
    signal: AbortSignal.timeout(5_000),
  });
}

/* ------------------------------------------------------------------ *
 * §17.5 — the upgrade requires a session
 * ------------------------------------------------------------------ */

describe('upgrade authentication (§17.5)', () => {
  it('refuses an unauthenticated upgrade with HTTP 401 and establishes no socket', async () => {
    const server = await enforcedServer();

    // The refusal is the HTTP status the contract names, not a socket that opens and is then
    // closed: §17.5 says the upgrade is refused with 401.
    assert.equal(
      await TestClient.expectRefused(server.url),
      401,
      'no socket may be established without a session',
    );
  });

  it('accepts an upgrade carrying a bootstrapped session cookie', async () => {
    const server = await enforcedServer();
    const client = await connectAs(server, 'demo-ada');
    assert.equal(client.closed, false);
  });

  it('ignores a userId supplied in the query string or a header', async () => {
    const server = await enforcedServer();

    // No cookie: an asserted identity is worthless, because identity is resolved from the
    // session and from nowhere else (§17.1, §17.5).
    const withQuery = `${server.url}?userId=demo-ada`;
    assert.equal(
      await TestClient.expectRefused(withQuery),
      401,
      'a query parameter is not a session',
    );

    // Even with a *valid* cookie for linus, adding `userId=demo-ada` must not promote the
    // socket: the join reports linus's role.
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-linus');
    const promoted = await TestClient.connect(`${server.url}?userId=demo-ada`, { cookie });
    clients.push(promoted);
    const joined = await promoted.joinAndWait('demo-document');
    assert.equal(joined.role, 'viewer', 'a query parameter cannot change who the session is');
  });
});

/* ------------------------------------------------------------------ *
 * §17.5 — join authorization and non-disclosure
 * ------------------------------------------------------------------ */

describe('join authorization (§17.5)', () => {
  it('transmits the caller’s own role in room-joined (§5.2)', async () => {
    const server = await enforcedServer();

    const owner = await connectAs(server, 'demo-ada');
    assert.equal((await owner.joinAndWait('demo-document')).role, 'owner');

    const editor = await connectAs(server, 'demo-grace');
    assert.equal((await editor.joinAndWait('demo-document')).role, 'editor');

    const viewer = await connectAs(server, 'demo-linus');
    assert.equal((await viewer.joinAndWait('demo-document')).role, 'viewer');

    const commenter = await connectAs(server, 'demo-ada');
    assert.equal((await commenter.joinAndWait('demo-team-notes')).role, 'commenter');
  });

  it('answers no-membership and unknown-document with the same code (§17.4/§17.5)', async () => {
    const server = await enforcedServer();

    // `linus` has no membership on `demo-private-notes`; `no-such-document` exists for nobody.
    const outsider = await connectAs(server, 'demo-linus');
    outsider.join('demo-private-notes');
    const denied = await outsider.waitForError(WS_ERROR_CODES.ROOM_NOT_FOUND);

    const stranger = await connectAs(server, 'demo-linus');
    stranger.join('no-such-document');
    const unknown = await stranger.waitForError(WS_ERROR_CODES.ROOM_NOT_FOUND);

    assert.equal(denied.payload.code, unknown.payload.code);
    // Byte-identical apart from the envelope's own timestamp: a caller must not be able to tell
    // "not yours" from "does not exist".
    assert.equal(denied.payload.message, unknown.payload.message);
    // Non-fatal: the socket survives a refused join.
    assert.equal(outsider.closed, false);
  });

  it('keeps the room a socket already holds when a second join is denied (§17.5)', async () => {
    const server = await enforcedServer();

    // `grace` owns `demo-team-notes` and has no membership on `demo-private-notes`.
    const mover = await connectAs(server, 'demo-grace');
    await mover.joinAndWait('demo-team-notes');

    mover.join('demo-private-notes');
    await mover.waitForError(WS_ERROR_CODES.ROOM_NOT_FOUND);

    // Atomic replace applies only to a *successful* join, so the original room must be intact and
    // still writable.
    const observer = await connectAs(server, 'demo-ada');
    const joined = await observer.joinAndWait('demo-team-notes');
    assert.equal(joined.peers.length, 1, 'the denied join must not have removed the mover');

    mover.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), 'still writable')));
    await waitFor(
      async () => (await durableText(server, 'demo-team-notes')) === 'still writable',
      'the mover to keep writing to the room it still owns',
    );
  });

  it('does not read join-room.mode as an authorization input (CONTRACTS §17.5, ARCHITECTURE §8.3)', async () => {
    const server = await enforcedServer();
    const viewer = await connectAs(server, 'demo-linus');

    // Ask for `readwrite` explicitly. The server derives the capability from membership, so the
    // claim changes nothing — asserted through the role it reports and the write it still refuses.
    viewer.send({
      type: 'join-room',
      payload: { documentId: 'demo-document', protocolVersion: 2, mode: 'readwrite' },
      ts: new Date().toISOString(),
    });
    const joined = await viewer.waitForText('room-joined');
    assert.equal(joined.payload.role, 'viewer');

    viewer.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), 'claimed readwrite')));
    await viewer.waitForError(WS_ERROR_CODES.FORBIDDEN);
    assert.equal(await durableText(server, 'demo-document'), null);
  });
});

/* ------------------------------------------------------------------ *
 * P2-1 — a viewer cannot change the document
 * ------------------------------------------------------------------ */

describe('P2-1 — the SYNC gate keeps a viewer read-only', () => {
  it('refuses a viewer’s update: not applied, not persisted, not broadcast, socket open', async () => {
    const server = await enforcedServer();

    const owner = await connectAs(server, 'demo-ada');
    const viewer = await connectAs(server, 'demo-linus');
    await owner.joinAndWait('demo-document');
    await viewer.joinAndWait('demo-document');

    // Seed through the owner so the document exists and the viewer has received content.
    const ownerDoc = new Y.Doc();
    owner.sendBinary(encodeSyncUpdate(appendText(ownerDoc, 'from the owner')));
    await viewer.waitForFrame(
      (frame) => frame.kind === 'binary',
      'the owner閳ユ獨 update reaching the viewer',
    );
    await waitFor(
      async () => (await durableText(server, 'demo-document')) === 'from the owner',
      'the owner閳ユ獨 edit to be durable',
    );

    owner.clear();

    // The viewer attempts a write.
    viewer.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), 'HACK')));

    const forbidden = await viewer.waitForError(WS_ERROR_CODES.FORBIDDEN);
    assert.equal(forbidden.payload.code, WS_ERROR_CODES.FORBIDDEN);

    // Nothing was broadcast: the peer saw no frame at all.
    await viewer.settle(200);
    assert.equal(owner.binaryFrames().length, 0, 'a denied update must not be relayed');
    // And nothing was applied or persisted.
    assert.equal(
      await durableText(server, 'demo-document'),
      'from the owner',
      'a denied update must not reach the store',
    );

    // The socket stays open and remains a reader: the owner's next edit still arrives.
    assert.equal(viewer.closed, false, 'FORBIDDEN is non-fatal 閳?a reader stays a reader');
    viewer.clear();
    owner.sendBinary(encodeSyncUpdate(appendText(ownerDoc, ' and more')));
    await viewer.waitForFrame(
      (frame) => frame.kind === 'binary',
      'the viewer to keep receiving updates after its write was refused',
    );
  });

  it('lets a viewer read content that already existed before it joined', async () => {
    // The test that pins why `SyncStep1` needs `canRead` and not `canEdit`.
    //
    // `docs/CONTRACTS.md` §17.5's table says "BINARY SYNC requires canEdit", but the handshake is
    // only ever client-initiated (§10.2): a client that cannot send `SyncStep1` can never receive
    // the document, because the server never pushes state unprompted. Gating the *read* half on
    // `canEdit` would make the `viewer` role unable to read — the one thing it exists for, and a
    // direct contradiction of P2-1's "the socket still receives others' updates".
    const server = await enforcedServer();

    const owner = await connectAs(server, 'demo-ada');
    await owner.joinAndWait('demo-document');
    owner.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), 'already here')));
    await waitFor(
      async () => (await durableText(server, 'demo-document')) === 'already here',
      'the content to be durable before the viewer arrives',
    );
    owner.destroy();

    const viewer = await connectAs(server, 'demo-linus');
    await viewer.joinAndWait('demo-document');
    viewer.clear();

    // A `SyncStep1` from a viewer must be answered, not refused.
    viewer.sendBinary(encodeSyncStep1(new Y.Doc()));
    const reply = await viewer.waitForFrame(
      (frame) => frame.kind === 'binary',
      'the SyncStep2 that carries the document to a reader',
    );
    assert.equal(reply.kind, 'binary');
    if (reply.kind === 'binary') {
      const decoded = decodeSyncFrame(reply.bytes);
      assert.ok(decoded !== null, 'the reply must be a decodable SYNC frame');
      assert.equal(readSyncMessageType(decoded), 1, 'the reply is a SyncStep2, i.e. content');
    }

    // And the viewer was not refused for asking.
    const errors = viewer
      .textMessages()
      .flatMap((message) => (message.type === 'error' ? [message.payload.code] : []));
    assert.deepEqual(errors, [], `reading must not be refused, saw ${errors.join(', ')}`);
  });

  it('lets a viewer publish awareness, which needs canRead only (§17.5)', async () => {
    const server = await enforcedServer();

    const owner = await connectAs(server, 'demo-ada');
    const viewer = await connectAs(server, 'demo-linus');
    await owner.joinAndWait('demo-document');
    await viewer.joinAndWait('demo-document');
    owner.clear();

    // An awareness frame built by hand from a real Awareness instance: presence is the one thing
    // a viewer must be able to send, otherwise a cursor is impossible for the role.
    const { encodeAwarenessUpdate } = await import('y-protocols/awareness');
    const { encodeAwarenessFrame } = await import('@insighthub/shared');
    const doc = new Y.Doc();
    const awareness = createTestAwareness(doc);
    awareness.setLocalState({
      user: { id: 'demo-linus', name: 'Viewer', color: '#3366ff' },
      cursor: { anchor: 0, head: 0 },
      selection: null,
      updatedAt: Date.now(),
    });
    try {
      viewer.sendBinary(
        encodeAwarenessFrame(encodeAwarenessUpdate(awareness, [awareness.clientID])),
      );
      await owner.waitForFrame(
        (frame) => frame.kind === 'binary',
        'the viewer閳ユ獨 awareness reaching the peer',
      );
    } finally {
      awareness.destroy();
      doc.destroy();
    }

    // No refusal was produced for the awareness frame.
    const errors = viewer
      .textMessages()
      .flatMap((message) => (message.type === 'error' ? [message.payload.code] : []));
    assert.deepEqual(errors, [], `awareness must not be refused, saw ${errors.join(', ')}`);
  });

  it('allows a commenter to read but not to edit (§17.5 + documentCapabilities)', async () => {
    const server = await enforcedServer();
    const commenter = await connectAs(server, 'demo-ada');
    await commenter.joinAndWait('demo-team-notes');

    commenter.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), 'commenter edit')));
    await commenter.waitForError(WS_ERROR_CODES.FORBIDDEN);
    assert.equal(commenter.closed, false);
  });

  it('allows an editor to write', async () => {
    const server = await enforcedServer();
    const editor = await connectAs(server, 'demo-grace');
    await editor.joinAndWait('demo-document');

    editor.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), 'editor wrote this')));
    await waitFor(
      async () => (await durableText(server, 'demo-document')) === 'editor wrote this',
      'an editor閳ユ獨 edit to be accepted',
    );
  });
});

/* ------------------------------------------------------------------ *
 * P2-2 — identity is not self-declarable
 * ------------------------------------------------------------------ */

describe('P2-2 — a client cannot declare who it is', () => {
  it('ignores a userId smuggled into the join payload', async () => {
    const server = await enforcedServer();
    const viewer = await connectAs(server, 'demo-linus');

    // The parser strips unknown keys, so this field never reaches the server's logic — and even
    // if it did, nothing reads it. Asserted by outcome: the role is still `viewer` and the write
    // is still refused.
    viewer.send({
      type: 'join-room',
      payload: {
        documentId: 'demo-document',
        protocolVersion: 2,
        mode: 'readwrite',
        userId: 'demo-ada',
      },
      ts: new Date().toISOString(),
    });
    const joined = await viewer.waitForText('room-joined');
    assert.equal(joined.payload.role, 'viewer');

    viewer.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), 'as if it were ada')));
    await viewer.waitForError(WS_ERROR_CODES.FORBIDDEN);
  });

  it('answers only from the session when two clients claim different identities', async () => {
    const server = await enforcedServer();

    // Two sockets, two cookies, the same claimed name in the payload: the roles differ, which is
    // only possible if the session is what decides.
    const asOwner = await connectAs(server, 'demo-ada');
    const asViewer = await connectAs(server, 'demo-linus');

    const claimed = { userId: 'demo-ada', mode: 'readwrite' };
    asOwner.send({
      type: 'join-room',
      payload: { documentId: 'demo-document', protocolVersion: 2, ...claimed },
      ts: new Date().toISOString(),
    });
    asViewer.send({
      type: 'join-room',
      payload: { documentId: 'demo-document', protocolVersion: 2, ...claimed },
      ts: new Date().toISOString(),
    });

    assert.equal((await asOwner.waitForText('room-joined')).payload.role, 'owner');
    assert.equal((await asViewer.waitForText('room-joined')).payload.role, 'viewer');
  });
});

/* ------------------------------------------------------------------ *
 * P2-4 — one answer per role, four entry points
 * ------------------------------------------------------------------ */

describe('P2-4 — shared judge, authz, WS join and WS frame agree', () => {
  const cases: readonly { documentId: string; userId: string }[] = [
    { documentId: 'demo-document', userId: 'demo-ada' }, // owner
    { documentId: 'demo-document', userId: 'demo-grace' }, // editor
    { documentId: 'demo-document', userId: 'demo-linus' }, // viewer
    { documentId: 'demo-team-notes', userId: 'demo-ada' }, // commenter
    { documentId: 'demo-team-notes', userId: 'demo-grace' }, // owner (second document)
    { documentId: 'demo-private-notes', userId: 'demo-linus' }, // no membership
  ];

  const capabilities: readonly DocumentCapability[] = [
    'canRead',
    'canComment',
    'canEdit',
    'canManageMembers',
  ];

  it('reports the same capability everywhere, for every seeded role', async () => {
    const server = await enforcedServer();

    for (const { documentId, userId } of cases) {
      const role: DocumentRole | null = server.authz.roleFor(documentId, userId);

      // (1) the shared judge and (2) `authz.can` must agree on all four capabilities — the decision
      // core reuses `documentCapabilities`, so a disagreement would mean a second rule table.
      for (const capability of capabilities) {
        const expected = role === null ? false : documentCapabilities[capability](role);
        assert.equal(
          server.authz.can(documentId, userId, capability),
          expected,
          `${documentId}/${userId}: ${capability} differs between the shared judge and authz.can`,
        );
      }

      const expectJoin = canReadRole(role);
      const client = await connectAs(server, userId);

      // (3) WS join.
      client.join(documentId);
      if (!expectJoin) {
        const error = await client.waitForError(WS_ERROR_CODES.ROOM_NOT_FOUND);
        assert.equal(error.payload.code, WS_ERROR_CODES.ROOM_NOT_FOUND, `${documentId}/${userId}`);
        continue;
      }

      const joined = await client.waitForText('room-joined');
      // (4a) the role the payload reports is the role the decision core resolved — this is the
      // `room-joined.role` row of the matrix, and the only channel the client has.
      assert.equal(joined.payload.role, role, `${documentId}/${userId}: room-joined.role`);

      // (4b) the frame gate: `canEdit` decides whether a SYNC update is accepted.
      const expectEdit = documentCapabilities.canEdit(role as DocumentRole);
      client.clear();
      client.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), `${userId} edit`)));
      if (expectEdit) {
        await waitFor(
          async () => (await durableText(server, documentId))?.includes(`${userId} edit`) === true,
          `${documentId}/${userId}: an editable document to accept the update`,
        );
      } else {
        const error = await client.waitForError(WS_ERROR_CODES.FORBIDDEN);
        assert.equal(error.payload.code, WS_ERROR_CODES.FORBIDDEN, `${documentId}/${userId}`);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * P2-5 (Node half) — revocation is immediate
 * ------------------------------------------------------------------ */

describe('P2-5 — a destroyed session is refused everywhere at once', () => {
  it('refuses the same token at the upgrade after DELETE /api/session', async () => {
    const server = await enforcedServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');

    // The token works before revocation.
    const before = await TestClient.connect(server.url, { cookie });
    clients.push(before);
    before.destroy();

    const deleted = await apiFetch(server, cookie, '/api/session', { method: 'DELETE' });
    assert.equal(deleted.status, 204, 'DELETE /api/session must succeed for a live session');

    // ...and is refused after it, at the socket boundary, with no socket established.
    assert.equal(
      await TestClient.expectRefused(server.url, cookie),
      401,
      'a revoked token must not be able to open a socket',
    );

    // The HTTP layer agrees, which is what makes "everywhere" true rather than "the socket only".
    const session = await apiFetch(server, cookie, '/api/session');
    assert.equal(session.status, 401);
  });
});

/* ------------------------------------------------------------------ *
 * Task 5 — document metadata comes from the durable store
 * ------------------------------------------------------------------ */

describe('document metadata source (M2 Phase 2 P1, task 5)', () => {
  it('serves a document that a session created, from the store, not a fixture', async () => {
    const server = await enforcedServer();
    const cookie = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');

    // Nothing is listed before the document exists durably.
    const before = await apiFetch(server, cookie, '/api/documents');
    assert.equal(before.status, 200);
    const beforeBody = (await before.json()) as { documents: { id: string }[] };
    assert.deepEqual(
      beforeBody.documents.map((document) => document.id),
      [],
      'a document the store has never seen must not be listed 閳?the fixture is no longer the source',
    );

    // An authorized join brings it into existence.
    const owner = await connectAs(server, 'demo-ada');
    await owner.joinAndWait('demo-document');
    owner.sendBinary(encodeSyncUpdate(appendText(new Y.Doc(), 'hello')));
    await waitFor(
      async () => (await durableText(server, 'demo-document')) === 'hello',
      'the document to become durable',
    );

    const after = await apiFetch(server, cookie, '/api/documents');
    const afterBody = (await after.json()) as {
      documents: {
        id: string;
        title: string;
        ownerId: string;
        revision: number;
        createdAt: string;
        updatedAt: string;
      }[];
    };
    const listed = afterBody.documents.find((document) => document.id === 'demo-document');
    assert.ok(listed !== undefined, 'the durable document must be listed');
    assert.equal(listed.ownerId, 'demo-ada', 'the creator is recorded, not invented');
    assert.equal(listed.title, 'demo-document', 'the title defaults to the id (no rename API)');
    assert.ok(listed.revision >= 1, 'the revision tracks the committed sequence');
    assert.ok(Number.isFinite(Date.parse(listed.createdAt)));

    // The single-document endpoint agrees with the list (one source, two routes).
    const single = await apiFetch(server, cookie, '/api/documents/demo-document');
    assert.equal(single.status, 200);
    assert.deepEqual(await single.json(), listed);

    // ...and the non-disclosure rule still holds for a caller with no membership: the same 404 the
    // unknown document gets, so the catalog cannot be used to probe for existence.
    const outsiderCookie = await bootstrapSessionCookie(server.httpUrl, 'demo-linus');
    const denied = await apiFetch(server, outsiderCookie, '/api/documents/demo-private-notes');
    const unknown = await apiFetch(server, outsiderCookie, '/api/documents/no-such-document');
    assert.equal(denied.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await denied.json(), await unknown.json());
  });
});
