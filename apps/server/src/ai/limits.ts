/**
 * # App-side AI budget enforcement (M4 B5, `docs/DECISIONS.md` D-082 D3)
 *
 * The frozen numbers, which this file may enforce but never weaken:
 *
 * | Limit | Value | Window |
 * | --- | --- | --- |
 * | generations per user | **20** | 1 hour |
 * | generations per user | **100** | 1 day |
 * | concurrent generations per user | **1** | instantaneous |
 * | concurrent provider requests per server | **4** | instantaneous |
 *
 * ## Fixed windows, with an explicit anchor
 *
 * Each user's hour/day window starts at **that user's first admitted request after the previous
 * window expired** and ends `windowMs` later. This is the same anchoring as
 * `security/rate-limit.ts` (the B4 bootstrap limiter), so the repository has one window
 * semantics, not two. A consequence worth stating rather than hiding: a user who sends 20
 * requests at 00:59 and 20 at 01:00 consumes 40 in a rolling hour; the contract fixes *windows*,
 * not a token bucket, and D-082 D3 allows either. UTC midnight does **not** reset the day window
 * — the day is "24 h from the first request of the current day window", which is what makes the
 * enforcement independent of the process's timezone.
 *
 * ## Counted vs. not counted — the cost rule
 *
 * A request is counted when it is **admitted to call the provider**. That happens in
 * {@link AiLimits.acquire} *before* `provider.suggest` is invoked and is never undone by
 * {@link AiLimits.release}: a provider failure, timeout or client abort already spent OpenAI
 * tokens, so the count stays. Requests refused by the limiter are not counted — they never
 * reach the provider and cost nothing. That is exactly the split D-082 D3 asks for ("server
 * must not silently repeat token burn").
 *
 * ## Bounded by construction
 *
 * The map is keyed by internal user id, so it is an attacker-influenced map. Two mechanisms
 * keep it bounded, mirroring `security/rate-limit.ts`:
 *
 * - **expired entries are swept** at most once per second ({@link SWEEP_INTERVAL_MS}). An entry
 *   expires only when *both* windows are over **and** no generation of that user is in flight,
 *   so expiring the hour window can never discard a still-active day count;
 * - a hard {@link DEFAULT_MAX_KEYS} cap evicts the oldest **idle** entry before admitting a new
 *   key. Evicting an idle entry can reset that user's remaining budget early; with the cap far
 *   above the V1 user population that is a memory-safety tradeoff, not an operational one. An
 *   entry with an in-flight generation is never evicted, because that would leak a server slot.
 *
 * If the cap is somehow reached with every tracked entry in flight (impossible while
 * {@link AI_MAX_CONCURRENT_SERVER} is 4 and the cap is larger), admission fails closed with a
 * `server_concurrency` denial rather than evicting an active entry.
 *
 * ## Why the limiter returns a decision instead of writing a response
 *
 * Same reason as the bootstrap limiter: the route owns the HTTP shape (§11.2). This module
 * knows only "allowed / denied + how long to wait", which makes it testable with an injected
 * clock and keeps the frozen `429 {"error":"rate_limited"}` body in one place (`route.ts`).
 */

/** Requests allowed per user per hour window (D-082 D3; not configurable). */
export const AI_LIMIT_PER_USER_PER_HOUR = 20;

/** Requests allowed per user per day window (D-082 D3; not configurable). */
export const AI_LIMIT_PER_USER_PER_DAY = 100;

/** At most one generation in flight per user. */
export const AI_MAX_CONCURRENT_PER_USER = 1;

/** At most four provider requests in flight per server instance. */
export const AI_MAX_CONCURRENT_SERVER = 4;

/** Hour window length. */
export const AI_HOUR_WINDOW_MS = 60 * 60 * 1_000;

/** Day window length. */
export const AI_DAY_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Expired entries are swept at most this often, so `acquire` stays O(1) in the common case. */
const SWEEP_INTERVAL_MS = 1_000;

/** Default cap on tracked users. Well above a real V1 population for a single instance. */
const DEFAULT_MAX_KEYS = 10_000;

/** A configured budget override must be a positive integer; anything else is a programming error. */
function positiveOr(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`AiLimits: ${name} must be a positive integer`);
  }
  return value;
}

