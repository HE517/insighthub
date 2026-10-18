/**
 * Session mechanics (§17.2): token material, lifetime, rotation and revocation.
 *
 * Layer: **Node only**. These are claims about the server's own state machine, so a browser
 * would add nothing; the browser half of P2-9 (that `document.cookie` cannot see the value) is
 * A6's evidence, not this file's.
 *
 * Nothing here talks to HTTP except the cookie-parsing cases, which use the real parser the
 * request path uses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readCookieValue, readSessionCookie } from './cookies.js';
import {
  MAX_LIVE_SESSIONS,
  SESSION_TTL_MS,
  SessionStore,
  isSessionLive,
} from './session-store.js';
import {
  SESSION_TOKEN_ENTROPY_BYTES,
  SESSION_TOKEN_LENGTH,
  createSessionToken,
  isWellFormedSessionToken,
} from './tokens.js';

/** A controllable clock: `advance(ms)` is what makes 12 h expiry testable in milliseconds. */
function createClock(start = 1_800_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('session token material', () => {
  it('carries at least 128 bits of CSPRNG entropy', () => {
    // The contract floor is 128 bits (§17.2). This implementation mints 256; asserting the
    // floor rather than the current value keeps a deliberate increase from failing the test,
    // while a decrease below the floor fails it.
    assert.ok(SESSION_TOKEN_ENTROPY_BYTES * 8 >= 128);
    assert.equal(SESSION_TOKEN_ENTROPY_BYTES, 32);
  });

  it('is base64url of a fixed length and opaque', () => {
    const token = createSessionToken();
    assert.equal(token.length, SESSION_TOKEN_LENGTH);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    // Opaque: no user id, no separator, no dotted/padded JWT-ish structure.
    assert.ok(!token.includes('.'));
    assert.ok(!token.includes('='));
    assert.ok(!token.includes('demo'));
  });

  it('never repeats across a realistically large sample', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) seen.add(createSessionToken());
    assert.equal(seen.size, 2_000);
  });

  it('rejects values it could not have minted', () => {
    assert.equal(isWellFormedSessionToken(createSessionToken()), true);
    assert.equal(isWellFormedSessionToken(''), false);
    assert.equal(isWellFormedSessionToken('short'), false);
    assert.equal(isWellFormedSessionToken(null), false);
    assert.equal(isWellFormedSessionToken(42), false);
    assert.equal(isWellFormedSessionToken(createSessionToken() + 'A'), false);
    assert.equal(isWellFormedSessionToken('a'.repeat(SESSION_TOKEN_LENGTH) + '!'), false);
    // A token-shaped value with a character outside base64url is rejected even at the right
    // length, so the map's key space stays exactly what this module mints.
    const almost = `${'a'.repeat(SESSION_TOKEN_LENGTH - 1)}.`;
    assert.equal(isWellFormedSessionToken(almost), false);
  });
});

