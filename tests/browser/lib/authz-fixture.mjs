/**
 * Session + membership fixtures for the A6 browser suite (M2 Phase 2).
 *
 * ## The two reasons this module exists
 *
 * Since `docs/CONTRACTS.md` §17 the collaboration socket is authenticated and authorized:
 *
 * 1. **Every WebSocket upgrade needs a valid `insighthub_session` cookie** (§17.5). The
 *    cookie is issued by `POST /api/session/bootstrap`, so a bare oracle/seeder socket that
 *    simply connects is refused with HTTP `401` and never joins a room. This module bootstraps
 *    a real session, keeps the cookie, and hands it to every outbound request **explicitly**
 *    (`Cookie:` header / `Network.setCookie`) — never through an implicit cookie jar, because
 *    the suite must be able to say which cookie a request carried.
 * 2. **Every `join-room` needs a document membership row** (§17.5). The per-scenario `a6-*`
 *    documents have no membership, so the join is denied with `ROOM_NOT_FOUND` — the same
 *    answer as "this document does not exist". Re-using the three seeded demo documents
 *    instead would destroy per-scenario isolation, so the fixture writes the membership row
 *    the scenario needs into the run's own `authz.db`.
 *
 * ## The membership write is deliberately coupled to A5's schema
 *
 * There is no membership API in Phase 2 and `docs/DECISIONS.md` D-063 §2a rejects adding a
 * test-only seed endpoint, so the only honest way to arrange membership is to write the row
 * the way the server would. That means this module knows
 * `authz_document_membership(document_id, user_id, role)`
 * (`apps/server/src/authz/membership-store.ts`). The coupling is **asserted, not assumed**:
 * every write first reads the table's real columns and fails loudly when they differ, so a
 * schema change shows up as a red scenario with the actual column list instead of as a
 * silently unwritten row. Same convention as `durable-store.mjs` (`docs/DECISIONS.md` D-055 §2):
 * `tests/browser/README.md` records the rule.
 *
 * ## What it does NOT do
 *
 * - It never creates `authz.db` or its table. Those are produced by the server at startup; a
 *   fixture that created them would make "authorization is broken" look like "the fixture
 *   worked". A missing file/table/column is an error naming the path and the reason.
 * - It never seeds a *user*. The roster is a server-side constant (§17.3); an unknown
 *   `demoUserId` is a `400` from the server and the fixture propagates it.
 * - It never reads or writes a token anywhere except into the `Cookie` header. Tokens are not
 *   logged, not written to artifacts and not put into evidence notes (only their length).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openDatabaseFile } from './durable-store.mjs';
import { loadShared } from './deps.mjs';

/** Cookie the session travels in (§17.2). */
export const SESSION_COOKIE_NAME = 'insighthub_session';

/** The A5-owned authorization database inside `INSIGHTHUB_DATA_PATH`. */
export const AUTHZ_DATABASE_FILE_NAME = 'authz.db';

/** The membership table (`apps/server/src/authz/membership-store.ts`). */
export const MEMBERSHIP_TABLE = 'authz_document_membership';

/** Columns the fixture reads and writes. The server asserts the rest of the shape. */
const REQUIRED_COLUMNS = ['document_id', 'user_id', 'role'];

/**
 * The identity a page or oracle claims when the scenario does not ask for another one.
 *
 * Kept equal to `apps/web/src/session/bootstrap.ts`'s default so a harness-opened page and a
 * harness-opened oracle are the same principal unless a scenario says otherwise.
 */
export const DEFAULT_DEMO_USER = 'demo-ada';

/** The roster (`apps/server/src/authz/demo-fixture.ts`) as the scenarios need to name it. */
export const DEMO_USERS = {
  ada: 'demo-ada',
  grace: 'demo-grace',
  linus: 'demo-linus',
};

/** One live session, as far as the harness may know it. */
function describeSession({ userId, displayName, expiresAt, token }) {
  return {
    userId,
    displayName,
    expiresAt,
    /** `Cookie: …` value. Never printed, never written to artifacts. */
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    tokenLength: token.length,
  };
}

