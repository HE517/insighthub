/**
 * `AiLimits` — the M4 B5 budget, unit-tested with an injected clock.
 *
 * These tests pin the frozen numbers from `docs/DECISIONS.md` D-082 D3 and the window
 * semantics `limits.ts` documents: 20/user/hour, 100/user/day, 1 generation/user,
 * 4 provider requests/server. They also prove the map stays bounded and that a denial
 * mutates no counter. The HTTP wiring (429 + `Retry-After`, provider-not-called) is covered by
 * `route.limits.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AI_DAY_WINDOW_MS,
  AI_HOUR_WINDOW_MS,
  AI_LIMIT_PER_USER_PER_DAY,
  AI_LIMIT_PER_USER_PER_HOUR,
  AI_MAX_CONCURRENT_PER_USER,
  AI_MAX_CONCURRENT_SERVER,
  AiLimits,
} from './limits.js';

/** A settable clock: `set` jumps, `advance` moves forward, nothing sleeps. */
function fakeClock(start = 1_700_000_000_000): {
  readonly now: () => number;
  readonly set: (value: number) => void;
  readonly advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Acquire one generation and release it immediately; asserts the acquire was admitted. */
function consumeOne(limits: AiLimits, userId: string): void {
  const decision = limits.acquire(userId);
  assert.equal(decision.allowed, true, `expected ${userId} to be admitted`);
  limits.release(userId);
}

describe('frozen numbers', () => {
  it('matches D-082 D3 exactly', () => {
    assert.equal(AI_LIMIT_PER_USER_PER_HOUR, 20);
    assert.equal(AI_LIMIT_PER_USER_PER_DAY, 100);
    assert.equal(AI_MAX_CONCURRENT_PER_USER, 1);
    assert.equal(AI_MAX_CONCURRENT_SERVER, 4);
  });

  it('is per instance, so two apps in one process never share counters', () => {
    const clock = fakeClock();
    const first = new AiLimits({ now: clock.now });
    const second = new AiLimits({ now: clock.now });
    for (let index = 0; index < 20; index += 1) consumeOne(first, 'user-a');
    assert.equal(first.acquire('user-a').allowed, false);
    assert.equal(second.acquire('user-a').allowed, true);
    second.release('user-a');
  });
});

describe('20 per user per hour', () => {
  it('admits exactly 20 and denies the 21st with a whole-second Retry-After', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now });

    for (let index = 0; index < 20; index += 1) consumeOne(limits, 'user-a');

    const denied = limits.acquire('user-a');
    assert.equal(denied.allowed, false);
    if (denied.allowed) return;
    assert.equal(denied.reason, 'hourly');
    // The first request opened the window; now is still the same instant.
    assert.equal(denied.retryAfterSeconds, AI_HOUR_WINDOW_MS / 1_000);
    // A denial reserves nothing.
    assert.equal(limits.activeServerGenerations, 0);
  });

  it('starts a fresh hour window once the clock passes the boundary', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now });
    for (let index = 0; index < 20; index += 1) consumeOne(limits, 'user-a');
    assert.equal(limits.acquire('user-a').allowed, false);

    clock.advance(AI_HOUR_WINDOW_MS - 1);
    assert.equal(limits.acquire('user-a').allowed, false, 'still inside the window');

    clock.advance(1);
    const admitted = limits.acquire('user-a');
    assert.equal(admitted.allowed, true, 'the window boundary admits the next request');
    limits.release('user-a');
  });

  it('counts users independently', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now });
    for (let index = 0; index < 20; index += 1) consumeOne(limits, 'user-a');
    assert.equal(limits.acquire('user-a').allowed, false);
    assert.equal(limits.acquire('user-b').allowed, true);
    limits.release('user-b');
  });
});

describe('100 per user per day', () => {
  it('admits 100 across hour windows and denies the 101st on the daily budget', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now });
    const start = clock.now();

    // 5 hour windows × 20 requests = the entire daily allowance. Each hour boundary resets
    // only the hour counter; this is what makes the day limit reachable at the hourly rate.
    for (let hour = 0; hour < 5; hour += 1) {
      clock.set(start + hour * AI_HOUR_WINDOW_MS);
      for (let index = 0; index < 20; index += 1) consumeOne(limits, 'user-a');
    }

    clock.set(start + 5 * AI_HOUR_WINDOW_MS);
    const denied = limits.acquire('user-a');
    assert.equal(denied.allowed, false);
    if (denied.allowed) return;
    assert.equal(denied.reason, 'daily', 'the hour window reset, so only the day limit can refuse');
    // 24 h day window from the first request, now 5 h in.
    assert.equal(denied.retryAfterSeconds, (AI_DAY_WINDOW_MS - 5 * AI_HOUR_WINDOW_MS) / 1_000);
  });

  it('resets the day count after the day window, independently of the hour count', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now });
    const start = clock.now();
    for (let hour = 0; hour < 5; hour += 1) {
      clock.set(start + hour * AI_HOUR_WINDOW_MS);
      for (let index = 0; index < 20; index += 1) consumeOne(limits, 'user-a');
    }
    clock.set(start + 5 * AI_HOUR_WINDOW_MS);
    assert.equal(limits.acquire('user-a').allowed, false);

    clock.set(start + AI_DAY_WINDOW_MS);
    const admitted = limits.acquire('user-a');
    assert.equal(admitted.allowed, true);
    limits.release('user-a');
  });
});

