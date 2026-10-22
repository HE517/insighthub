/**
 * **M4 B4** — the fixed-window limiter (`security/rate-limit.ts`).
 *
 * The HTTP behaviour (the 11th bootstrap is `429`) is proven over a real server in
 * `origin-http.test.ts`; this file pins the mechanics a real server cannot show without waiting a
 * minute: window reset, key independence, expiry sweeping, and the hard key cap.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixedWindowRateLimiter } from './rate-limit.js';

describe('FixedWindowRateLimiter', () => {
  it('allows exactly `limit` requests per window and denies the next one', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({
      limit: 10,
      windowMs: 60_000,
      now: () => now,
    });

    for (let index = 1; index <= 10; index += 1) {
      const decision = limiter.check('ip-1', now);
      assert.equal(decision.allowed, true, `request ${index}`);
      assert.equal(decision.remaining, 10 - index, `request ${index}`);
    }

    const denied = limiter.check('ip-1', now);
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
    assert.equal(denied.retryAfterSeconds, 60, 'the whole first window remains');
  });

  it('resets on the window boundary, not on a sliding count', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => now,
    });
    assert.equal(limiter.check('ip', now).allowed, true);
    assert.equal(limiter.check('ip', now).allowed, true);
    assert.equal(limiter.check('ip', now).allowed, false);

    now = 59_999;
    assert.equal(limiter.check('ip', now).allowed, false);

    now = 60_000;
    const fresh = limiter.check('ip', now);
    assert.equal(fresh.allowed, true, 'a new window starts at resetAt');
    assert.equal(fresh.remaining, 1);
  });

  it('counts each key independently', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      now: () => now,
    });
    assert.equal(limiter.check('ip-1', now).allowed, true);
    assert.equal(limiter.check('ip-1', now).allowed, false);
    assert.equal(limiter.check('ip-2', now).allowed, true, 'another client has its own bucket');
  });

  it('sweeps expired buckets instead of growing without bound', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      now: () => now,
    });

    for (let index = 0; index < 100; index += 1) limiter.check(`ip-${index}`, now);
    assert.equal(limiter.size, 100);

    // Advance past the window: the next check sweeps every expired bucket before inserting.
    now = 60_000;
    assert.equal(limiter.check('fresh', now).allowed, true);
    assert.equal(limiter.size, 1, 'stale buckets are removed');
  });

  it('never exceeds maxKeys, even inside one sweep interval', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      limit: 5,
      windowMs: 60_000,
      maxKeys: 2,
      now: () => now,
    });

    for (let index = 0; index < 50; index += 1) {
      limiter.check(`ip-${index}`, now);
      assert.ok(limiter.size <= 2, `size after ip-${index}: ${limiter.size}`);
    }
    assert.equal(limiter.size, 2);
  });

  it('rejects a non-positive limit, window or maxKeys at construction', () => {
    assert.throws(() => new FixedWindowRateLimiter({ limit: 0, windowMs: 1_000 }), /limit/);
    assert.throws(() => new FixedWindowRateLimiter({ limit: 1, windowMs: 0 }), /windowMs/);
    assert.throws(
      () => new FixedWindowRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 0 }),
      /maxKeys/,
    );
  });

  it('reset() clears every bucket', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      now: () => now,
    });
    limiter.check('ip', now);
    assert.equal(limiter.size, 1);
    limiter.reset();
    assert.equal(limiter.size, 0);
    assert.equal(limiter.check('ip', now).allowed, true);
  });
});
