/**
 * Origin-based request hardening (M4 B4, `docs/CONTRACTS.md` §18.3/§18.4/§18.6, D-082 D1/D2).
 *
 * Two related but distinct jobs share one allow-list decision:
 *
 * 1. **CORS** — the API is served from a different origin than the Vite dev server, so an
 *    allowed origin must get `Access-Control-Allow-Origin: <origin>` plus
 *    `Access-Control-Allow-Credentials: true` (the session is an `HttpOnly` cookie, never a
 *    bearer token). `*` is illegal with credentials and would mean "any site may call the API
 *    with the user's cookie", so the configured origin is echoed back explicitly.
 * 2. **CSRF** — a state-changing request that carries an `Origin` header naming somebody else
 *    is refused with `403 origin_not_allowed`, *before* routing, body parsing or authorization.
 *    A browser cannot forge `Origin`; a non-browser client can, but it also has no ambient
 *    cookie, so requiring an allowed `Origin` only where a browser supplies one is the correct
 *    trade-off. Requests with **no** `Origin` (server-to-server clients, `curl`, the M0 verify
 *    script, the test harness) are deliberately allowed: see
 *    {@link createOriginGuard} for why that is not a hole.
 *
 * ## Why a hand-written guard instead of the `cors` package
 *
 * `cors` can echo an origin and emit the preflight headers, but it has no notion of refusing a
 * request: a disallowed origin simply gets no header. §B4 requires a **403 with a body** for
 * state-changing methods and for preflights, which is a policy decision the middleware package
 * does not make. The dependency stays in `package.json` (that file is out of scope for B4) but
 * the request path no longer depends on it.
 *
 * ## The loopback alias (why it exists and why it is safe)
 *
 * `CORS_ORIGIN`'s development default is `http://localhost:5173` (`config.ts`), while the real
 * stack binds the Vite dev server to `127.0.0.1` (`apps/web/vite.config.ts`) and the real-browser
 * suite opens `http://127.0.0.1:5173`. Both names denote **the same loopback machine and port**;
 * a browser sends the page's literal origin, so a strict string comparison would refuse the
 * project's own browser client and make the A6 gate red for a spelling difference.
 *
 * {@link isAllowedOrigin} therefore treats `localhost`, `127.0.0.1` and `[::1]` as the same host
 * **only when the scheme and the port also match, and only when both sides are loopback**. That
 * cannot widen a deployment allow-list: the production gate (`startup.ts`) refuses anything but
 * an explicit `https://` origin, so a deployed server's configured origin is a public DNS name
 * and never joins this branch. It is not a second configured origin; it is one origin with two
 * spellings on one loopback interface.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** The methods a browser may preflight on this API. Kept explicit; nothing else is advertised. */
export const CORS_ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';

/**
 * The only request headers a browser may preflight.
 *
 * The API accepts exactly one request header from JavaScript — `content-type: application/json`
 * on bootstrap and on the AI route. Session identity travels in a cookie, which CORS does not
 * negotiate. Listing a header here that the API never reads would invite a client to send it and
 * would make an unread header look supported.
 */
export const CORS_ALLOWED_HEADERS = 'content-type';

/** Methods that can change state, and therefore require an allowed `Origin` when one is sent. */
const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Host spellings that denote the loopback interface for the alias rule in the file header. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Read the `Origin` request header as a usable value.
 *
 * Returns `undefined` for an absent **or blank** header: a browser never sends an empty `Origin`,
 * so a blank one is a non-browser client that supplied nothing meaningful, and the "no Origin"
 * policy (allow) is the honest reading. A duplicated header arrives joined with `", "` and is a
 * value no origin in the allow-list equals, so it is refused for state-changing methods rather
 * than being split and matched.
 */
export function readOriginHeader(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** True for a method that can mutate server state (`POST`, `PUT`, `PATCH`, `DELETE`). */
export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

/**
 * The one allow-list decision the HTTP guard and the WebSocket upgrade share.
 *
 * Exact match first (the normal case, and the only case a deployment can reach), then the
 * loopback alias documented in the file header.
 */
export function isAllowedOrigin(configuredOrigin: string, requestOrigin: string): boolean {
  const configured = configuredOrigin.trim();
  if (configured === '') return false;
  if (requestOrigin === configured) return true;
  return isSameLoopbackOrigin(configured, requestOrigin);
}

/**
 * Express middleware: CORS headers, preflight answers and the CSRF refusal.
 *
 * ## Ordering
 *
 * Mounted immediately after `x-powered-by` is disabled and **before any route**, so a refused
 * request is never parsed, never authorized and never reaches a handler. That is what makes the
 * 403 cheap and what makes "a disallowed origin cannot mutate state" a routing-level property
 * rather than a promise each endpoint has to keep.
 *
 * ## No `Origin` means a non-browser client, and it is allowed
 *
 * `Origin` is a browser-set header (`fetch`, XHR, WebSocket). A client that omits it is not a
 * browser and has no ambient session cookie to be tricked into sending, so CSRF does not apply.
 * Requiring it would break `curl`, the M0 verify script and every server-to-server caller for no
 * security gain, and it cannot be forged into a browser attack because a browser always sends
 * it. The trade-off is recorded in the task's threat-model handoff to A0.
 */
export function createOriginGuard(configuredOrigin: string): RequestHandler {
  const configured = configuredOrigin.trim();

  return (req: Request, res: Response, next: NextFunction): void => {
    // Every response depends on the request's Origin, including the ones that carry no CORS
    // header, so a shared cache must key on it.
    res.vary('Origin');

    const origin = readOriginHeader(req.headers.origin);

    if (origin === undefined) {
      next();
      return;
    }

    if (!isAllowedOrigin(configured, origin)) {
      if (req.method === 'OPTIONS' || isStateChangingMethod(req.method)) {
        // No `Access-Control-Allow-Origin` here: the body is for a human reading a proxy log,
        // and a browser must not be able to read this response cross-origin.
        res.status(403).json({ error: 'origin_not_allowed' });
        return;
      }
      // A disallowed origin asking for a safe method gets no CORS headers, so the browser
      // blocks the response while the server stays compatible with non-browser clients.
      next();
      return;
    }

    // Echo the request's origin, not the configured spelling: with the loopback alias the two
    // can differ, and the browser only accepts the ACAO value that matches its page origin.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
      res.status(204).end();
      return;
    }

    next();
  };
}

/**
 * True when two origins denote the same loopback host **and** port on the same scheme.
 *
 * Both values must be bare origins (no path, query, fragment or credentials); anything else is
 * not an origin and is refused rather than normalised into one.
 */
function isSameLoopbackOrigin(left: string, right: string): boolean {
  const parsedLeft = parseBareOrigin(left);
  const parsedRight = parseBareOrigin(right);
  if (parsedLeft === null || parsedRight === null) return false;
  if (parsedLeft.protocol !== parsedRight.protocol) return false;
  if (parsedLeft.port !== parsedRight.port) return false;
  return (
    LOOPBACK_HOSTNAMES.has(parsedLeft.hostname) && LOOPBACK_HOSTNAMES.has(parsedRight.hostname)
  );
}

/** Parse a bare `scheme://host[:port]` origin, or `null` for anything that is not one. */
function parseBareOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '') return null;
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
    if (url.hostname === '') return null;
    return url;
  } catch {
    return null;
  }
}
