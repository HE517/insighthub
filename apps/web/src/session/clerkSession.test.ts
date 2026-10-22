/**
 * The Clerk-mode server session read (M4 B2): `GET /api/session` → `{ userId, displayName }`.
 *
 * Two things are asserted that a happy-path test would miss:
 *
 * - the response is the **two-field** clerk shape; `expiresAt` must not be required (clerk mode has
 *   no server-tracked expiry, §18.2) and must not leak into the parsed identity when present;
 * - the request is cookie-carried only — `credentials: 'include'` and no `Authorization` header —
 *   which is what keeps the token out of JS (`docs/CONTRACTS.md` §17.2/§18.3).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchClerkServerSession, parseClerkServerIdentity } from './clerkSession.js';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly credentials: RequestCredentials | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function stubFetch(response: Response | (() => Promise<Response>)): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init?.headers ?? {})) headers[name] = String(value);
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      credentials: init?.credentials,
      headers,
      body: init?.body,
    });
    return typeof response === 'function' ? response() : response;
  });
  return requests;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CLERK_IDENTITY = { userId: 'internal-ada', displayName: 'Ada Lovelace' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseClerkServerIdentity', () => {
  it('accepts the two-field clerk body', () => {
    expect(parseClerkServerIdentity(CLERK_IDENTITY)).toEqual(CLERK_IDENTITY);
  });

  it('drops expiresAt — clerk mode has no server-tracked expiry', () => {
    const parsed = parseClerkServerIdentity({
      ...CLERK_IDENTITY,
      expiresAt: '2026-10-18T12:00:00.000Z',
    });
    expect(parsed).toEqual(CLERK_IDENTITY);
    expect(parsed === null ? null : Object.keys(parsed).sort()).toEqual(['displayName', 'userId']);
  });

  it('drops unknown fields, including a token', () => {
    const parsed = parseClerkServerIdentity({ ...CLERK_IDENTITY, token: 'secret-token-value' });
    expect(parsed).toEqual(CLERK_IDENTITY);
  });

  it('rejects anything that is not a complete identity', () => {
    const invalid: unknown[] = [
      null,
      undefined,
      'internal-ada',
      [],
      {},
      { ...CLERK_IDENTITY, userId: '' },
      { ...CLERK_IDENTITY, displayName: '' },
      { ...CLERK_IDENTITY, userId: 7 },
      { ...CLERK_IDENTITY, displayName: null },
    ];
    for (const value of invalid) {
      expect(parseClerkServerIdentity(value)).toBeNull();
    }
  });

  it('truncates a display name to the awareness bound', () => {
    expect(
      parseClerkServerIdentity({ ...CLERK_IDENTITY, displayName: 'x'.repeat(200) })?.displayName,
    ).toHaveLength(80);
  });
});

describe('fetchClerkServerSession', () => {
  it('reads GET /api/session with cookies, and no Authorization header', async () => {
    const requests = stubFetch(jsonResponse(CLERK_IDENTITY));

    await expect(fetchClerkServerSession()).resolves.toEqual(CLERK_IDENTITY);

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.url, '/api/session');
    assert.equal(request.method, 'GET');
    // Clerk's browser SDK stores its session in its own cookie; the only carrier is the cookie.
    assert.equal(request.credentials, 'include');
    assert.equal(request.headers['authorization'], undefined);
    assert.equal(request.body, undefined);
  });

  it('resolves null — never throws — on a 401 while Clerk is still settling', async () => {
    stubFetch(jsonResponse({ error: 'session_required' }, 401));
    await expect(fetchClerkServerSession()).resolves.toBeNull();
  });

  it('resolves null when the server is unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchClerkServerSession()).resolves.toBeNull();
  });

  it('resolves null when the body is not a usable identity', async () => {
    stubFetch(jsonResponse({ userId: 'internal-ada' }));
    await expect(fetchClerkServerSession()).resolves.toBeNull();
  });
});
