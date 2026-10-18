/**
 * The HTTP surface of §17.4, over a real server and a real `authz.db`.
 *
 * Covers:
 *
 * - the five endpoints and their status codes (including `403` never being reachable on the
 *   production `GET /api/documents/:id`, which only requires `canRead`);
 * - **P2-3** — the non-disclosure rule, asserted on status, body **and** headers;
 * - **P2-9** — no token in any response body, `HttpOnly` on the cookie, and no `Set-Cookie`
 *   except where the contract issues one;
 * - §17.2's single carrier — an `Authorization` header and a differently-named cookie are ignored;
 * - CORS with `credentials: true` and an explicit origin (never `*`).
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { DEMO_DOCUMENTS } from './demo-fixture.js';
import {
  TEST_CORS_ORIGIN,
  bootstrap,
  comparableHeaders,
  getWithSession,
  setCookies,
  startHarness,
  type Harness,
} from './test-support.js';
import { SESSION_TTL_MS } from './session-store.js';
import { createApp } from '../app.js';
import { type ServerConfig } from '../config.js';

const harnesses: Harness[] = [];

async function newHarness(
  options: Parameters<typeof startHarness>[0] = {},
): Promise<Harness> {
  const harness = await startHarness(options);
  harnesses.push(harness);
  return harness;
}

after(async () => {
  for (const harness of harnesses) await harness.close();
});

const JSON_BODY = { 'content-type': 'application/json' };

function postBootstrap(harness: Harness, body: unknown, cookie?: string): Promise<Response> {
  return harness.request('/api/session/bootstrap', {
    method: 'POST',
    headers: cookie === undefined ? JSON_BODY : { ...JSON_BODY, cookie },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/session/bootstrap', () => {
  it('issues a session with the frozen body shape and cookie attributes', async () => {
    const harness = await newHarness();
    const response = await postBootstrap(harness, { demoUserId: 'demo-ada' });

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    // Exactly the three documented fields: an extra field is how a token would leak.
    assert.deepEqual(Object.keys(body).sort(), ['displayName', 'expiresAt', 'userId']);
    assert.equal(body['userId'], 'demo-ada');
    assert.equal(body['displayName'], 'Ada Lovelace');
    assert.equal(typeof body['expiresAt'], 'string');
    assert.ok(Number.isFinite(Date.parse(body['expiresAt'] as string)));

    const cookies = setCookies(response);
    assert.equal(cookies.length, 1, 'exactly one session cookie');
    const header = cookies[0] as string;
    assert.match(header, /^insighthub_session=/);
    // §17.2 cookie attributes.
    assert.match(header, /;\s*HttpOnly/i);
    assert.match(header, /;\s*SameSite=Lax/i);
    assert.match(header, /;\s*Path=\//i);
    // Lifetime matches the server-side expiry exactly.
    assert.match(header, new RegExp(`;\\s*Max-Age=${SESSION_TTL_MS / 1000}(;|$)`));
    // Not over TLS in this harness, so no `Secure` attribute.
    assert.ok(!/;\s*Secure/i.test(header), 'Secure must only appear over TLS');
  });

  it('rejects an unknown or malformed demo identity with 400', async () => {
    const harness = await newHarness();
    const cases: unknown[] = [
      { demoUserId: 'demo-nobody' },
      { demoUserId: '' },
      { demoUserId: 42 },
      {},
      [],
      'not an object',
      // P2-2: a self-declared `userId` is not a demo identity and is not honoured.
      { userId: 'demo-ada' },
    ];

    for (const body of cases) {
      const response = await postBootstrap(harness, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), { error: 'invalid_demo_identity' });
      assert.equal(setCookies(response).length, 0, 'a refusal must not issue a cookie');
    }
  });

  it('answers an unparseable body with the endpoint\'s own 400 instead of a stack trace', async () => {
    const harness = await newHarness();
    const response = await postBootstrap(harness, '{ not json');
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_demo_identity' });
  });

  it('rotates: a second bootstrap invalidates the previous token for that client', async () => {
    const harness = await newHarness();
    const first = await bootstrap(harness, 'demo-ada');
    assert.equal((await getWithSession(harness, '/api/session', first.cookie)).status, 200);

    const secondResponse = await postBootstrap(harness, { demoUserId: 'demo-ada' }, first.cookie);
    assert.equal(secondResponse.status, 200);
    const rotatedCookie = (setCookies(secondResponse)[0] as string).split(';')[0] as string;
    assert.notEqual(rotatedCookie, first.cookie, 'a new token must be minted');

    // The old token is dead everywhere (§17.2).
    assert.equal((await getWithSession(harness, '/api/session', first.cookie)).status, 401);
    assert.equal((await getWithSession(harness, '/api/documents', first.cookie)).status, 401);
    // The new one works.
    assert.equal((await getWithSession(harness, '/api/session', rotatedCookie)).status, 200);
  });
});

describe('GET / DELETE /api/session', () => {
  it('requires a session and returns the identity it denotes', async () => {
    const harness = await newHarness();

    const anonymous = await harness.request('/api/session');
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), { error: 'unauthenticated' });

    const session = await bootstrap(harness, 'demo-grace');
    const authenticated = await getWithSession(harness, '/api/session', session.cookie);
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), {
      userId: 'demo-grace',
      displayName: 'Grace Hopper',
      expiresAt: session.expiresAt,
    });
  });

  it('destroys the session and clears the cookie', async () => {
    const harness = await newHarness();
    const session = await bootstrap(harness, 'demo-ada');

    const deleted = await harness.request('/api/session', {
      method: 'DELETE',
      headers: { cookie: session.cookie },
    });
    assert.equal(deleted.status, 204);
    const clearHeader = setCookies(deleted)[0] as string;
    assert.match(clearHeader, /^insighthub_session=;/, 'the cookie is emptied');
    assert.match(clearHeader, /;\s*HttpOnly/i);

    // A destroyed token is 401 everywhere (§17.2).
    for (const path of ['/api/session', '/api/documents', '/api/documents/demo-document']) {
      assert.equal((await getWithSession(harness, path, session.cookie)).status, 401, path);
    }

    // A second DELETE is not a success.
    const again = await harness.request('/api/session', {
      method: 'DELETE',
      headers: { cookie: session.cookie },
    });
    assert.equal(again.status, 401);
    assert.equal(setCookies(again).length, 0);
  });

  it('rejects an expired session everywhere', async () => {
    let current = 1_800_000_000_000;
    const harness = await newHarness({ now: () => current });
    const session = await bootstrap(harness, 'demo-ada');
    assert.equal((await getWithSession(harness, '/api/session', session.cookie)).status, 200);

    current += SESSION_TTL_MS;
    for (const path of ['/api/session', '/api/documents', '/api/documents/demo-document']) {
      assert.equal((await getWithSession(harness, path, session.cookie)).status, 401, path);
    }
  });
});

describe('P2-9 — the token never reaches a JS-reachable place', () => {
  it('appears in no response body, on any endpoint', async () => {
    const harness = await newHarness();
    const session = await bootstrap(harness, 'demo-ada');

    const responses: Array<{ readonly label: string; readonly response: Response }> = [
      { label: 'GET /api/session', response: await getWithSession(harness, '/api/session', session.cookie) },
      { label: 'GET /api/documents', response: await getWithSession(harness, '/api/documents', session.cookie) },
      {
        label: 'GET /api/documents/:id (200)',
        response: await getWithSession(harness, '/api/documents/demo-document', session.cookie),
      },
      {
        label: 'GET /api/documents/:id (404)',
        response: await getWithSession(harness, '/api/documents/no-such-document', session.cookie),
      },
      { label: 'GET /api/session (401)', response: await harness.request('/api/session') },
      { label: 'GET /api/meta', response: await harness.request('/api/meta') },
      { label: 'GET /health', response: await harness.request('/health') },
    ];

    for (const { label, response } of responses) {
      const text = await response.text();
      assert.ok(!text.includes(session.token), `${label} leaked the token`);
      // Also assert the field name does not appear, so a future endpoint cannot add `token`
      // to a body without failing here.
      assert.ok(!/"token"/.test(text), `${label} exposed a "token" field`);
    }
  });

  it('issues a Set-Cookie only where the contract does', async () => {
    const harness = await newHarness();
    const session = await bootstrap(harness, 'demo-ada');

    // Reads never re-issue, extend or refresh the cookie.
    for (const path of ['/api/session', '/api/documents', '/api/documents/demo-document']) {
      const response = await getWithSession(harness, path, session.cookie);
      assert.equal(setCookies(response).length, 0, `${path} must not set a cookie`);
    }
    // Neither do the refusals.
    const unauthenticated = await harness.request('/api/documents');
    assert.equal(setCookies(unauthenticated).length, 0);
    const notFound = await getWithSession(harness, '/api/documents/nope', session.cookie);
    assert.equal(setCookies(notFound).length, 0);
  });
});

describe('P2-3 — non-disclosure: one answer for three caller states', () => {
  it('answers 404 identically for unknown document and no membership', async () => {
    const harness = await newHarness();
    const ada = await bootstrap(harness, 'demo-ada');
    const grace = await bootstrap(harness, 'demo-grace');
    const linus = await bootstrap(harness, 'demo-linus');

    // Three different caller states, all of which must be indistinguishable:
    //  1. the document does not exist at all;
    //  2. the document exists and the caller has no membership row;
    //  3. the document exists and the caller has no membership row (a second document, so the
    //     answer cannot depend on one hardcoded id).
    //
    // `docs/CONTRACTS.md` §17.4 also lists "no `canRead`" as a third state. With the frozen role
    // ladder that state is not constructible over HTTP: `viewer` is the least privileged role and
    // it already holds `canRead`, so "a membership without read" cannot exist. The decision core
    // keeps `!canRead(role)` in the same branch for defence in depth (`authz.ts`), and this test
    // documents why no HTTP case can be built for it instead of pretending otherwise.
    const cases = [
      { label: 'unknown document', cookie: ada.cookie, path: '/api/documents/no-such-document' },
      { label: 'no membership', cookie: grace.cookie, path: '/api/documents/demo-private-notes' },
      { label: 'no membership (2)', cookie: linus.cookie, path: '/api/documents/demo-team-notes' },
    ] as const;

    const observed: Array<{ headers: Record<string, string>; body: string; status: number }> = [];
    for (const testCase of cases) {
      const response = await getWithSession(harness, testCase.path, testCase.cookie);
      observed.push({
        status: response.status,
        headers: comparableHeaders(response),
        body: await response.text(),
      });
    }

    for (const [index, entry] of observed.entries()) {
      const label = cases[index]?.label ?? 'case';
      assert.equal(entry.status, 404, label);
      assert.equal(entry.body, '{"error":"not_found"}', `${label}: body must be identical`);
      assert.equal(entry.headers['content-type'], 'application/json; charset=utf-8');
      // Body-derived headers must match, otherwise a caller could distinguish the cases.
      assert.equal(entry.headers['content-length'], observed[0]?.headers['content-length'], label);
      assert.equal(entry.headers['etag'], observed[0]?.headers['etag'], label);
      assert.equal(entry.headers['set-cookie'], undefined, `${label}: no cookie`);
    }

    // Whole-header comparison, minus `date` (a clock reading, explained in `comparableHeaders`).
    assert.deepEqual(observed[1]?.headers, observed[0]?.headers);
    assert.deepEqual(observed[2]?.headers, observed[0]?.headers);
  });

  it('answers 401 before it considers the document', async () => {
    const harness = await newHarness();
    // No session: the same answer for an existing document and a nonexistent one. A 404 here
    // would already leak that the caller's own identity was irrelevant.
    for (const path of ['/api/documents/demo-document', '/api/documents/no-such-document']) {
      const response = await harness.request(path);
      assert.equal(response.status, 401, path);
      assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    }
  });

  it('never answers 403 on the read endpoint: the only thing it requires is canRead', async () => {
    // §17.4's 403 is "canRead holds but the action needs more". A read needs exactly `canRead`,
    // so this endpoint has no 403 path; the mapping itself is proven in
    // `capability-matrix.test.ts` through the same production handler factory.
    const harness = await newHarness();
    for (const userId of ['demo-ada', 'demo-grace', 'demo-linus']) {
      const session = await bootstrap(harness, userId);
      for (const document of DEMO_DOCUMENTS) {
        const response = await getWithSession(
          harness,
          `/api/documents/${document.id}`,
          session.cookie,
        );
        assert.ok(
          response.status === 200 || response.status === 404,
          `${userId} on ${document.id}: ${response.status}`,
        );
      }
    }
  });
});

describe('§17.2 — the cookie is the only carrier', () => {
  it('ignores an Authorization header and a differently-named cookie', async () => {
    const harness = await newHarness();
    const session = await bootstrap(harness, 'demo-ada');

    const viaAuthorization = await harness.request('/api/session', {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(viaAuthorization.status, 401, 'there is no Authorization header path in Phase 2');

    const viaOtherCookie = await harness.request('/api/session', {
      headers: { cookie: `session=${session.token}` },
    });
    assert.equal(viaOtherCookie.status, 401, 'only `insighthub_session` is read');

    const viaQuery = await harness.request(`/api/session?token=${session.token}`);
    assert.equal(viaQuery.status, 401, 'a query parameter is not a session');
  });
});

describe('CORS', () => {
  it('allows the configured origin with credentials, and never `*`', async () => {
    const harness = await newHarness();
    const preflight = await harness.request('/api/session', {
      method: 'OPTIONS',
      headers: {
        origin: TEST_CORS_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    assert.ok(preflight.status === 204 || preflight.status === 200);
    assert.equal(preflight.headers.get('access-control-allow-origin'), TEST_CORS_ORIGIN);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.notEqual(preflight.headers.get('access-control-allow-origin'), '*');

    // The same on an actual request, because a browser needs the header on the response it reads.
    const actual = await harness.request('/health', { headers: { origin: TEST_CORS_ORIGIN } });
    assert.equal(actual.headers.get('access-control-allow-origin'), TEST_CORS_ORIGIN);
    assert.equal(actual.headers.get('access-control-allow-credentials'), 'true');
  });

  it('refuses to start with a wildcard origin', () => {
    const config: ServerConfig = {
      port: 0,
      host: '127.0.0.1',
      corsOrigin: '*',
      wsPath: '/ws',
    };
    // `*` with credentials is illegal for browsers, and "fix it by dropping credentials" would
    // silently disable the session cookie. Fail at construction instead.
    assert.throws(() => createApp(config), /CORS_ORIGIN/);
  });
});

describe('unchanged M0 behaviour', () => {
  it('keeps the unknown-path 404 shape', async () => {
    const harness = await newHarness();
    const response = await harness.request('/nope');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });

  it('does not advertise the server implementation', async () => {
    const harness = await newHarness();
    const response = await harness.request('/health');
    assert.equal(response.headers.get('x-powered-by'), null);
  });
});
