/**
 * The client session bootstrap: identity parsing, the single-flight request, and — most
 * importantly — **P2-9 from the client side**: this module must have no place to put a token.
 *
 * The assertions below stub `fetch`, `document` and `localStorage` on purpose. If the module ever
 * started reading or writing a cookie/storage to "remember" the session, these tests would fail
 * rather than let the habit in.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DEMO_USER_ID,
  bootstrapSession,
  parseSessionIdentity,
} from './bootstrap.js';
import { ensureSessionBootstrap, resetSessionBootstrapForTests } from './useServerSession.js';
import { fallbackPresenceUser, presenceUserFor } from '../user.js';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly credentials: RequestCredentials | undefined;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

const VALID_IDENTITY = {
  userId: 'demo-ada',
  displayName: 'Ada Lovelace',
  expiresAt: '2026-10-18T12:00:00.000Z',
};

/** Replace `fetch` and record what the module asked for. */
function stubFetch(response: Response | (() => Promise<Response>)): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init?.headers ?? {})) headers[name] = String(value);
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      credentials: init?.credentials,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers,
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

/**
 * Fail the test if anything reads or writes cookies / web storage.
 *
 * `document.cookie` is a getter/setter pair here, so *any* access is recorded instead of silently
 * doing nothing (a plain object would let a read pass unnoticed).
 */
function forbidBrowserStorage(): { cookieAccesses: () => number; storageWrites: () => number } {
  let cookieAccesses = 0;
  let storageWrites = 0;
  vi.stubGlobal('document', {
    get cookie(): string {
      cookieAccesses += 1;
      return '';
    },
    set cookie(_value: string) {
      cookieAccesses += 1;
    },
  });
  vi.stubGlobal('localStorage', {
    getItem: () => {
      storageWrites += 1;
      return null;
    },
    setItem: () => {
      storageWrites += 1;
    },
    removeItem: () => {
      storageWrites += 1;
    },
  });
  return { cookieAccesses: () => cookieAccesses, storageWrites: () => storageWrites };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSessionBootstrapForTests();
});

describe('parseSessionIdentity', () => {
  it('accepts the documented body shape', () => {
    expect(parseSessionIdentity(VALID_IDENTITY)).toEqual(VALID_IDENTITY);
  });

  it('rejects anything that is not a complete identity', () => {
    const invalid: unknown[] = [
      null,
      undefined,
      'demo-ada',
      [],
      {},
      { ...VALID_IDENTITY, userId: '' },
      { ...VALID_IDENTITY, displayName: '' },
      { ...VALID_IDENTITY, userId: 7 },
      { ...VALID_IDENTITY, displayName: null },
      { ...VALID_IDENTITY, expiresAt: 'not-a-date' },
    ];
    for (const value of invalid) {
      expect(parseSessionIdentity(value)).toBeNull();
    }
  });

  it('drops fields it does not know about, including a token', () => {
    // The server must never send one (§17.4). If it ever did, the client must not keep it — this
    // is the client half of P2-9, independent of the server half.
    const parsed = parseSessionIdentity({ ...VALID_IDENTITY, token: 'secret-token-value' });
    expect(parsed).toEqual(VALID_IDENTITY);
    expect(parsed === null ? null : Object.keys(parsed).sort()).toEqual([
      'displayName',
      'expiresAt',
      'userId',
    ]);
  });

  it('truncates a display name to the awareness bound', () => {
    // `awarenessUserSchema.name` is capped at 80 characters; a longer name would make the client's
    // own presence unpublishable (silently dropped by validation on the read side).
    const parsed = parseSessionIdentity({ ...VALID_IDENTITY, displayName: 'x'.repeat(200) });
    expect(parsed?.displayName.length).toBe(80);
  });
});

describe('bootstrapSession', () => {
  it('claims the default demo identity with credentials included', async () => {
    const requests = stubFetch(jsonResponse(VALID_IDENTITY));
    const identity = await bootstrapSession();

    expect(identity).toEqual(VALID_IDENTITY);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.url, '/api/session/bootstrap');
    assert.equal(request.method, 'POST');
    // The cookie is the only carrier (§17.2), so the browser must be allowed to send it.
    assert.equal(request.credentials, 'include');
    assert.deepEqual(request.body, { demoUserId: DEFAULT_DEMO_USER_ID });
    assert.equal(request.headers['content-type'], 'application/json');
  });

  it('claims exactly the identity it was asked to claim', async () => {
    const requests = stubFetch(jsonResponse({ ...VALID_IDENTITY, userId: 'demo-linus' }));
    const identity = await bootstrapSession({ demoUserId: 'demo-linus' });
    expect(identity?.userId).toBe('demo-linus');
    assert.deepEqual(requests[0]?.body, { demoUserId: 'demo-linus' });
  });

  it('resolves null — never throws — when the server refuses', async () => {
    stubFetch(jsonResponse({ error: 'invalid_demo_identity' }, 400));
    await expect(bootstrapSession()).resolves.toBeNull();
  });

  it('resolves null when the server is unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(bootstrapSession()).resolves.toBeNull();
  });

  it('resolves null when the body is not a usable identity', async () => {
    stubFetch(jsonResponse({ userId: 'demo-ada' }));
    await expect(bootstrapSession()).resolves.toBeNull();
  });

  it('never touches cookies or web storage (P2-9)', async () => {
    const access = forbidBrowserStorage();
    stubFetch(jsonResponse({ ...VALID_IDENTITY, token: 'secret-token-value' }));

    const identity = await bootstrapSession();

    expect(identity?.userId).toBe('demo-ada');
    // The token is `HttpOnly`: the module has no way to read it, and no place to keep it.
    assert.equal(access.cookieAccesses(), 0, 'the bootstrap must not read or write document.cookie');
    assert.equal(access.storageWrites(), 0, 'the bootstrap must not use web storage');
  });
});

describe('ensureSessionBootstrap', () => {
  it('asks the server once per page, even when called twice', async () => {
    // React StrictMode mounts effects twice; two bootstraps would be two rotations racing to
    // describe the same tab.
    const requests = stubFetch(jsonResponse(VALID_IDENTITY));
    const [first, second] = await Promise.all([
      ensureSessionBootstrap(),
      ensureSessionBootstrap(),
    ]);

    assert.equal(requests.length, 1);
    expect(first).toEqual(VALID_IDENTITY);
    expect(second).toEqual(first);
  });

  it('caches a failure too, so an offline page does not retry on every render', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts += 1;
      throw new TypeError('fetch failed');
    });

    await expect(ensureSessionBootstrap()).resolves.toBeNull();
    await expect(ensureSessionBootstrap()).resolves.toBeNull();
    assert.equal(attempts, 1);
  });
});

describe('presenceUserFor', () => {
  it('uses the server identity when there is one', () => {
    expect(presenceUserFor(VALID_IDENTITY)).toEqual({
      id: 'demo-ada',
      name: 'Ada Lovelace',
    });
  });

  it('falls back to the per-tab placeholder when there is none', () => {
    const fallback = fallbackPresenceUser();
    expect(presenceUserFor(null)).toEqual(fallback);
    expect(presenceUserFor(undefined)).toEqual(fallback);
    // Stable across calls: two renders must not produce two different names for one tab.
    expect(presenceUserFor(null)).toEqual(fallback);
    // The placeholder is a local id, not a roster id, so it can never be mistaken for one.
    expect(fallback.id.startsWith('local-')).toBe(true);
  });
});
