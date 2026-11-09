/**
 * **P0-2 real-time revocation over a real WebSocket.**
 *
 * `docs/agent-governance/P0-2-MEMBERS.md` §实时撤权 requires that a member who is removed,
 * demoted or transferred **loses their live connection**, and that a reconnect is decided by
 * the new membership. This suite proves both halves over a real socket:
 *
 * - remove / demote / transfer close the affected sockets with `1008 membership_changed`;
 * - the next HTTP request already sees the new row (`404` for a removed member);
 * - a reconnect is refused with `ROOM_NOT_FOUND` when there is no membership, and reports the
 *   new role in `room-joined` when there is one;
 * - a viewer's update frame is still refused with the non-fatal `FORBIDDEN`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { WS_ERROR_CODES } from '@insighthub/shared';

import {
  TestClient,
  bootstrapSessionCookie,
  makePeerDocument,
  startTestServer,
  syncUpdateFrame,
  type TestServer,
} from './test-harness.js';

describe('P0-2 real-time revocation', () => {
  let server: TestServer;
  let ada: string;
  let grace: string;
  let linus: string;

  before(async () => {
    server = await startTestServer({ authorization: 'enforced', members: true });
    ada = await bootstrapSessionCookie(server.httpUrl, 'demo-ada');
    grace = await bootstrapSessionCookie(server.httpUrl, 'demo-grace');
    linus = await bootstrapSessionCookie(server.httpUrl, 'demo-linus');
  });

  after(async () => {
    await server.close();
  });

  function api(
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = { cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${server.httpUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
  }

  async function createDocument(): Promise<string> {
    const response = await api(ada, 'POST', '/api/documents', { title: 'Revocation test' });
    assert.equal(response.status, 201);
    return ((await response.json()) as { documentId: string }).documentId;
  }

  async function invite(documentId: string, email: string, role: string): Promise<void> {
    const response = await api(ada, 'POST', `/api/documents/${documentId}/members`, {
      email,
      role,
    });
    assert.equal(response.status, 200);
  }

  it('closes a removed member with 1008 and refuses the next join', async () => {
    const documentId = await createDocument();
    await invite(documentId, 'grace@insighthub.test', 'editor');

    const socket = await TestClient.connect(server.url, { cookie: grace });
    try {
      assert.equal((await socket.joinAndWait(documentId)).role, 'editor');

      const removal = await api(ada, 'DELETE', `/api/documents/${documentId}/members/demo-grace`);
      assert.equal(removal.status, 204);

      const closed = await socket.waitForClose();
      assert.equal(closed.code, 1008, 'revocation must be a 1008 policy close');
      assert.equal(closed.reason, 'membership_changed');

      // HTTP already sees the new membership: no membership is the non-disclosure 404.
      assert.equal((await api(grace, 'GET', `/api/documents/${documentId}`)).status, 404);

      // Reconnect: the session is still valid, so the upgrade succeeds; the join does not.
      const reconnect = await TestClient.connect(server.url, { cookie: grace });
      try {
        reconnect.join(documentId);
        await reconnect.waitForError(WS_ERROR_CODES.ROOM_NOT_FOUND);
      } finally {
        reconnect.close();
      }
    } finally {
      socket.close();
    }
  });

  it('closes a demoted member and the reconnected join reports the new role', async () => {
    const documentId = await createDocument();
    await invite(documentId, 'grace@insighthub.test', 'editor');

    const socket = await TestClient.connect(server.url, { cookie: grace });
    try {
      assert.equal((await socket.joinAndWait(documentId)).role, 'editor');

      const demotion = await api(
        ada,
        'PATCH',
        `/api/documents/${documentId}/members/demo-grace`,
        { role: 'viewer' },
      );
      assert.equal(demotion.status, 200);

      const closed = await socket.waitForClose();
      assert.equal(closed.code, 1008);
      assert.equal(closed.reason, 'membership_changed');
    } finally {
      socket.close();
    }

    const reconnect = await TestClient.connect(server.url, { cookie: grace });
    try {
      assert.equal((await reconnect.joinAndWait(documentId)).role, 'viewer');

      // The frame gate is still the authority for writes: a viewer's update is refused
      // without killing the socket (a reader stays a reader).
      const peer = makePeerDocument('a viewer cannot write this');
      reconnect.sendBinary(syncUpdateFrame(peer.doc));
      await reconnect.waitForError(WS_ERROR_CODES.FORBIDDEN);
      assert.equal(reconnect.closed, false, 'FORBIDDEN is non-fatal');
    } finally {
      reconnect.close();
    }
  });

  it('closes both sides of an ownership transfer; both rejoin with their new roles', async () => {
    const documentId = await createDocument();
    await invite(documentId, 'grace@insighthub.test', 'editor');

    const adaSocket = await TestClient.connect(server.url, { cookie: ada });
    const graceSocket = await TestClient.connect(server.url, { cookie: grace });
    try {
      assert.equal((await adaSocket.joinAndWait(documentId)).role, 'owner');
      assert.equal((await graceSocket.joinAndWait(documentId)).role, 'editor');

      const transfer = await api(ada, 'POST', `/api/documents/${documentId}/owner`, {
        userId: 'demo-grace',
      });
      assert.equal(transfer.status, 200);

      const [oldOwnerClose, newOwnerClose] = await Promise.all([
        adaSocket.waitForClose(),
        graceSocket.waitForClose(),
      ]);
      assert.equal(oldOwnerClose.code, 1008);
      assert.equal(oldOwnerClose.reason, 'membership_changed');
      assert.equal(newOwnerClose.code, 1008);
      assert.equal(newOwnerClose.reason, 'membership_changed');

      assert.equal(server.authz.roleFor(documentId, 'demo-ada'), 'editor');
      assert.equal(server.authz.roleFor(documentId, 'demo-grace'), 'owner');
    } finally {
      adaSocket.close();
      graceSocket.close();
    }

    const newOwner = await TestClient.connect(server.url, { cookie: grace });
    const oldOwner = await TestClient.connect(server.url, { cookie: ada });
    try {
      assert.equal((await newOwner.joinAndWait(documentId)).role, 'owner');
      assert.equal((await oldOwner.joinAndWait(documentId)).role, 'editor');
    } finally {
      newOwner.close();
      oldOwner.close();
    }
  });

  it('closes the caller\'s own socket when they leave', async () => {
    const documentId = await createDocument();
    await invite(documentId, 'linus@insighthub.test', 'viewer');

    const socket = await TestClient.connect(server.url, { cookie: linus });
    try {
      assert.equal((await socket.joinAndWait(documentId)).role, 'viewer');

      const left = await api(linus, 'POST', `/api/documents/${documentId}/leave`);
      assert.equal(left.status, 204);

      const closed = await socket.waitForClose();
      assert.equal(closed.code, 1008);
      assert.equal(closed.reason, 'membership_changed');
      assert.equal((await api(linus, 'GET', `/api/documents/${documentId}`)).status, 404);
    } finally {
      socket.close();
    }
  });
});