/**
 * Session + membership fixture for one run.
 *
 * `dataPath` is a **provider**, not a value: the stack moves the server onto a fresh temporary
 * directory per scenario (`stack.restartServerOnFreshDataPath`), and membership must be written
 * to whichever directory the running server is using at that moment.
 */
export class AuthzFixture {
  #serverUrl;
  #dataPath;
  #sessions = new Map();
  #log = [];
  /** Most recently obtained session per demo user (used only to validate before reuse). */
  #lastKnown = new Map();
  /**
   * Raw tokens by demo user, kept out of every object a scenario can log.
   *
   * A token is a credential: the public session record carries `cookie` (needed to make a
   * request) and `tokenLength` (safe evidence), and the raw value stays here for the one caller
   * that must put it into the browser's cookie store.
   */
  #tokens = new Map();

  constructor({ serverUrl, dataPath }) {
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
      throw new Error('the authorization fixture needs the backend URL');
    }
    if (typeof dataPath !== 'function') {
      throw new Error('the authorization fixture needs a dataPath provider function');
    }
    this.#serverUrl = serverUrl.replace(/\/$/, '');
    this.#dataPath = dataPath;
  }

  get serverUrl() {
    return this.#serverUrl;
  }

  /** The directive the running server is persisting into. */
  get dataPath() {
    return this.#dataPath();
  }

  /* ---------------------------------------------------------------- *
   * Sessions
   * ---------------------------------------------------------------- */

  /**
   * A live session for `demoUserId`, bootstrapped through the **real** endpoint.
   *
   * The cookie is validated with `GET /api/session` on every call, because sessions are
   * `process-scoped` (§17.2): after any server restart — and after a scenario revokes a token
   * with `DELETE /api/session` — the cached cookie is dead, and handing it out would surface as
   * a confusing `401` far away from its cause. Validation is one cheap request.
   *
   * Concurrent callers share one in-flight establishment, so three pages opening at once cannot
   * mint three tokens that revoke each other (rotation, §17.2).
   */
  async session(demoUserId = DEFAULT_DEMO_USER) {
    if (typeof demoUserId !== 'string' || demoUserId.length === 0) {
      throw new Error('session() needs a demo user id');
    }
    const inFlight = this.#sessions.get(demoUserId);
    if (inFlight !== undefined) return await inFlight;

    const pending = this.#establish(demoUserId);
    this.#sessions.set(demoUserId, pending);
    try {
      return await pending;
    } finally {
      // The *validated session* stays in `#lastKnown`; only the in-flight marker is dropped, so
      // the next caller re-validates instead of reusing a token this process has not checked.
      this.#sessions.delete(demoUserId);
    }
  }

  async #establish(demoUserId) {
    const cached = this.#lastKnown.get(demoUserId);
    if (cached !== undefined) {
      const status = await this.#sessionStatus(cached.cookie);
      if (status === 200) return cached;
      // 401 means the token is gone (restart, revocation or expiry). Anything else is a
      // transport problem and the bootstrap below will report it with its own error.
      this.#lastKnown.delete(demoUserId);
    }
    return await this.bootstrap(demoUserId);
  }

  /** `GET /api/session` for one cookie: `200` live, `401` dead. */
  async #sessionStatus(cookie) {
    try {
      const response = await this.request('/api/session', { cookie });
      return response.status;
    } catch {
      return null;
    }
  }

  /**
   * Claim a demo identity and keep the issued cookie.
   *
   * The response body carries identity only (`userId`, `displayName`, `expiresAt`); the token
   * exists solely in `Set-Cookie` (§17.4). The fixture asserts that shape here because a token
   * in the body would be a contract violation every scenario would otherwise have to check.
   */
  async bootstrap(demoUserId = DEFAULT_DEMO_USER) {
    const response = await this.request('/api/session/bootstrap', {
      method: 'POST',
      body: { demoUserId },
    });
    const text = await response.text();
    if (response.status !== 200) {
      throw new Error(
        `POST /api/session/bootstrap for ${demoUserId} answered HTTP ${response.status}: ${text}`,
      );
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`POST /api/session/bootstrap answered non-JSON: ${text.slice(0, 200)}`);
    }
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    const pair = cookies
      .map((value) => value.split(';')[0])
      .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
    if (pair === undefined) {
      throw new Error(
        `POST /api/session/bootstrap returned no ${SESSION_COOKIE_NAME} cookie ` +
          `(set-cookie: ${cookies.join(' | ') || 'none'})`,
      );
    }
    const token = pair.slice(SESSION_COOKIE_NAME.length + 1);
    if (token.length === 0) throw new Error('the bootstrap cookie carried an empty token');
    if (typeof body?.userId !== 'string' || body.userId !== demoUserId) {
      throw new Error(
        `the bootstrap answered userId ${JSON.stringify(body?.userId)}, expected ${demoUserId}`,
      );
    }
    // §17.4/§17.2: the token must not appear in the body. Checked once, centrally.
    if (JSON.stringify(body).includes(token)) {
      throw new Error('the bootstrap response body contains the session token (§17.2 forbids it)');
    }

    const session = describeSession({
      userId: body.userId,
      displayName: String(body.displayName ?? ''),
      expiresAt: String(body.expiresAt ?? ''),
      token,
    });
    this.#lastKnown.set(demoUserId, session);
    this.#tokens.set(demoUserId, token);
    return session;
  }

  /**
   * Replace a page's cookie with a freshly bootstrapped session for `demoUserId`.
   *
   * Used only where a scenario has to survive a server restart to measure something else
   * (durability). The client itself has **no** re-bootstrap path, so without this the page
   * would sit in `reconnecting` forever — the observation recorded by
   * `m2/S-session-scope-after-restart` and reported as a Phase 2 limitation, not a passing
   * behaviour.
   */
  async renewBrowserSession(page, demoUserId = DEFAULT_DEMO_USER, { url } = {}) {
    const session = await this.session(demoUserId);
    const token = this.#tokens.get(demoUserId);
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`no bootstrapped token is held for ${demoUserId}`);
    }
    const cookieUrl = url ?? (await page.evaluate(() => location.origin));
    await page.setCookie({
      name: SESSION_COOKIE_NAME,
      value: token,
      url: cookieUrl,
      httpOnly: true,
      sameSite: 'Lax',
    });
    return session;
  }

  /** Forget every cached session (after a deliberate revocation). */
  forget(demoUserId) {
    if (demoUserId === undefined) {
      this.#sessions.clear();
      this.#lastKnown.clear();
      return;
    }
    this.#sessions.delete(demoUserId);
    this.#lastKnown.delete(demoUserId);
  }

  /* ---------------------------------------------------------------- *
   * HTTP with an explicit cookie
   * ---------------------------------------------------------------- */

  /**
   * One HTTP request against the backend.
   *
   * `cookie` is written into the `Cookie` header **explicitly**. Relying on a client-side
   * cookie jar would make "which identity did this request carry?" unobservable, which is the
   * whole subject of P2-2/P2-3.
   */
  async request(path, { cookie, method = 'GET', body, headers = {} } = {}) {
    const url = path.startsWith('http') ? path : `${this.#serverUrl}${path}`;
    const finalHeaders = { ...headers };
    if (cookie !== undefined) finalHeaders['cookie'] = cookie;
    if (body !== undefined) finalHeaders['content-type'] = 'application/json';
    return await fetch(url, {
      method,
      headers: finalHeaders,
      signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** `GET` a JSON endpoint and return `{ status, headers, body }` (body parsed when JSON). */
  async json(path, options = {}) {
    const response = await this.request(path, options);
    const text = await response.text();
    let body = null;
    try {
      body = text.length === 0 ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, headers: headerMap(response.headers), body };
  }

  /* ---------------------------------------------------------------- *
   * Membership (direct write; schema asserted)
   * ---------------------------------------------------------------- */

  /**
   * Write one membership row for the **current** data directory.
   *
   * `ifAbsent` is the difference between the harness *arranging access* and a scenario
   * *deciding a role*:
   *
   * - `ifAbsent: true` — only fills a missing row. Used by the harness when a legacy scenario
   *   opens a document: it must not overwrite the seeded fixture (asking for `owner` on
   *   `demo-document` for `demo-linus` would silently promote the seeded `viewer`, which is
   *   the exact role a denial scenario needs).
   * - `ifAbsent: false` (default) — the scenario is stating the role, so a different existing
   *   role is replaced and logged as `replaced`.
   */
  async grant(documentId, userId = DEFAULT_DEMO_USER, role = 'owner', { ifAbsent = false } = {}) {
    const shared = await loadShared();
    if (typeof documentId !== 'string' || documentId.length === 0) {
      throw new Error('grant() needs a document id');
    }
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error(`grant(${documentId}) needs a user id`);
    }
    if (!shared.isDocumentRole(role)) {
      throw new Error(
        `grant(${documentId}, ${userId}) got role ${JSON.stringify(role)}; ` +
          `the vocabulary is ${shared.DOCUMENT_ROLES.join(', ')} (packages/shared/src/permission.ts)`,
      );
    }

    const file = this.#authzDatabasePath();
    const db = await this.#openVerified(file);
    try {
      const existing = db
        .prepare(`SELECT role FROM ${MEMBERSHIP_TABLE} WHERE document_id = ? AND user_id = ?`)
        .get(documentId, userId);
      let action = 'inserted';
      if (existing === undefined) {
        db.prepare(
          `INSERT INTO ${MEMBERSHIP_TABLE} (document_id, user_id, role) VALUES (?, ?, ?)`,
        ).run(documentId, userId, role);
      } else if (String(existing['role']) === role) {
        action = 'unchanged';
      } else if (ifAbsent) {
        // The row exists with another role and the caller only asked for "some access", so
        // the stored (seeded or scenario-chosen) role wins. Recorded, never silent.
        action = 'kept-existing';
        this.#log.push({
          action,
          documentId,
          userId,
          role: String(existing['role']),
          requested: role,
        });
        return { documentId, userId, role: String(existing['role']), action, dataPath: this.dataPath };
      } else {
        db.prepare(
          `UPDATE ${MEMBERSHIP_TABLE} SET role = ? WHERE document_id = ? AND user_id = ?`,
        ).run(role, documentId, userId);
        action = 'replaced';
      }

      const stored = db
        .prepare(`SELECT role FROM ${MEMBERSHIP_TABLE} WHERE document_id = ? AND user_id = ?`)
        .get(documentId, userId);
      if (stored === undefined || String(stored['role']) !== role) {
        throw new Error(
          `the membership write for ${documentId}/${userId} did not persist: ` +
            `expected role ${role}, table holds ${JSON.stringify(stored?.['role'] ?? null)}`,
        );
      }
      this.#log.push({ action, documentId, userId, role });
      return { documentId, userId, role, action, dataPath: this.dataPath };
    } finally {
      this.#closeQuietly(db);
    }
  }

  /** Remove one membership row (the "not a member" control of the non-disclosure rule). */
  async revoke(documentId, userId = DEFAULT_DEMO_USER) {
    const file = this.#authzDatabasePath();
    const db = await this.#openVerified(file);
    try {
      const result = db
        .prepare(`DELETE FROM ${MEMBERSHIP_TABLE} WHERE document_id = ? AND user_id = ?`)
        .run(documentId, userId);
      const removed = Number(result.changes ?? 0);
      this.#log.push({ action: 'revoked', documentId, userId, role: null, removed });
      return removed;
    } finally {
      this.#closeQuietly(db);
    }
  }

  /** The stored row for one `(document, user)` pair, or `null`. */
  async membership(documentId, userId = DEFAULT_DEMO_USER) {
    const db = await this.#openVerified(this.#authzDatabasePath());
    try {
      const row = db
        .prepare(`SELECT document_id, user_id, role FROM ${MEMBERSHIP_TABLE} WHERE document_id = ? AND user_id = ?`)
        .get(documentId, userId);
      return row === undefined
        ? null
        : { documentId: String(row['document_id']), userId: String(row['user_id']), role: String(row['role']) };
    } finally {
      this.#closeQuietly(db);
    }
  }

  /** Every membership row for one user, ordered by document id. */
  async membershipsOf(userId = DEFAULT_DEMO_USER) {
    const db = await this.#openVerified(this.#authzDatabasePath());
    try {
      const rows = db
        .prepare(
          `SELECT document_id, user_id, role FROM ${MEMBERSHIP_TABLE} WHERE user_id = ? ORDER BY document_id ASC`,
        )
        .all(userId);
      return rows.map((row) => ({
        documentId: String(row['document_id']),
        userId: String(row['user_id']),
        role: String(row['role']),
      }));
    } finally {
      this.#closeQuietly(db);
    }
  }

  /** Membership writes performed since the last `takeLog()`, as reportable evidence. */
  get log() {
    return [...this.#log];
  }

  takeLog() {
    const entries = [...this.#log];
    this.#log.length = 0;
    return entries;
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  #authzDatabasePath() {
    const dataPath = this.dataPath;
    if (dataPath === null || dataPath === undefined || dataPath === '') {
      throw new Error('the authorization fixture has no INSIGHTHUB_DATA_PATH yet');
    }
    return join(dataPath, AUTHZ_DATABASE_FILE_NAME);
  }

  /**
   * Open `authz.db` and prove the schema before writing anything.
   *
   * Every failure here is **loud and specific**: a missing file, a missing table or a renamed
   * column must never degrade into "the row was not written" — that would present a broken
   * authorization store as a passing fixture (`tests/browser/README.md`).
   */
  async #openVerified(file) {
    if (!existsSync(file)) {
      throw new Error(
        `the authorization database ${file} does not exist. The server creates ` +
          'authz.db (and its membership table) at startup, so this is either a server that ' +
          'failed to start or a fixture running before the stack is up. The fixture must not ' +
          'create the file, because that would hide a broken authorization store.',
      );
    }
    let db;
    try {
      // One shared opener (`durable-store.mjs`), so both store files use the same convention.
      db = await openDatabaseFile(file, { busyTimeoutMs: 5_000 });
    } catch (error) {
      throw new Error(`could not open ${file}: ${String(error?.message ?? error)}`);
    }
    try {
      const table = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(MEMBERSHIP_TABLE);
      if (table === undefined) {
        const tables = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
          .all()
          .map((row) => String(row['name']));
        throw new Error(
          `the table ${MEMBERSHIP_TABLE} is missing from ${file} ` +
            `(tables: ${tables.join(', ') || 'none'}). The membership fixture is coupled to ` +
            'apps/server/src/authz/membership-store.ts; a renamed table is a loud failure by design.',
        );
      }
      const columns = db
        .prepare(`PRAGMA table_info(${MEMBERSHIP_TABLE})`)
        .all()
        .map((row) => String(row['name']));
      const missing = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
      if (missing.length > 0) {
        throw new Error(
          `${MEMBERSHIP_TABLE} in ${file} is missing column(s) ${missing.join(', ')} ` +
            `(it has: ${columns.join(', ')}). tests/browser/lib/authz-fixture.mjs is coupled to ` +
            'that schema; update it together with apps/server/src/authz/membership-store.ts.',
        );
      }
      return db;
    } catch (error) {
      this.#closeQuietly(db);
      throw error;
    }
  }

  #closeQuietly(db) {
    try {
      db.close();
    } catch {
      /* a closed or already-broken handle must not mask the original failure */
    }
  }
}

/** Response headers as a plain, lower-cased object (evidence-friendly). */
export function headerMap(headers) {
  const map = {};
  for (const [key, value] of headers.entries()) map[String(key).toLowerCase()] = String(value);
  return map;
}

let current = null;

/**
 * Install the run-wide fixture.
 *
 * A module-level singleton instead of threading it through every suite: the oracle and the
 * page helpers are called from 40+ scenario sites, and a parameter they all pass identically
 * would be noise rather than information.
 */
export function configureAuthzFixture(options) {
  current = new AuthzFixture(options);
  return current;
}

/** The configured fixture. Throws when a suite runs without `run.mjs`, which is a harness bug. */
export function authzFixture() {
  if (current === null) {
    throw new Error('the authorization fixture is not configured (run.mjs configures it at startup)');
  }
  return current;
}
