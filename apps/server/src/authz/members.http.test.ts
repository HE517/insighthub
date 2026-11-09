/**
 * **P0-2 — document member management over real HTTP** (`docs/agent-governance/P0-2-MEMBERS.md`).
 *
 * Layer: **Node only** — a real Express server, a real SQLite database, the real authorization
 * core, and the real member service. Every request goes through the production route, so the
 * claims below are about status codes and bodies a client actually sees, not about helpers.
 *
 * What is proven:
 *
 * - `GET …/members` returns `{ members: [{userId,email,name,role}], ownerId }`, Owner-only;
 * - email invitation resolves a demo mailbox, is case-insensitive/trimmed, updates an existing
 *   member idempotently, refuses `owner`, and has one `404 user_not_found` for unknown addresses;
 * - non-Owner members get `403`, strangers/unknown documents get `404`, bad bodies get `400`;
 * - role change / removal / leave / transfer obey the frozen 409 vocabulary;
 * - after a transfer the old Owner is an `editor` and the new one `owner`, with exactly one
 *   owner row at every point.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { bootstrapSessionCookie, startTestServer, type TestServer } from '../rooms/test-harness.js';
import { createFakeSessionVerifier, type VerifiedIdentity } from './session-verifier.js';
import { DATABASE_FILE_NAME } from '../persistence/sqlite-store.js';
import { loadSqliteModule } from '../persistence/sqlite-runtime.js';

interface MemberBody {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string;
  readonly role: string;
}

interface MemberListBody {
  readonly members: MemberBody[];
  readonly ownerId: string;
}

describe('P0-2 member HTTP API', () => {
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

  /** Create a fresh document owned by ada, so each test has an isolated membership table. */
  async function createDocument(): Promise<string> {
    const response = await api(ada, 'POST', '/api/documents', { title: 'Members test' });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { documentId: string };
    return body.documentId;
  }

  function api(
    cookie: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (cookie !== null) headers['cookie'] = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(`${server.httpUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
  }

  async function apiRaw(cookie: string, method: string, path: string, raw: string): Promise<Response> {
    return fetch(`${server.httpUrl}${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: raw,
      signal: AbortSignal.timeout(5_000),
    });
  }

  function membersPath(documentId: string): string {
    return `/api/documents/${documentId}/members`;
  }

  async function invite(
    actorCookie: string,
    documentId: string,
    email: string,
    role: string,
  ): Promise<Response> {
    return await api(actorCookie, 'POST', membersPath(documentId), { email, role });
  }

  async function listMembers(
    actorCookie: string,
    documentId: string,
  ): Promise<MemberListBody> {
    const response = await api(actorCookie, 'GET', membersPath(documentId));
    assert.equal(response.status, 200);
    return (await response.json()) as MemberListBody;
  }

  async function memberRows(
    documentId: string,
  ): Promise<ReadonlyArray<{ userId: string; role: string }>> {
    assert.ok(server.dataPath !== undefined);
    const sqlite = await loadSqliteModule();
    const db = new sqlite.DatabaseSync(join(server.dataPath, DATABASE_FILE_NAME));
    try {
      const rows = db
        .prepare(
          'SELECT user_id, role FROM authz_document_membership WHERE document_id = ? ORDER BY user_id ASC',
        )
        .all(documentId);
      return rows.map((row) => ({
        userId: String(row['user_id']),
        role: String(row['role']),
      }));
    } finally {
      db.close();
    }
  }

  async function ownerCount(documentId: string): Promise<number> {
    return (await memberRows(documentId)).filter((row) => row.role === 'owner').length;
  }

  it('lists members with email/name/role and the single ownerId', async () => {
    const documentId = await createDocument();
    assert.equal((await invite(ada, documentId, 'grace@insighthub.test', 'editor')).status, 200);
    assert.equal((await invite(ada, documentId, 'linus@insighthub.test', 'viewer')).status, 200);

    const body = await listMembers(ada, documentId);
    assert.equal(body.ownerId, 'demo-ada');
    const byUser = new Map(body.members.map((member) => [member.userId, member]));
    assert.deepEqual(byUser.get('demo-ada'), {
      userId: 'demo-ada',
      email: 'ada@insighthub.test',
      name: 'Ada Lovelace',
      role: 'owner',
    });
    assert.deepEqual(byUser.get('demo-grace'), {
      userId: 'demo-grace',
      email: 'grace@insighthub.test',
      name: 'Grace Hopper',
      role: 'editor',
    });
    assert.deepEqual(byUser.get('demo-linus'), {
      userId: 'demo-linus',
      email: 'linus@insighthub.test',
      name: 'Linus Torvalds',
      role: 'viewer',
    });
    // No token, secret or password field can appear in this body.
    for (const member of body.members) {
      assert.deepEqual(Object.keys(member).sort(), ['email', 'name', 'role', 'userId']);
    }
  });

  it('is Owner-only: a member gets 403 and a stranger/unknown document gets 404', async () => {
    const documentId = await createDocument();
    assert.equal((await invite(ada, documentId, 'grace@insighthub.test', 'editor')).status, 200);

    // A member who is not the Owner can read the document but not manage it.
    assert.equal((await api(grace, 'GET', membersPath(documentId))).status, 403);
    assert.equal((await invite(grace, documentId, 'linus@insighthub.test', 'viewer')).status, 403);
    assert.equal(
      (await api(grace, 'PATCH', `${membersPath(documentId)}/demo-ada`, { role: 'editor' }))
        .status,
      403,
    );
    assert.equal(
      (await api(grace, 'POST', `/api/documents/${documentId}/owner`, { userId: 'demo-ada' }))
        .status,
      403,
    );

    // No membership at all (linus on this document) is the same 404 as an unknown document.
    assert.equal((await api(linus, 'GET', membersPath(documentId))).status, 404);
    assert.equal((await invite(linus, documentId, 'linus@insighthub.test', 'viewer')).status, 404);
    assert.equal(
      (await api(ada, 'GET', membersPath('no-such-document'))).status,
      404,
    );

    // No session at all is 401 (demo body).
    const unauthenticated = await api(null, 'GET', membersPath(documentId));
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { error: 'unauthenticated' });
  });

  it('invites a demo mailbox, updates an existing member, and never grants ownership', async () => {
    const documentId = await createDocument();

    const invited = await invite(ada, documentId, 'grace@insighthub.test', 'editor');
    assert.equal(invited.status, 200);
    assert.deepEqual(await invited.json(), {
      userId: 'demo-grace',
      email: 'grace@insighthub.test',
      name: 'Grace Hopper',
      role: 'editor',
    });

    // The same address again is an idempotent role update, not a duplicate row or a 409.
    const updated = await invite(ada, documentId, 'grace@insighthub.test', 'viewer');
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as MemberBody).role, 'viewer');
    assert.deepEqual(await memberRows(documentId), [
      { userId: 'demo-ada', role: 'owner' },
      { userId: 'demo-grace', role: 'viewer' },
    ]);

    // Case-insensitive and trimmed, because the address is a mailbox, not an exact string.
    assert.equal(
      (await invite(ada, documentId, '  GRACE@InsightHub.TEST ', 'commenter')).status,
      200,
    );

    // Unknown address: exactly one body, no way to tell "no user" from "not invitable".
    const unknown = await invite(ada, documentId, 'nobody@insighthub.test', 'viewer');
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'user_not_found' });

    // Inviting the Owner (the only way an invite could name the owner) is a 409.
    const self = await invite(ada, documentId, 'ada@insighthub.test', 'editor');
    assert.equal(self.status, 409);
    assert.deepEqual(await self.json(), { error: 'already_owner' });

    // `owner` is not an assignable role, and strict bodies refuse unknown/missing fields.
    assert.equal((await invite(ada, documentId, 'linus@insighthub.test', 'owner')).status, 400);
    assert.equal(
      (await api(ada, 'POST', membersPath(documentId), { email: 'linus@insighthub.test' })).status,
      400,
    );
    assert.equal(
      (
        await api(ada, 'POST', membersPath(documentId), {
          email: 'linus@insighthub.test',
          role: 'viewer',
          userId: 'demo-evil',
        })
      ).status,
      400,
    );
    assert.equal((await api(ada, 'POST', membersPath(documentId), { email: '', role: 'viewer' })).status, 400);
    assert.equal(
      (
        await apiRaw(
          ada,
          'POST',
          membersPath(documentId),
          '{"email":"linus@insighthub.test","role":',
        )
      ).status,
      400,
    );

    // None of the refused invites created a member.
    assert.deepEqual(
      (await memberRows(documentId)).map((row) => row.userId).sort(),
      ['demo-ada', 'demo-grace'],
    );
  });

  it('changes roles, protects the owner row, removes members and lets non-owners leave', async () => {
    const documentId = await createDocument();
    assert.equal((await invite(ada, documentId, 'grace@insighthub.test', 'editor')).status, 200);
    assert.equal((await invite(ada, documentId, 'linus@insighthub.test', 'viewer')).status, 200);

    const changed = await api(ada, 'PATCH', `${membersPath(documentId)}/demo-grace`, {
      role: 'commenter',
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), {
      userId: 'demo-grace',
      email: 'grace@insighthub.test',
      name: 'Grace Hopper',
      role: 'commenter',
    });

    // The owner's role is immutable through PATCH; ownership only moves by transfer.
    const ownerPatch = await api(ada, 'PATCH', `${membersPath(documentId)}/demo-ada`, {
      role: 'editor',
    });
    assert.equal(ownerPatch.status, 409);
    assert.deepEqual(await ownerPatch.json(), { error: 'owner_role_immutable' });

    // `owner` is not a PATCH role.
    assert.equal(
      (
        await api(ada, 'PATCH', `${membersPath(documentId)}/demo-grace`, {
          role: 'owner',
        })
      ).status,
      400,
    );

    // Unknown target id is the non-disclosure 404.
    assert.equal(
      (await api(ada, 'PATCH', `${membersPath(documentId)}/demo-nobody`, { role: 'viewer' }))
        .status,
      404,
    );

    // Removing the Owner requires a transfer first.
    const removeOwner = await api(ada, 'DELETE', `${membersPath(documentId)}/demo-ada`);
    assert.equal(removeOwner.status, 409);
    assert.deepEqual(await removeOwner.json(), { error: 'owner_requires_transfer' });

    // Removing a plain member revokes the membership immediately.
    assert.equal(
      (await api(ada, 'DELETE', `${membersPath(documentId)}/demo-grace`)).status,
      204,
    );
    assert.equal((await api(grace, 'GET', `/api/documents/${documentId}`)).status, 404);
    // A second removal of the same user is the target-row 404, not a success.
    assert.equal(
      (await api(ada, 'DELETE', `${membersPath(documentId)}/demo-grace`)).status,
      404,
    );

    // A non-owner member may leave (204), and loses access immediately.
    assert.equal(
      (await api(linus, 'POST', `/api/documents/${documentId}/leave`)).status,
      204,
    );
    assert.equal((await api(linus, 'GET', `/api/documents/${documentId}`)).status, 404);

    // The last Owner may not leave: transfer first.
    const ownerLeave = await api(ada, 'POST', `/api/documents/${documentId}/leave`);
    assert.equal(ownerLeave.status, 409);
    assert.deepEqual(await ownerLeave.json(), { error: 'last_owner' });

    // A stranger's leave is the same 404 as any other non-member operation.
    assert.equal(
      (await api(linus, 'POST', `/api/documents/${documentId}/leave`)).status,
      404,
    );

    assert.deepEqual(await memberRows(documentId), [{ userId: 'demo-ada', role: 'owner' }]);
    assert.equal(await ownerCount(documentId), 1);
  });

  it('transfers ownership atomically: target becomes owner, caller becomes editor', async () => {
    const documentId = await createDocument();
    assert.equal((await invite(ada, documentId, 'grace@insighthub.test', 'editor')).status, 200);
    assert.equal((await invite(ada, documentId, 'linus@insighthub.test', 'viewer')).status, 200);

    const transfer = await api(ada, 'POST', `/api/documents/${documentId}/owner`, {
      userId: 'demo-grace',
    });
    assert.equal(transfer.status, 200);
    assert.deepEqual(await transfer.json(), { ownerId: 'demo-grace' });

    // Both sides changed role in one commit.
    assert.equal(await server.authz.roleFor(documentId, 'demo-ada'), 'editor');
    assert.equal(await server.authz.roleFor(documentId, 'demo-grace'), 'owner');
    assert.equal(await ownerCount(documentId), 1);

    // The old Owner is no longer allowed to manage members; the new one is.
    assert.equal((await api(ada, 'GET', membersPath(documentId))).status, 403);
    const listed = await listMembers(grace, documentId);
    assert.equal(listed.ownerId, 'demo-grace');
    assert.equal(
      listed.members.find((member) => member.userId === 'demo-ada')?.role,
      'editor',
    );

    // Transferring to a non-member is a 404; transferring to oneself is `already_owner`.
    assert.equal(
      (await api(grace, 'POST', `/api/documents/${documentId}/owner`, { userId: 'demo-unknown' }))
        .status,
      404,
    );
    const self = await api(grace, 'POST', `/api/documents/${documentId}/owner`, {
      userId: 'demo-grace',
    });
    assert.equal(self.status, 409);
    assert.deepEqual(await self.json(), { error: 'already_owner' });

    // Strict body: exactly one `userId` string.
    assert.equal(
      (await api(grace, 'POST', `/api/documents/${documentId}/owner`, { userId: 'demo-linus', x: 1 }))
        .status,
      400,
    );
    assert.equal(
      (await api(grace, 'POST', `/api/documents/${documentId}/owner`, { userId: '' })).status,
      400,
    );
    assert.equal(
      (await api(grace, 'POST', `/api/documents/${documentId}/owner`, { userId: 7 })).status,
      400,
    );

    // And back again: the transfer is symmetric, still with one owner.
    const back = await api(grace, 'POST', `/api/documents/${documentId}/owner`, {
      userId: 'demo-ada',
    });
    assert.equal(back.status, 200);
    assert.deepEqual(await back.json(), { ownerId: 'demo-ada' });
    assert.equal(await server.authz.roleFor(documentId, 'demo-ada'), 'owner');
    assert.equal(await server.authz.roleFor(documentId, 'demo-grace'), 'editor');
    assert.equal(await ownerCount(documentId), 1);
  });
});

