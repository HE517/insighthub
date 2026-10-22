/**
 * **M4 B4** — the `POST /api/session/bootstrap` rate limit, over the real HTTP surface.
 *
 * The limiter's mechanics (window reset, expiry sweep, key cap) are unit-tested in
 * `rate-limit.test.ts`; this file proves the **endpoint policy** on a real `createApp`:
 *
 * | # | Claim | Observable |
 * | --- | --- | --- |
 * | 1 | 10 requests in one window succeed and the 11th is `429 rate_limited` | status + frozen body + `Retry-After` |
 * | 2 | the refusal mints no session | no `Set-Cookie` |
 * | 3 | only bootstrap is limited | `/health` and `/api/session` answer normally afterwards |
 * | 4 | the limiter belongs to the app instance, not the process | a second harness is unaffected |
 * | 5 | `X-Forwarded-For` cannot reset the bucket | 11 varying headers still hit 429 |
 * | 6 | a CSRF-refused request does not consume quota | 10 foreign-origin 403s, then a real bootstrap succeeds |
 * | 7 | the limit runs before body parsing | a malformed 11th body is 429, not 400 |
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { setCookies, startHarness, type Harness } from '../authz/test-support.js';

const harnesses: Harness[] = [];

async function newHarness(): Promise<Harness> {
  const harness = await startHarness();
  harnesses.push(harness);
  return harness;
}

after(async () => {
  for (const harness of harnesses) await harness.close();
});

function request(harness: Harness, path: string, init: RequestInit = {}): Promise<Response> {
  // One request per connection: Node's `fetch` pools sockets process-wide, and a pooled socket
  // is a live handle that can outlive the server it points at (TOOLING-P2). Fresh connections
  // also keep this file's per-app assertions from sharing transport state.
  return harness.request(path, {
    ...init,
    headers: { connection: 'close', ...((init.headers as Record<string, string>) ?? {}) },
    signal: AbortSignal.timeout(5_000),
  });
}

const JSON_BODY = { 'content-type': 'application/json' };

function postBootstrap(
  harness: Harness,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return request(harness, '/api/session/bootstrap', {
    method: 'POST',
    headers: { ...JSON_BODY, ...options.headers },
    body: options.body ?? JSON.stringify({ demoUserId: 'demo-ada' }),
  });
}

describe('bootstrap rate limit — 10 per client per minute', () => {
  it('allows ten requests and answers the eleventh with 429 rate_limited', async () => {
    const harness = await newHarness();

    for (let index = 1; index <= 10; index += 1) {
      const response = await postBootstrap(harness);
      assert.equal(response.status, 200, `request ${index} must be allowed`);
      assert.equal(response.headers.get('retry-after'), null, 'a success needs no Retry-After');
      await response.text();
    }

    const limited = await postBootstrap(harness);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });
    const retryAfter = Number(limited.headers.get('retry-after'));
    assert.ok(
      Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60,
      `Retry-After must be a whole number of seconds within the window, got ${retryAfter}`,
    );
  });

  it('mints no session when the window is exhausted', async () => {
    const harness = await newHarness();
    for (let index = 0; index < 10; index += 1) {
      const response = await postBootstrap(harness);
      await response.text();
    }

    const limited = await postBootstrap(harness);
    assert.equal(limited.status, 429);
    assert.equal(setCookies(limited).length, 0, 'a rate-limited bootstrap must not issue a cookie');
    await limited.text();
  });

  it('does not limit any other route', async () => {
    const harness = await newHarness();
    for (let index = 0; index < 10; index += 1) {
      const response = await postBootstrap(harness);
      await response.text();
    }
    const exhausted = await postBootstrap(harness);
    assert.equal(exhausted.status, 429);
    await exhausted.text();

    const health = await request(harness, '/health');
    assert.equal(health.status, 200);
    await health.text();

    const session = await request(harness, '/api/session');
    assert.equal(session.status, 401, 'the normal 401 semantics are untouched by the limiter');
    await session.text();
  });

  it('is per application, so a second server in the same process has its own window', async () => {
    const first = await newHarness();
    const second = await newHarness();

    for (let index = 0; index < 10; index += 1) {
      const response = await postBootstrap(first);
      await response.text();
    }
    const exhausted = await postBootstrap(first);
    assert.equal(exhausted.status, 429);
    await exhausted.text();

    const unaffected = await postBootstrap(second);
    assert.equal(unaffected.status, 200, 'a module-level bucket would have leaked across apps');
    await unaffected.text();
  });

  it('does not honour X-Forwarded-For (a caller cannot rotate its way out)', async () => {
    const harness = await newHarness();

    for (let index = 0; index < 10; index += 1) {
      const response = await postBootstrap(harness, {
        headers: { 'x-forwarded-for': `203.0.113.${index}` },
      });
      assert.equal(response.status, 200, `request ${index} must be allowed`);
      await response.text();
    }

    const limited = await postBootstrap(harness, {
      headers: { 'x-forwarded-for': '203.0.113.250' },
    });
    assert.equal(limited.status, 429, 'the socket address is the key; the header is ignored');
    await limited.text();
  });

  it('does not count a CSRF refusal against the window', async () => {
    const harness = await newHarness();

    // Ten requests from a foreign origin: all refused by the origin guard before the limiter.
    for (let index = 0; index < 10; index += 1) {
      const refused = await postBootstrap(harness, { headers: { origin: 'https://evil.example' } });
      assert.equal(refused.status, 403);
      await refused.text();
    }

    const allowed = await postBootstrap(harness);
    assert.equal(allowed.status, 200, 'the 403s never reached the limiter');
    await allowed.text();
  });

  it('limits before parsing, so a malformed body cannot bypass the window', async () => {
    const harness = await newHarness();
    for (let index = 0; index < 10; index += 1) {
      const response = await postBootstrap(harness);
      await response.text();
    }

    const limited = await postBootstrap(harness, { body: '{ not json' });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: 'rate_limited' });
  });
});