/** Why a request was refused. The route does not expose this: the body is only `{ error }`. */
export type AiLimitDenialReason = 'hourly' | 'daily' | 'user_concurrency' | 'server_concurrency';

export type AiLimitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: AiLimitDenialReason;
      /** Whole seconds, always at least 1. Becomes the `Retry-After` header. */
      readonly retryAfterSeconds: number;
    };

export interface AiLimitsOptions {
  /** Injected clock (ms since epoch), so a test can advance a window without sleeping. */
  readonly now?: () => number;
  /** Hard cap on tracked users. Defaults to {@link DEFAULT_MAX_KEYS}. */
  readonly maxKeys?: number;
  /**
   * Budget overrides. Absent means the frozen D-082 D3 number; the browser suite raises the
   * hour/day budgets through the same configuration the production path reads, because one run
   * legitimately performs far more generations than a human ever would. The limiter itself is
   * unchanged — this is a seam, not a bypass.
   */
  readonly perHour?: number;
  readonly perDay?: number;
  readonly perUserConcurrent?: number;
  readonly perServerConcurrent?: number;
}

interface UserBudget {
  hourCount: number;
  /** Instant at which the current hour window ends. */
  hourResetAt: number;
  dayCount: number;
  /** Instant at which the current day window ends. */
  dayResetAt: number;
  /** Generations currently in flight for this user. */
  activeGenerations: number;
}

/**
 * The per-application AI budget.
 *
 * One instance per `createApp` call, never a module singleton: two servers in one process (every
 * test harness, and the restart scenarios) must not share counters, for the same reason the
 * bootstrap limiter is per-app.
 */