describe('concurrency', () => {
  it('allows one generation per user and admits the next only after release', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now });

    assert.equal(limits.acquire('user-a').allowed, true);
    assert.equal(limits.activeServerGenerations, 1);

    const second = limits.acquire('user-a');
    assert.equal(second.allowed, false);
    if (!second.allowed) {
      assert.equal(second.reason, 'user_concurrency');
      assert.equal(second.retryAfterSeconds, 1);
    }
    assert.equal(limits.activeServerGenerations, 1, 'a denied acquire must not take a slot');

    limits.release('user-a');
    assert.equal(limits.activeServerGenerations, 0);
    assert.equal(limits.acquire('user-a').allowed, true);
    limits.release('user-a');
  });

  it('allows four provider requests per server and refuses the fifth across users', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now });

    for (let index = 0; index < 4; index += 1) {
      assert.equal(limits.acquire(`user-${index}`).allowed, true);
    }
    assert.equal(limits.activeServerGenerations, 4);

    const fifth = limits.acquire('user-4');
    assert.equal(fifth.allowed, false);
    if (!fifth.allowed) {
      assert.equal(fifth.reason, 'server_concurrency');
      assert.equal(fifth.retryAfterSeconds, 1);
    }
    assert.equal(limits.activeServerGenerations, 4);

    limits.release('user-0');
    assert.equal(limits.acquire('user-4').allowed, true);
    assert.equal(limits.activeServerGenerations, 4);

    for (let index = 0; index < 5; index += 1) limits.release(`user-${index}`);
  });

  it('keeps the server slot counter at zero when release is called without a slot', () => {
    const limits = new AiLimits({ now: fakeClock().now });
    limits.release('never-admitted');
    limits.release('never-admitted');
    assert.equal(limits.activeServerGenerations, 0);
  });
});

describe('boundedness', () => {
  it('never exceeds maxKeys and evicts the oldest idle entry instead of growing', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now, maxKeys: 2 });

    // Burn `old`'s whole hour budget.
    for (let index = 0; index < 20; index += 1) consumeOne(limits, 'old');
    assert.equal(limits.acquire('old').allowed, false);
    consumeOne(limits, 'middle');
    assert.equal(limits.size, 2);
    consumeOne(limits, 'newest'); // at the cap: `old` (oldest, idle) is evicted
    assert.equal(limits.size, 2);

    // `old` is gone, so its counter went with it: the eviction policy is the boundedness
    // price, and this assertion makes it visible rather than accidental.
    const admitted = limits.acquire('old');
    assert.equal(admitted.allowed, true);
    limits.release('old');
  });

  it('never evicts an entry that holds a slot, and fails closed instead', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now, maxKeys: 1 });

    assert.equal(limits.acquire('active').allowed, true);
    const other = limits.acquire('other');
    assert.equal(other.allowed, false);
    if (!other.allowed) assert.equal(other.reason, 'server_concurrency');

    limits.release('active');
    const retried = limits.acquire('other');
    assert.equal(retried.allowed, true);
    limits.release('other');
  });

  it('rejects a non-positive maxKeys at construction', () => {
    assert.throws(() => new AiLimits({ maxKeys: 0 }), /maxKeys/);
    assert.throws(() => new AiLimits({ maxKeys: 1.5 }), /maxKeys/);
  });

  it('sweeps fully expired idle entries instead of keeping an unbounded stale tail', () => {
    const clock = fakeClock();
    const limits = new AiLimits({ now: clock.now });
    consumeOne(limits, 'stale');
    assert.equal(limits.size, 1);

    clock.advance(AI_DAY_WINDOW_MS + 1);
    const decision = limits.acquire('fresh');
    assert.equal(decision.allowed, true);
    limits.release('fresh');
    // `stale` was removed by the sweep; only the new key is tracked.
    assert.equal(limits.size, 1);
  });
});
