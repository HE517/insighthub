/**
 * **M4 B4** — the origin allow-list decision itself (`docs/CONTRACTS.md` §18.3/§18.4).
 *
 * These are pure-function tests: the HTTP guard and the WebSocket upgrade both call
 * `isAllowedOrigin`, so proving the matcher here keeps the two transports from drifting.
 *
 * | # | Claim |
 * | --- | --- |
 * | 1 | the configured origin is allowed verbatim |
 * | 2 | `localhost` / `127.0.0.1` / `[::1]` are the same origin **only** at the same scheme and port |
 * | 3 | a foreign origin, a different port, a different scheme and a malformed value are refused |
 * | 4 | an absent/blank `Origin` reads as "no Origin" (the non-browser case) |
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAllowedOrigin, isStateChangingMethod, readOriginHeader } from './origin.js';

const CONFIGURED = 'http://localhost:5173';

describe('isAllowedOrigin — the configured origin (§B4)', () => {
  it('allows the configured origin exactly', () => {
    assert.equal(isAllowedOrigin(CONFIGURED, CONFIGURED), true);
    assert.equal(isAllowedOrigin('https://app.example.com', 'https://app.example.com'), true);
  });

  it('treats loopback spellings as the same origin at the same scheme and port', () => {
    // The documented dev origin is `localhost`; the Vite dev server and the real-browser suite
    // use `127.0.0.1` (apps/web/vite.config.ts). One machine, one port, two spellings.
    assert.equal(isAllowedOrigin(CONFIGURED, 'http://127.0.0.1:5173'), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:5173', 'http://localhost:5173'), true);
    assert.equal(isAllowedOrigin('http://[::1]:5173', 'http://localhost:5173'), true);
  });

  it('does not extend the alias across the port or the scheme', () => {
    assert.equal(isAllowedOrigin(CONFIGURED, 'http://127.0.0.1:5174'), false);
    assert.equal(isAllowedOrigin(CONFIGURED, 'https://localhost:5173'), false);
    assert.equal(isAllowedOrigin('https://app.example.com', 'https://127.0.0.1:443'), false);
  });

  it('refuses a different host, including a subdomain of the configured one', () => {
    assert.equal(isAllowedOrigin(CONFIGURED, 'http://localhost:5173.evil.example'), false);
    assert.equal(isAllowedOrigin(CONFIGURED, 'https://evil.example'), false);
    assert.equal(isAllowedOrigin('https://app.example.com', 'https://app.example.com.evil'), false);
  });

  it('refuses a malformed value, a path, credentials and the `null` origin', () => {
    assert.equal(isAllowedOrigin(CONFIGURED, 'null'), false);
    assert.equal(isAllowedOrigin(CONFIGURED, 'not an origin'), false);
    assert.equal(isAllowedOrigin(CONFIGURED, 'http://user:pass@localhost:5173'), false);
    // A configured value with a path is not a bare origin; it must not match a bare request
    // origin through the loopback branch either.
    assert.equal(isAllowedOrigin('http://localhost:5173/app', 'http://127.0.0.1:5173'), false);
  });

  it('refuses everything when the configured origin is blank', () => {
    assert.equal(isAllowedOrigin('', CONFIGURED), false);
    assert.equal(isAllowedOrigin('   ', CONFIGURED), false);
  });
});

describe('readOriginHeader — a non-browser client has no Origin', () => {
  it('returns undefined for an absent or blank header', () => {
    assert.equal(readOriginHeader(undefined), undefined);
    assert.equal(readOriginHeader(''), undefined);
    assert.equal(readOriginHeader('   '), undefined);
  });

  it('returns the trimmed value', () => {
    assert.equal(readOriginHeader(`  ${CONFIGURED}  `), CONFIGURED);
  });

  it('keeps a duplicate header as one unmatchable value', () => {
    // Node joins duplicate headers with ", "; no configured origin equals that string, so the
    // request is refused rather than silently matching its first half.
    assert.equal(isAllowedOrigin(CONFIGURED, `${CONFIGURED}, ${CONFIGURED}`), false);
  });
});

describe('isStateChangingMethod', () => {
  it('covers exactly POST/PUT/PATCH/DELETE', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      assert.equal(isStateChangingMethod(method), true, method);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(isStateChangingMethod(method), false, method);
    }
  });
});
