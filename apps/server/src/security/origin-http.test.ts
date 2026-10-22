/**
 * **M4 B4** — CORS and CSRF on the real HTTP surface
 * (`docs/CONTRACTS.md` §18.3/§18.4/§18.6; D-082 D1/D2).
 *
 * Everything here runs through the **production** `createApp` on a real HTTP server with a real
 * `authz.db`; no middleware is stubbed. The claims:
 *
 * | # | Claim | Observable |
 * | --- | --- | --- |
 * | 1 | an allowed origin gets `ACAO: <origin>`, `ACAC: true` and `Vary: Origin` | response headers |
 * | 2 | a preflight from an allowed origin answers `204` with the methods and `content-type` | status + headers |
 * | 3 | a state-changing request from a foreign origin is `403 origin_not_allowed` | status + body, no cookie |
 * | 4 | that refusal happens **before routing** (an unknown path is 403, not 404) | status |
 * | 5 | a foreign origin cannot mutate state with a valid session | session survives a refused DELETE |
 * | 6 | a foreign origin's **safe** request still runs, with no ACAO (the browser blocks it) | 200, no ACAO |
 * | 7 | a request with no `Origin` is allowed (non-browser client) | 200, no ACAO |
 * | 8 | the loopback alias the real-browser suite uses is accepted | 200 + ACAO echo |
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  TEST_CORS_ORIGIN,
  bootstrap,
  getWithSession,
  setCookies,
  startHarness,
  type Harness,
} from '../authz/test-support.js';

const FOREIGN_ORIGIN = 'https://evil.example';
const ALIAS_ORIGIN = 'http://127.0.0.1:5173';

const harnesses: Harness[] = [];

async function newHarness(): Promise<Harness> {
  const harness = await startHarness();
  harnesses.push(harness);
  return harness;
}

after(async () => {
  for (const harness of harnesses) await harness.close();
});

/** A fetch that can never hang the gate (`docs/TASKS.md` TOOLING-P2). */
function request(harness: Harness, path: string, init: RequestInit = {}): Promise<Response> {
  return harness.request(path, {
    ...init,
    // One request per connection: a pooled keep-alive socket can outlive the server it points
    // at, and the CORS assertions are about one request's headers anyway.
    headers: { connection: 'close', ...((init.headers as Record<string, string>) ?? {}) },
    signal: AbortSignal.timeout(5_000),
  });
}

const JSON_BODY = { 'content-type': 'application/json' };

function postBootstrap(harness: Harness, origin?: string): Promise<Response> {
  return request(harness, '/api/session/bootstrap', {
    method: 'POST',
    headers: origin === undefined ? JSON_BODY : { ...JSON_BODY, origin },
    body: JSON.stringify({ demoUserId: 'demo-ada' }),
  });
}

function assertVaryOrigin(response: Response): void {
  const vary = (response.headers.get('vary') ?? '').toLowerCase();
  assert.ok(vary.includes('origin'), `Vary must include Origin, got ${JSON.stringify(vary)}`);
}

describe('§B4 CORS — the allowed origin', () => {
  it('echoes the origin with credentials and Vary: Origin on an actual request', async () => {
    const harness = await newHarness();
    const response = await request(harness, '/health', { headers: { origin: TEST_CORS_ORIGIN } });
    await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), TEST_CORS_ORIGIN);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assertVaryOrigin(response);
  });

  it('answers a preflight with 204 and the advertised methods/headers', async () => {
    const harness = await newHarness();
    const response = await request(harness, '/api/session', {
      method: 'OPTIONS',
      headers: {
        origin: TEST_CORS_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    await response.text();

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), TEST_CORS_ORIGIN);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    const methods = response.headers.get('access-control-allow-methods') ?? '';
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'GET', 'OPTIONS']) {
      assert.ok(methods.split(',').includes(method), `allowed methods must include ${method}`);
    }
    assert.equal(response.headers.get('access-control-allow-headers'), 'content-type');
    assertVaryOrigin(response);
  });

  it('applies to a real state-changing request (bootstrap sets its cookie)', async () => {
    const harness = await newHarness();
    const response = await postBootstrap(harness, TEST_CORS_ORIGIN);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), TEST_CORS_ORIGIN);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(setCookies(response).length, 1, 'the session cookie is issued normally');
    await response.text();
  });

  it('accepts the loopback alias the real-browser suite connects from', async () => {
    // The dev stack binds Vite to 127.0.0.1 while CORS_ORIGIN defaults to localhost; a browser
    // sends the literal page origin. `security/origin.ts` documents why this is one origin.
    const harness = await newHarness();
    const response = await postBootstrap(harness, ALIAS_ORIGIN);

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      ALIAS_ORIGIN,
      'the ACAO must echo the request origin, not the configured spelling',
    );
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    await response.text();
  });
});

describe('§B4 CSRF — a foreign Origin', () => {
  it('refuses a state-changing request with 403 origin_not_allowed and no cookie', async () => {
    const harness = await newHarness();
    const response = await postBootstrap(harness, FOREIGN_ORIGIN);

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'origin_not_allowed' });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(setCookies(response).length, 0, 'a refused request must not mint a session');
    assertVaryOrigin(response);
  });

  it('refuses every state-changing method before routing', async () => {
    const harness = await newHarness();

    // Unknown path: without the guard this would be the M0 `404 not_found`.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await request(harness, '/nope/unknown', {
        method,
        headers: originHeader(FOREIGN_ORIGIN),
      });
      assert.equal(response.status, 403, method);
      assert.deepEqual(await response.json(), { error: 'origin_not_allowed' }, method);
    }
  });

  it('refuses a preflight from a foreign origin with 403', async () => {
    const harness = await newHarness();
    const response = await request(harness, '/api/session', {
      method: 'OPTIONS',
      headers: {
        origin: FOREIGN_ORIGIN,
        'access-control-request-method': 'POST',
      },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'origin_not_allowed' });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  it('cannot mutate state with a valid session (a forged-origin DELETE is refused)', async () => {
    const harness = await newHarness();
    const session = await bootstrap(harness, 'demo-ada');

    const refused = await request(harness, '/api/session', {
      method: 'DELETE',
      headers: { ...originHeader(FOREIGN_ORIGIN), cookie: session.cookie },
    });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: 'origin_not_allowed' });
    assert.equal(setCookies(refused).length, 0);

    // The session is untouched: the refusal happened before the handler.
    const stillValid = await getWithSession(harness, '/api/session', session.cookie);
    assert.equal(stillValid.status, 200);
    await stillValid.text();
  });

  it('still serves a safe method, but without ACAO so the browser blocks the read', async () => {
    const harness = await newHarness();
    const response = await request(harness, '/health', { headers: originHeader(FOREIGN_ORIGIN) });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assertVaryOrigin(response);
  });
});

describe('§B4 — requests with no Origin are not browser requests', () => {
  it('allows a non-browser client, with no CORS headers', async () => {
    const harness = await newHarness();

    const bootstrapResponse = await postBootstrap(harness);
    assert.equal(bootstrapResponse.status, 200, 'no Origin means no CSRF surface');
    assert.equal(bootstrapResponse.headers.get('access-control-allow-origin'), null);
    assert.equal(setCookies(bootstrapResponse).length, 1);
    await bootstrapResponse.text();

    const health = await request(harness, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('access-control-allow-origin'), null);
    await health.text();
  });
});

/** A header record with just an Origin, typed for `RequestInit`. */
function originHeader(origin: string): Record<string, string> {
  return { origin };
}