/**
 * The same HTTP surface in **clerk mode**: an invite must resolve a registered `app_user.email`
 * (case-insensitively/trimmed), and the demo address book must not be addressable there.
 *
 * This is the end-to-end proof for `AppUserStore.findByEmail`; the unit test in
 * `app-user.test.ts` only proves the SQL, not that the member service asks it.
 */
describe('P0-2 member HTTP API — Clerk email directory', () => {
  const ADA: VerifiedIdentity = {
    clerkUserId: 'user_members_ada',
    email: 'members.ada@example.com',
    displayName: 'Ada Lovelace',
  };
  const GRACE: VerifiedIdentity = {
    clerkUserId: 'user_members_grace',
    email: 'Members.Grace@Example.com',
    displayName: 'Grace Hopper',
  };
  const ADA_COOKIE = 'clerk_session=members-ada';
  const GRACE_COOKIE = 'clerk_session=members-grace';
  const verifier = createFakeSessionVerifier(({ cookie }) => {
    if (cookie === ADA_COOKIE) return ADA;
    if (cookie === GRACE_COOKIE) return GRACE;
    return null;
  });

  let server: TestServer;

  before(async () => {
    server = await startTestServer({
      authMode: 'clerk',
      verifier,
      authorization: 'enforced',
      members: true,
    });
  });

  after(async () => {
    await server.close();
  });

  it('invites a registered Clerk user by app_user.email, case-insensitively', async () => {
    // Resolving the sessions first is also what creates the two `app_user` rows (the mapping is
    // written lazily by the identity resolver, exactly as in production).
    const adaSession = await fetch(`${server.httpUrl}/api/session`, {
      headers: { cookie: ADA_COOKIE },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(adaSession.status, 200);
    const adaId = ((await adaSession.json()) as { userId: string }).userId;

    const graceSession = await fetch(`${server.httpUrl}/api/session`, {
      headers: { cookie: GRACE_COOKIE },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(graceSession.status, 200);
    const graceId = ((await graceSession.json()) as { userId: string }).userId;

    const created = await fetch(`${server.httpUrl}/api/documents`, {
      method: 'POST',
      headers: { cookie: ADA_COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Clerk members' }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(created.status, 201);
    const documentId = ((await created.json()) as { documentId: string }).documentId;

    // Trimmed and differently cased than the stored profile: the directory normalises both.
    const invited = await fetch(`${server.httpUrl}/api/documents/${documentId}/members`, {
      method: 'POST',
      headers: { cookie: ADA_COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify({ email: '  members.grace@example.com ', role: 'editor' }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(invited.status, 200);
    const member = (await invited.json()) as MemberBody;
    assert.equal(member.userId, graceId, 'the invite resolved the internal app_user id');
    assert.equal(member.email, 'Members.Grace@Example.com', 'the stored profile is returned');
    assert.equal(member.name, 'Grace Hopper');

    const list = await fetch(`${server.httpUrl}/api/documents/${documentId}/members`, {
      headers: { cookie: ADA_COOKIE },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(list.status, 200);
    const body = (await list.json()) as MemberListBody;
    assert.equal(body.ownerId, adaId);
    assert.deepEqual(
      body.members.map((entry) => [entry.userId, entry.email, entry.role]),
      [
        [adaId, 'members.ada@example.com', 'owner'],
        [graceId, 'Members.Grace@Example.com', 'editor'],
      ].sort((left, right) => (String(left[0]) < String(right[0]) ? -1 : 1)),
    );

    // A well-formed but unregistered address is the single `user_not_found` body, and the demo
    // address book is deliberately not addressable in clerk mode.
    for (const email of ['missing@example.com', 'grace@insighthub.test']) {
      const rejected = await fetch(`${server.httpUrl}/api/documents/${documentId}/members`, {
        method: 'POST',
        headers: { cookie: ADA_COOKIE, 'content-type': 'application/json' },
        body: JSON.stringify({ email, role: 'viewer' }),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(rejected.status, 404, email);
      assert.deepEqual(await rejected.json(), { error: 'user_not_found' }, email);
    }
  });
});
