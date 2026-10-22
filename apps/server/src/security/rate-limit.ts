/**
 * A fixed-window, in-process request limiter (M4 B4).
 *
 * ## Why this shape
 *
 * V1 is a **single Node process on a single instance** (`docs/DECISIONS.md` D-082 D2: no Redis,
 * no distributed cache, no horizontal scaling). A shared-store limiter would add infrastructure
 * the deployment explicitly does not have, so the bucket map lives in this process. The
 * consequence — a process restart clears the counters, and two instances would each enforce the
 * limit separately — is acceptable for V1 and is written down in the task report rather than
 * hidden.
 *
 * ## Bounded by construction
 *
 * A limiter keyed by client address is a map an attacker can grow. Two mechanisms keep it
 * bounded:
 *
 * - **expired buckets are swept** at most once per second ({@link SWEEP_INTERVAL_MS}), so a
 *   steady stream of one-off addresses cannot leave an unbounded tail of stale entries;
 * - a hard {@link FixedWindowRateLimiterOptions.maxKeys} cap **evicts the oldest entry** (Map
 *   insertion order, which for a fixed window is also the soonest to expire) before a new key
 *   is admitted. Memory therefore cannot exceed the cap even in the second between sweeps.
 *
 * The limiter returns a decision; it never writes a response. The route decides the status and
 * body, which keeps the error shape in `app.ts` next to the rest of the frozen bodies.
 */

/** Expired buckets are swept at most this often, so `check` stays O(1) in the common case. */
const SWEEP_INTERVAL_MS = 1_000;

/** Default cap on tracked keys. Well above a real client population for a single instance. */
const DEFAULT_MAX_KEYS = 10_000;

export interface FixedWindowRateLimiterOptions {
  /** Requests allowed per key per window. Must be a positive integer. */
  readonly limit: number;
  /** Window length in milliseconds. Must be a positive integer. */
  readonly windowMs: number;
  /** Hard cap on tracked keys. Defaults to {@link DEFAULT_MAX_KEYS}. */
  readonly maxKeys?: number;
  /** Injected clock, so a test can advance a window without sleeping. */
  readonly now?: () => number;
}

export interface RateLimitDecision {
  /** False when this request is over the limit for the current window. */
  readonly allowed: boolean;
  /** Whole seconds until the window resets (at least 1 when denied). */
  readonly retryAfterSeconds: number;
  /** Requests still allowed in the current window (0 when denied). */
  readonly remaining: number;
}

interface Bucket {
  count: number;
  /** Wall-clock instant at which this window ends and the next one begins. */
  resetAt: number;
}

export class FixedWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();
  #lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(options: FixedWindowRateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error('FixedWindowRateLimiter: limit must be a positive integer');
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error('FixedWindowRateLimiter: windowMs must be a positive integer');
    }
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new Error('FixedWindowRateLimiter: maxKeys must be a positive integer');
    }
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = maxKeys;
    this.#now = options.now ?? Date.now;
  }

  /** Number of tracked buckets, for the boundedness test and operational introspection. */
  get size(): number {
    return this.#buckets.size;
  }

  /**
   * Record one request for `key` and answer whether it is allowed.
   *
   * The counting request is the one being decided: the 11th request in a 10-per-minute window is
   * denied (not the 12th), which is what "10 次/分钟" means.
   */
  check(key: string, now: number = this.#now()): RateLimitDecision {
    this.#sweep(now);

    let bucket = this.#buckets.get(key);
    if (bucket === undefined || now >= bucket.resetAt) {
      if (bucket === undefined) this.#makeRoom(now);
      bucket = { count: 0, resetAt: now + this.#windowMs };
      this.#buckets.set(key, bucket);
    }

    bucket.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));

    if (bucket.count > this.#limit) {
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }
    return {
      allowed: true,
      retryAfterSeconds,
      remaining: Math.max(0, this.#limit - bucket.count),
    };
  }

  /** Drop every bucket. Used by tests that reuse one limiter across scenarios. */
  reset(): void {
    this.#buckets.clear();
    this.#lastSweepAt = Number.NEGATIVE_INFINITY;
  }

  /** Delete expired buckets, at most once per {@link SWEEP_INTERVAL_MS}. */
  #sweep(now: number): void {
    if (now - this.#lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.#lastSweepAt = now;
    for (const [key, bucket] of this.#buckets) {
      if (now >= bucket.resetAt) this.#buckets.delete(key);
    }
  }

  /** Guarantee a slot for one more key without ever exceeding `maxKeys`. */
  #makeRoom(now: number): void {
    if (this.#buckets.size < this.#maxKeys) return;

    // At the cap: sweep regardless of the throttle, because admitting a key now is the only
    // alternative to evicting a live one.
    for (const [key, bucket] of this.#buckets) {
      if (now >= bucket.resetAt) this.#buckets.delete(key);
    }
    if (this.#buckets.size < this.#maxKeys) return;

    // Still full: evict the oldest insertion. In a fixed window that is the bucket closest to
    // expiry, so the evicted entry is the one with the least remaining value.
    const oldest = this.#buckets.keys().next();
    if (!oldest.done) this.#buckets.delete(oldest.value);
  }
}
