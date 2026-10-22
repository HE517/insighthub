/**
 * Sign-out order (M4 B2 acceptance 3): Clerk `signOut()` **then** `DELETE /api/session`.
 *
 * The Clerk hook is represented by the function the component passes in (`useClerk().signOut`),
 * and `fetch` is stubbed, so the order is asserted without a browser, a Clerk tenant or a network.
 * This is also the regression test for `204 No Content` handling in `api.ts`: the frozen DELETE
 * answers `204` with no body, and a JSON parse of that empty body would turn a successful cleanup
 * into a failure.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearDemoSession, performSignOut } from './signOut.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('performSignOut', () => {
  it('calls Clerk signOut first, then DELETE /api/session', async () => {
    const order: string[] = [];
    const requests = stubFetch(() => {
      order.push('DELETE /api/session');
      return new Response(null, { status: 204 });
    });

    const signOut = vi.fn(async () => {
      order.push('clerk.signOut');
    });

    const result = await performSignOut({ signOut });

    assert.deepEqual(order, ['clerk.signOut', 'DELETE /api/session']);
    expect(result).toEqual({ clerkSignOutCompleted: true, demoCookieCleared: true });

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.url, '/api/session');
    assert.equal(request.method, 'DELETE');
    // The demo cookie is httpOnly; the browser must be allowed to carry it on the cleanup call.
    assert.equal(request.credentials, 'include');
    // No token is ever put in a header or a body by the client.
    assert.equal(request.headers['authorization'], undefined);
    assert.equal(request.body, undefined);
  });

  it('still attempts the cleanup when Clerk fails, and reports the failure', async () => {
    const order: string[] = [];
    const requests = stubFetch(() => {
      order.push('DELETE /api/session');
      return new Response(null, { status: 204 });
    });
    const signOut = vi.fn(async () => {
      order.push('clerk.signOut');
      throw new Error('clerk unavailable');
    });

    const result = await performSignOut({ signOut });

    expect(order).toEqual(['clerk.signOut', 'DELETE /api/session']);
    expect(result).toEqual({ clerkSignOutCompleted: false, demoCookieCleared: true });
    assert.equal(requests.length, 1);
  });

  it('does not throw when the cleanup itself fails', async () => {
    const requests = stubFetch(() => new Response(null, { status: 401 }));

    const result = await performSignOut({ signOut: async () => undefined });

    expect(result).toEqual({ clerkSignOutCompleted: true, demoCookieCleared: false });
    assert.equal(requests.length, 1);
  });

  it('uses the injected cleanup instead of HTTP when one is supplied', async () => {
    const clearDemoSessionSpy = vi.fn(async () => true);
    const requests = stubFetch(() => new Response(null, { status: 500 }));

    const result = await performSignOut({
      signOut: async () => undefined,
      clearDemoSession: clearDemoSessionSpy,
    });

    expect(clearDemoSessionSpy).toHaveBeenCalledTimes(1);
    expect(result.demoCookieCleared).toBe(true);
    assert.equal(requests.length, 0);
  });
});

describe('clearDemoSession', () => {
  it('treats 204 No Content as success (the frozen DELETE response)', async () => {
    const requests = stubFetch(() => new Response(null, { status: 204 }));
    await expect(clearDemoSession()).resolves.toBe(true);
    assert.equal(requests[0]?.method, 'DELETE');
  });

  it('treats 401 as "nothing to clear", not as an exception', async () => {
    stubFetch(() => new Response(null, { status: 401 }));
    await expect(clearDemoSession()).resolves.toBe(false);
  });

  it('resolves false when the server is unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(clearDemoSession()).resolves.toBe(false);
  });
});
