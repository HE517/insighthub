/**
 * Request-scoped structured logging (M4 B9, `docs/DECISIONS.md` D-082 §5).
 *
 * ## What one request produces
 *
 * ```text
 * http.request { requestId, userId?, documentId?, method, path, status, durationMs, errorCode? }
 * ```
 *
 * - **One line per completed request**, emitted from the response's `finish` event so the status
 *   and the duration are final (a handler cannot log a status it later changes).
 * - `requestId` is a fresh UUID for every request — **not** derived from a client header, so two
 *   requests can never be conflated and a client cannot choose its own correlation id.
 * - `path` is the pathname only. The query string is deliberately **not** logged: it is the one
 *   part of a URL a caller can use to smuggle a token, an e-mail or document text, and the server
 *   has no reason to keep it. Not even the key names — a key can carry a secret too.
 * - The body, the `Cookie` header, `Authorization` and every other header are never read by this
 *   middleware. It cannot leak what it never touches (see `logger.ts` for the second layer).
 * - `errorCode` is the **frozen** code from the response body (`not_found`, `session_required`,
 *   `rate_limited`, …) when there is one, otherwise a stable status mapping. It is never a
 *   message: a message can contain the user's content or a SQL fragment.
 *
 * ## Correlation
 *
 * The middleware installs a child logger on the response under a private key. Routes that
 * resolve an identity call {@link bindRequestUser}; routes that resolve a document call
 * {@link bindRequestDocument}. The **same** child is then used by the route's own events (AI,
 * …) and by the final `http.request` line, so request ↔ session ↔ document is one id family.
 *
 * ## Level
 *
 * `status < 400` → `info`. `status >= 400` → `error`, with `errorCode`. A failed request is an
 * error the operator must be able to find without knowing which route handled it.
 */
import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { NOOP_LOGGER, type Logger, type LogFields } from './logger.js';

/** Key in `res.locals`; namespaced so it cannot collide with a route's own locals. */
const REQUEST_STATE_KEY = 'insighthub.logging.request';

interface RequestLogState {
  readonly requestId: string;
  /** Rebound (not mutated in place) when the identity or document becomes known. */
  logger: Logger;
  readonly startedAt: number;
  /** The frozen `error` code captured from the response body, if any. */
  errorCode?: string;
}

/** True for a plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The request pathname, never the query string. */
function requestPath(req: Request): string {
  // `req.path` is Express's parsed pathname. The fallback covers a hand-built request object;
  // it still strips the query for the same reason.
  const path = typeof req.path === 'string' && req.path !== '' ? req.path : req.url;
  return path.split('?')[0] ?? '/';
}

/**
 * Stable fallback codes by status, used only when the response body carried no `error` field.
 *
 * These are classes, not prose: the exact code a route chose is captured from the body in
 * {@link captureErrorCode}, so the map matters for responses that are not JSON error bodies
 * (a static 404, an Express refusal).
 */
function errorCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 429:
      return 'rate_limited';
    case 500:
      return 'internal_error';
    case 502:
      return 'provider_error';
    case 503:
      return 'service_unavailable';
    case 504:
      return 'timeout';
    default:
      return status >= 500 ? 'server_error' : 'client_error';
  }
}

/**
 * Observe the response body's `error` field without changing it.
 *
 * The body is the contract's own stable vocabulary (`docs/CONTRACTS.md` §12/§18), so reading it
 * is more accurate than mapping the status again: `403 origin_not_allowed` and
 * `403 forbidden` are the same status but different events. The wrapper delegates to the
 * original `json` untouched — only observed — so response bytes are unchanged.
 */
function captureErrorCode(res: Response, state: RequestLogState): void {
  const original = res.json;
  res.json = function jsonObserved(this: Response, body?: unknown): Response {
    if (isRecord(body) && typeof body['error'] === 'string') {
      state.errorCode = body['error'];
    }
    return original.call(this, body);
  } as Response['json'];
}

/** Round a duration to 0.1 ms: enough precision for a request log, no float noise. */
function roundDuration(milliseconds: number): number {
  return Math.round(milliseconds * 10) / 10;
}

/** The state installed by the middleware, if any. */
function stateOf(res: Response): RequestLogState | undefined {
  const state = (res.locals as Record<string, unknown>)[REQUEST_STATE_KEY];
  return state === undefined ? undefined : (state as RequestLogState);
}

/**
 * Install request logging. Must be the **first** middleware so a request refused by the origin
 * guard or the body parser still produces its `http.request` line.
 */
export function requestLogging(logger: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = randomUUID();
    const state: RequestLogState = {
      requestId,
      logger: logger.child({ requestId }),
      startedAt: performance.now(),
    };
    (res.locals as Record<string, unknown>)[REQUEST_STATE_KEY] = state;
    captureErrorCode(res, state);

    res.on('finish', () => {
      const status = res.statusCode;
      const failed = status >= 400;
      const fields: Record<string, unknown> = {
        method: req.method,
        path: requestPath(req),
        status,
        durationMs: roundDuration(performance.now() - state.startedAt),
      };
      if (failed) fields['errorCode'] = state.errorCode ?? errorCodeForStatus(status);
      state.logger.log(failed ? 'error' : 'info', 'http.request', fields);
    });

    next();
  };
}

/** The request id for this response, or `undefined` when logging was not installed. */
export function getRequestId(res: Response): string | undefined {
  return stateOf(res)?.requestId;
}

/**
 * The request-scoped logger.
 *
 * Falls back to {@link NOOP_LOGGER} so a route can call it unconditionally, and so a test that
 * builds a bare Express app is not forced to install the middleware just to import a route.
 */
export function requestLogger(res: Response): Logger {
  return stateOf(res)?.logger ?? NOOP_LOGGER;
}

/**
 * Attach the authenticated **internal** user id (`docs/CONTRACTS.md` §18.1) to this request.
 *
 * Called only after `resolveAuthenticatedUser` returned a user, so an unauthenticated request
 * never gets a `userId` field and a client-supplied id has no path here.
 */
export function bindRequestUser(res: Response, userId: string): void {
  const state = stateOf(res);
  if (state === undefined) return;
  state.logger = state.logger.child({ userId });
}

/** Attach the document id a request is about, after the route has parsed it. */
export function bindRequestDocument(res: Response, documentId: string): void {
  const state = stateOf(res);
  if (state === undefined) return;
  state.logger = state.logger.child({ documentId });
}

/** Emit one route-level event on the request-scoped logger. Convenience for call sites. */
export function logRequestEvent(
  res: Response,
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: LogFields = {},
): void {
  requestLogger(res).log(level, event, fields);
}
