/**
 * The client half of the member API (`docs/agent-governance/P0-2-MEMBERS.md`).
 *
 * The server is implemented in parallel (A3), so these tests pin only what the client is
 * responsible for and cannot drift: the **exact method/path/body** of each frozen call, that the
 * session cookie is carried, that the `AbortSignal` reaches `fetch`, that the `GET` body is
 * validated before it becomes UI state, and that the server's `{ error }` code survives the
 * transport as a typed `MembersApiError` field.
 *
 * No fake members server is implemented here: the stubs answer a single frozen response and the
 * assertions are about the request the UI makes and the code it reads back. Server semantics
 * (who may do what, what a 409 means) belong to A3's suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MembersApiError,
  changeMemberRole,
  fetchMembers,
  inviteMember,
  leaveDocument,
  parseDocumentMembers,
  removeMember,
  transferOwner,
} from './membersApi.js';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly credentials: RequestCredentials | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function stubFetch(
  respond: (request: RecordedRequest) => Response | Promise<Response>,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init?.headers ?? {})) headers[name] = String(value);
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      credentials: init?.credentials,
      headers,
      body: init?.body,
    };
    requests.push(request);
    return respond(request);
  });
  return requests;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SIGNAL = (): AbortSignal => new AbortController().signal;

const MEMBERS_BODY = {
  members: [
    { userId: 'demo-ada', email: 'ada@insighthub.test', name: 'Ada Lovelace', role: 'owner' },
    { userId: 'demo-grace', email: 'grace@insighthub.test', name: 'Grace Hopper', role: 'editor' },
    {
      userId: 'demo-linus',
      email: 'linus@insighthub.test',
      name: 'Linus Torvalds',
      role: 'viewer',
    },
  ],
  ownerId: 'demo-ada',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchMembers', () => {
  it('GETs the encoded document path with the session cookie and parses the frozen body', async () => {
    const requests = stubFetch(() => jsonResponse(MEMBERS_BODY, 200));

    const result = await fetchMembers('demo doc/one', { signal: SIGNAL() });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe('/api/documents/demo%20doc%2Fone/members');
    expect(request?.method).toBe('GET');
    expect(request?.credentials).toBe('include');
    expect(request?.body).toBeUndefined();
    expect(result.ownerId).toBe('demo-ada');
    expect(result.members.map((member) => member.email)).toEqual([
      'ada@insighthub.test',
      'grace@insighthub.test',
      'linus@insighthub.test',
    ]);
    expect(result.members.map((member) => member.role)).toEqual(['owner', 'editor', 'viewer']);
  });

  it('rejects an unreadable body as `malformed` instead of rendering an empty list', async () => {
    for (const body of [
      {},
      { members: [] },
      { ownerId: 'demo-ada' },
      { members: 'nope', ownerId: 'demo-ada' },
      { members: [{ userId: 'u', email: 'e', name: 'n' }], ownerId: 'demo-ada' },
      { members: [{ userId: 'u', email: 'e', name: 'n', role: 'owner' }], ownerId: '' },
    ]) {
      stubFetch(() => jsonResponse(body, 200));
      await expect(fetchMembers('doc', { signal: SIGNAL() })).rejects.toMatchObject({
        name: 'MembersApiError',
        kind: 'malformed',
      });
    }
  });

  it('keeps the server status and code for an HTTP failure', async () => {
    stubFetch(() => jsonResponse({ error: 'forbidden' }, 403));
    const error = await fetchMembers('doc', { signal: SIGNAL() }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MembersApiError);
    expect(error as MembersApiError).toMatchObject({
      kind: 'http',
      status: 403,
      code: 'forbidden',
    });
  });

  it('never reaches the network when the signal is already aborted', async () => {
    const requests = stubFetch(() => jsonResponse(MEMBERS_BODY, 200));
    const controller = new AbortController();
    controller.abort();

    await expect(fetchMembers('doc', { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    });
    expect(requests).toHaveLength(0);
  });
});

describe('mutations: the frozen request shapes', () => {
  it('POSTs an invite with { email, role } and JSON content-type', async () => {
    const requests = stubFetch(() => jsonResponse({}, 200));

    await inviteMember(
      'demo-document',
      { email: 'grace@insighthub.test', role: 'commenter' },
      { signal: SIGNAL() },
    );

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe('/api/documents/demo-document/members');
    expect(request?.method).toBe('POST');
    expect(request?.credentials).toBe('include');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(request?.body))).toEqual({
      email: 'grace@insighthub.test',
      role: 'commenter',
    });
  });

  it('PATCHes one member role with { role } only', async () => {
    const requests = stubFetch(() => jsonResponse({}, 200));

    await changeMemberRole('demo-document', 'demo-grace', 'viewer', { signal: SIGNAL() });

    const request = requests[0];
    expect(request?.url).toBe('/api/documents/demo-document/members/demo-grace');
    expect(request?.method).toBe('PATCH');
    expect(JSON.parse(String(request?.body))).toEqual({ role: 'viewer' });
  });

  it('DELETEs one member with no body', async () => {
    const requests = stubFetch(() => new Response(null, { status: 204 }));

    await removeMember('demo-document', 'demo-linus', { signal: SIGNAL() });

    const request = requests[0];
    expect(request?.url).toBe('/api/documents/demo-document/members/demo-linus');
    expect(request?.method).toBe('DELETE');
    expect(request?.body).toBeUndefined();
    expect(request?.headers['content-type']).toBeUndefined();
  });

  it('also accepts a 200 with an empty body for a removal (no body is promised by the contract)', async () => {
    stubFetch(() => new Response('', { status: 200 }));

    await expect(
      removeMember('demo-document', 'demo-linus', { signal: SIGNAL() }),
    ).resolves.toBeUndefined();
  });

  it('POSTs the ownership transfer as { userId } to /owner', async () => {
    const requests = stubFetch(() => jsonResponse({}, 200));

    await transferOwner('demo-document', 'demo-grace', { signal: SIGNAL() });

    const request = requests[0];
    expect(request?.url).toBe('/api/documents/demo-document/owner');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({ userId: 'demo-grace' });
  });

  it('POSTs /leave with no body and accepts 204', async () => {
    const requests = stubFetch(() => new Response(null, { status: 204 }));

    await expect(leaveDocument('demo-document', { signal: SIGNAL() })).resolves.toBeUndefined();

    const request = requests[0];
    expect(request?.url).toBe('/api/documents/demo-document/leave');
    expect(request?.method).toBe('POST');
    expect(request?.body).toBeUndefined();
  });
});

describe('failure codes: the server code survives, no status is interpreted here', () => {
  it.each([
    { status: 404, code: 'user_not_found' },
    { status: 404, code: 'not_found' },
    { status: 403, code: 'forbidden' },
    { status: 409, code: 'already_owner' },
    { status: 409, code: 'owner_role_immutable' },
    { status: 409, code: 'owner_requires_transfer' },
    { status: 409, code: 'last_owner' },
  ])('carries HTTP $status $code on an invite', async ({ status, code }) => {
    stubFetch(() => jsonResponse({ error: code }, status));

    const error = await inviteMember(
      'demo-document',
      { email: 'nobody@insighthub.test', role: 'viewer' },
      { signal: SIGNAL() },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MembersApiError);
    expect(error as MembersApiError).toMatchObject({ kind: 'http', status, code });
  });

  it('maps a network failure without inventing a status', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const error = await fetchMembers('doc', { signal: SIGNAL() }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MembersApiError);
    expect((error as MembersApiError).kind).toBe('network');
    expect((error as MembersApiError).status).toBeUndefined();
  });

  it('maps an aborted in-flight request to `aborted`', async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      async (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const pending = fetchMembers('doc', { signal: controller.signal });

    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(seen?.aborted).toBe(true);
  });
});

describe('parseDocumentMembers', () => {
  it('accepts the frozen shape and only the four role values', () => {
    expect(parseDocumentMembers(MEMBERS_BODY)).toEqual(MEMBERS_BODY);
    for (const role of ['owner', 'editor', 'commenter', 'viewer']) {
      expect(
        parseDocumentMembers({
          ownerId: 'u1',
          members: [{ userId: 'u1', email: 'u1@insighthub.test', name: 'U', role }],
        }),
      ).not.toBeNull();
    }
  });

  it('rejects an unknown role, a duplicate shape drift and non-object roots', () => {
    for (const value of [
      null,
      [],
      'nope',
      { ownerId: 'u', members: [{ userId: 'u', email: 'e', name: 'n', role: 'admin' }] },
      { ownerId: 1, members: [] },
    ]) {
      expect(parseDocumentMembers(value)).toBeNull();
    }
  });
});
