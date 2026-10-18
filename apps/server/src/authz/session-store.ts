/**
 * Server-side session state: `token → { userId, createdAt, expiresAt }`
 * (`docs/CONTRACTS.md` §17.2).
 *
 * ## Process-scoped, on purpose
 *
 * This store lives in memory. A restart invalidates every session and clients re-bootstrap.
 * §17.2 and §17.7 name that as a **limitation of Phase 2**, and `docs/ARCHITECTURE.md` §8.4
 * forbids calling it durability. Keeping it in a `Map` is what makes the limitation
 * impossible to misdescribe later: there is no file that could be mistaken for a durable
 * session table.
 *
 * ## What this store does *not* decide
 *
 * It answers exactly one question — "which `userId` does this token currently denote?" — and
 * never "who is this person" or "may they edit". Authorization starts one layer up
 * (`authz.ts`), from the `userId` this store returns.
 *
 * ## Expiry is checked on read, never slid
 *
 * `resolve` compares against the absolute `expiresAt` that was fixed at issue time. There is
 * no sliding window: a session lives 12 h from bootstrap, not 12 h from its last request. A
 * sliding TTL would turn "expiresAt" in the bootstrap response into a lie.
 */
import { createSessionToken, isWellFormedSessionToken } from './tokens.js';

/** Absolute session lifetime (§17.2: 12 h). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Upper bound on live sessions in one process.
 *
 * This is an **operational bound, not a security property**: §17.7 excludes rate limiting and
 * durable sessions, and nothing here inspects who is asking. It exists because an unbounded
 * `Map` fed by a public `POST` is a memory leak with a one-line trigger (loop the bootstrap
 * endpoint). Eviction is oldest-expiry-first, so the sessions a live demo is actually using
 * are the last to go.
 */
export const MAX_LIVE_SESSIONS = 10_000;

export interface SessionRecord {
  /** The opaque token. Never logged, never serialised into a response body (§17.2). */
  readonly token: string;
  readonly userId: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds. Absolute; never extended by a read. */
  readonly expiresAt: number;
}

/** `true` when `record` has not expired at `now`. */
export function isSessionLive(record: SessionRecord, now: number): boolean {
  return record.expiresAt > now;
}

export class SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Number of tokens currently held (including not-yet-swept expired ones). */
  get size(): number {
    return this.#sessions.size;
  }

  /**
   * Mint a token for `userId` and record it.
   *
   * Rotation is *not* done here: the caller revokes the previous token explicitly
   * (`AuthzService.bootstrap`), because "invalidate the previous one **for that client**"
   * (§17.2) is a statement about the request's cookie, which this store cannot see.
   */
  issue(userId: string): SessionRecord {
    const createdAt = this.#now();
    const record: SessionRecord = {
      token: createSessionToken(),
      userId,
      createdAt,
      expiresAt: createdAt + SESSION_TTL_MS,
    };
    // A token collision is astronomically unlikely (256 random bits), but overwriting a live
    // session would be the one way this map could hand out somebody else's identity, so it is
    // checked rather than assumed.
    if (this.#sessions.has(record.token)) return this.issue(userId);
    this.#sessions.set(record.token, record);
    this.#enforceCapacity();
    return record;
  }

  /**
   * Look up a token. Returns `null` for a missing, malformed, revoked or expired token.
   *
   * An expired token is deleted on the way out, so memory does not grow with dead sessions —
   * but the *answer* does not depend on that deletion: expiry is decided by `expiresAt`.
   */
  resolve(token: string | null | undefined): SessionRecord | null {
    if (!isWellFormedSessionToken(token)) return null;
    const record = this.#sessions.get(token);
    if (record === undefined) return null;
    if (!isSessionLive(record, this.#now())) {
      this.#sessions.delete(token);
      return null;
    }
    return record;
  }

  /** Destroy a token. Returns whether it existed (revoking twice is not an error). */
  revoke(token: string | null | undefined): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    return this.#sessions.delete(token);
  }

  /** Drop every expired session. Returns how many were removed. */
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [token, record] of this.#sessions) {
      if (!isSessionLive(record, now)) {
        this.#sessions.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  /** Drop everything. Used by `close()`; sessions are process-scoped by definition. */
  clear(): void {
    this.#sessions.clear();
  }

  /**
   * Keep the map bounded.
   *
   * Expired entries go first (they are dead anyway), and only if the map is *still* over the
   * cap is the oldest-expiring live session dropped. Dropping a live session is a real
   * consequence — that client gets a `401` and re-bootstraps — which is why it is the last
   * resort and why the bound is far above any plausible demo.
   */
  #enforceCapacity(): void {
    if (this.#sessions.size <= MAX_LIVE_SESSIONS) return;
    this.sweep();
    while (this.#sessions.size > MAX_LIVE_SESSIONS) {
      let oldestToken: string | null = null;
      let oldestExpiry = Number.POSITIVE_INFINITY;
      for (const [token, record] of this.#sessions) {
        if (record.expiresAt < oldestExpiry) {
          oldestExpiry = record.expiresAt;
          oldestToken = token;
        }
      }
      if (oldestToken === null) return;
      this.#sessions.delete(oldestToken);
    }
  }
}