export class AiLimits {
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #perHour: number;
  readonly #perDay: number;
  readonly #perUserConcurrent: number;
  readonly #perServerConcurrent: number;
  readonly #users = new Map<string, UserBudget>();
  #activeServerGenerations = 0;
  #lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(options: AiLimitsOptions = {}) {
    const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new Error('AiLimits: maxKeys must be a positive integer');
    }
    this.#now = options.now ?? Date.now;
    this.#maxKeys = maxKeys;
    this.#perHour = positiveOr(options.perHour, AI_LIMIT_PER_USER_PER_HOUR, 'perHour');
    this.#perDay = positiveOr(options.perDay, AI_LIMIT_PER_USER_PER_DAY, 'perDay');
    this.#perUserConcurrent = positiveOr(
      options.perUserConcurrent,
      AI_MAX_CONCURRENT_PER_USER,
      'perUserConcurrent',
    );
    this.#perServerConcurrent = positiveOr(
      options.perServerConcurrent,
      AI_MAX_CONCURRENT_SERVER,
      'perServerConcurrent',
    );
  }

  /** Number of tracked users, for the boundedness test and operational introspection. */
  get size(): number {
    return this.#users.size;
  }

  /** Provider requests currently holding a server slot. Should return to 0 after every request. */
  get activeServerGenerations(): number {
    return this.#activeServerGenerations;
  }

  /**
   * Decide whether this user may start one generation, and reserve the slot if so.
   *
   * The check and the reservation are one synchronous operation: there is no `await` between
   * "under the limit" and "counted", so two requests cannot both observe `active === 0` and
   * both start. Callers must {@link release} exactly once per allowed decision, in `finally`.
   *
   * A denied decision mutates nothing: neither the hour/day counts nor the concurrency slots.
   */
  acquire(userId: string): AiLimitDecision {
    const now = this.#now();
    this.#sweep(now);

    let budget = this.#users.get(userId);
    if (budget === undefined) {
      if (!this.#makeRoom(now)) {
        // All tracked users have a generation in flight. With the frozen cap this is not
        // reachable, but failing closed is the only safe answer.
        return { allowed: false, reason: 'server_concurrency', retryAfterSeconds: 1 };
      }
      budget = {
        hourCount: 0,
        hourResetAt: now + AI_HOUR_WINDOW_MS,
        dayCount: 0,
        dayResetAt: now + AI_DAY_WINDOW_MS,
        activeGenerations: 0,
      };
      this.#users.set(userId, budget);
    } else {
      this.#refreshWindows(budget, now);
    }

    // Rate budgets first: their Retry-After is the meaningful wait. The 21st request in an
    // hour is refused by the hourly budget even though the day budget still has room.
    if (budget.hourCount >= this.#perHour) {
      return {
        allowed: false,
        reason: 'hourly',
        retryAfterSeconds: retryAfterSeconds(budget.hourResetAt, now),
      };
    }
    if (budget.dayCount >= this.#perDay) {
      return {
        allowed: false,
        reason: 'daily',
        retryAfterSeconds: retryAfterSeconds(budget.dayResetAt, now),
      };
    }
    if (budget.activeGenerations >= this.#perUserConcurrent) {
      // A slot can free as soon as the in-flight generation settles; 1 s is the honest floor.
      return { allowed: false, reason: 'user_concurrency', retryAfterSeconds: 1 };
    }
    if (this.#activeServerGenerations >= this.#perServerConcurrent) {
      return { allowed: false, reason: 'server_concurrency', retryAfterSeconds: 1 };
    }

    budget.hourCount += 1;
    budget.dayCount += 1;
    budget.activeGenerations += 1;
    this.#activeServerGenerations += 1;
    return { allowed: true };
  }

  /**
   * Release one reserved slot.
   *
   * Deliberately does not touch the hour/day counts: the provider was called (or at least was
   * about to be), which is the cost the budget measures. Safe to call on a user that was never
   * admitted (no-op) so a route can put it in an unconditional `finally`.
   */
  release(userId: string): void {
    const budget = this.#users.get(userId);
    if (budget === undefined || budget.activeGenerations === 0) return;
    budget.activeGenerations -= 1;
    // The per-user guard above keeps this from going negative; the floor is belt and braces
    // against a future caller releasing without holding.
    this.#activeServerGenerations = Math.max(0, this.#activeServerGenerations - 1);
  }

  /** Drop every entry. Tests only; production never calls it (a restart clears everything). */
  reset(): void {
    this.#users.clear();
    this.#activeServerGenerations = 0;
    this.#lastSweepAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * Roll a user's windows forward when the clock passed their end.
   *
   * Both windows are refreshed independently: an entry whose hour window expired keeps its day
   * count, which is what makes `100/day` enforceable across hour boundaries.
   */
  #refreshWindows(budget: UserBudget, now: number): void {
    if (now >= budget.hourResetAt) {
      budget.hourCount = 0;
      budget.hourResetAt = now + AI_HOUR_WINDOW_MS;
    }
    if (now >= budget.dayResetAt) {
      budget.dayCount = 0;
      budget.dayResetAt = now + AI_DAY_WINDOW_MS;
    }
  }

  /** Delete fully expired, idle entries, at most once per {@link SWEEP_INTERVAL_MS}. */
  #sweep(now: number): void {
    if (now - this.#lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.#lastSweepAt = now;
    for (const [key, budget] of this.#users) {
      if (isExpired(budget, now)) this.#users.delete(key);
    }
  }

  /**
   * Guarantee room for one more key without ever exceeding `maxKeys`.
   *
   * At the cap, expired entries go first, then the oldest **idle** entry. Map insertion order
   * means "oldest" is also the entry whose windows were opened first. If every entry is
   * in flight, admission is refused — never by evicting a slot holder.
   */
  #makeRoom(now: number): boolean {
    if (this.#users.size < this.#maxKeys) return true;

    // At the cap: sweep regardless of the throttle, because admitting a key now is the only
    // alternative to evicting a live one.
    for (const [key, budget] of this.#users) {
      if (isExpired(budget, now)) this.#users.delete(key);
    }
    if (this.#users.size < this.#maxKeys) return true;

    for (const [key, budget] of this.#users) {
      if (budget.activeGenerations === 0) {
        this.#users.delete(key);
        return true;
      }
    }
    return false;
  }
}

/** An entry can be forgotten only when both windows are over and nothing is in flight. */
function isExpired(budget: UserBudget, now: number): boolean {
  return budget.activeGenerations === 0 && now >= budget.hourResetAt && now >= budget.dayResetAt;
}

/** Whole seconds until `resetAt`, never 0 (a retry that does not wait is not a retry). */
function retryAfterSeconds(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1_000));
}