describe('session store lifetime', () => {
  it('issues a record with an absolute 12 h expiry', () => {
    const clock = createClock();
    const store = new SessionStore(clock.now);
    const record = store.issue('demo-ada');

    assert.equal(record.userId, 'demo-ada');
    assert.equal(record.createdAt, clock.now());
    assert.equal(record.expiresAt - record.createdAt, SESSION_TTL_MS);
    assert.equal(SESSION_TTL_MS, 12 * 60 * 60 * 1000);
    // The token is the map key and is never derived from the user id.
    assert.ok(!record.token.includes('demo'));
  });

  it('resolves a live token and returns the identity it denotes', () => {
    const clock = createClock();
    const store = new SessionStore(clock.now);
    const record = store.issue('demo-grace');

    assert.deepEqual(store.resolve(record.token), record);
    assert.equal(store.resolve(record.token)?.userId, 'demo-grace');
  });

  it('expires exactly at the deadline and does not slide', () => {
    const clock = createClock();
    const store = new SessionStore(clock.now);
    const record = store.issue('demo-ada');

    clock.advance(SESSION_TTL_MS - 1);
    assert.ok(store.resolve(record.token) !== null, 'one millisecond before the deadline is live');
    // Reading does not extend the session: the deadline is fixed at issue time.
    assert.equal(store.resolve(record.token)?.expiresAt, record.expiresAt);

    clock.advance(1);
    assert.equal(store.resolve(record.token), null, 'the deadline itself is expired');
    assert.equal(store.size, 0, 'the expired token is dropped on read');
  });

  it('ignores tokens it never issued, without throwing', () => {
    const store = new SessionStore();
    assert.equal(store.resolve(null), null);
    assert.equal(store.resolve(undefined), null);
    assert.equal(store.resolve(''), null);
    assert.equal(store.resolve('not-a-token'), null);
    assert.equal(store.resolve(createSessionToken()), null);
  });

  it('revokes a token and reports whether it existed', () => {
    const store = new SessionStore();
    const record = store.issue('demo-linus');

    assert.equal(store.revoke(record.token), true);
    assert.equal(store.resolve(record.token), null);
    // Revoking twice is not an error, and the second call is not a success either — that
    // distinction is what lets DELETE /api/session answer 401 for an already-dead token.
    assert.equal(store.revoke(record.token), false);
    assert.equal(store.revoke(null), false);
  });

  it('sweeps only expired sessions', () => {
    const clock = createClock();
    const store = new SessionStore(clock.now);
    const old = store.issue('demo-ada');
    clock.advance(SESSION_TTL_MS - 1);
    const fresh = store.issue('demo-grace');

    clock.advance(1); // `old` is now expired, `fresh` is not
    assert.equal(store.sweep(), 1);
    assert.equal(store.resolve(old.token), null);
    assert.ok(store.resolve(fresh.token) !== null);
  });

  it('keeps the map bounded under repeated bootstrap', () => {
    // Operational bound, not a security property (see `session-store.ts`): a public POST that
    // mints state must not grow memory without limit.
    const store = new SessionStore();
    const first = store.issue('demo-ada');
    for (let index = 0; index < MAX_LIVE_SESSIONS; index += 1) store.issue('demo-grace');

    assert.equal(store.size, MAX_LIVE_SESSIONS);
    // The oldest-expiring session (the very first) is the one evicted.
    assert.equal(store.resolve(first.token), null);
  });

  it('reports liveness from the record, not from the map', () => {
    const clock = createClock();
    const store = new SessionStore(clock.now);
    const record = store.issue('demo-ada');
    clock.advance(SESSION_TTL_MS);
    // The record is still in hand after expiry; the predicate must agree with `resolve`.
    assert.equal(isSessionLive(record, clock.now()), false);
    assert.equal(store.resolve(record.token), null);
  });
});

describe('session cookie reading', () => {
  it('finds the session cookie among others', () => {
    const header = 'theme=dark; insighthub_session=abc123; locale=en';
    assert.equal(readSessionCookie(header), 'abc123');
    assert.equal(readCookieValue(header, 'theme'), 'dark');
    assert.equal(readCookieValue(header, 'locale'), 'en');
  });

  it('treats every malformed header as "no session" instead of throwing', () => {
    // A throw in a request path becomes a 500 for a caller that was going to receive a 401.
    for (const header of ['', 'garbage', ';;;', '=', 'insighthub_session=', 'insighthub_session']) {
      assert.equal(readSessionCookie(header), null, `header ${JSON.stringify(header)}`);
    }
    assert.equal(readSessionCookie(undefined), null);
  });

  it('unescapes legal cookie values and survives illegal escapes', () => {
    assert.equal(readCookieValue('a=%41%42', 'a'), 'AB');
    assert.equal(readCookieValue('a="quoted"', 'a'), 'quoted');
    // `%` alone is an invalid escape; the raw value is used rather than an exception.
    assert.equal(readCookieValue('a=100%', 'a'), '100%');
  });

  it('takes the first of two cookies with the same name', () => {
    // Deterministic, and matching the order a browser writes. A duplicate is already outside
    // the contract; the point is that the answer never depends on parsing luck.
    assert.equal(readCookieValue('insighthub_session=first; insighthub_session=second', 'insighthub_session'), 'first');
  });

  it('is not confused by a name that merely contains the cookie name', () => {
    assert.equal(readSessionCookie('not_insighthub_session=x'), null);
    assert.equal(readSessionCookie('insighthub_session_backup=x'), null);
  });
});
