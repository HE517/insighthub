/**
 * Thin HTTP client for the server API.
 *
 * Every call takes an AbortSignal and enforces its own timeout, so a slow or
 * dead server can never leave a request hanging forever (M0 seed for the
 * cancellation/stale-response work owned by A5).
 *
 * ## M2 Phase 2: `credentials`
 *
 * The session travels in an `httpOnly` cookie (`docs/CONTRACTS.md` §17.2), so a call that needs
 * the session has to opt into sending it. `credentials: 'include'` is used **only** where the
 * cookie is required (`POST /api/session/bootstrap`) and not globally: the dev stack serves the
 * API through the Vite proxy on one origin, and spreading `include` across every request would
 * be a habit that breaks silently the day a second origin appears.
 *
 * Nothing in this module reads or writes the cookie. `document.cookie` is never touched — the
 * session cookie is `HttpOnly`, and P2-9 requires that no JS-reachable place holds the token.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export const apiUrl = (path: string): string => `${API_BASE}${path}`;

export interface HealthResponse {
  status: string;
}

export interface ApiError {
  kind: 'http' | 'network' | 'timeout' | 'aborted';
  message: string;
  status?: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface ApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** JSON body, serialised here. Ignored for `GET`/`HEAD`. */
  body?: unknown;
  /** Defaults to `same-origin` (the browser default). Session calls pass `include`. */
  credentials?: RequestCredentials;
}

/**
 * Perform one JSON request with cancellation + timeout.
 *
 * Resolves with a discriminated result; never throws for expected failures. A caller that wants
 * to distinguish "refused" from "unreachable" reads `error.kind` / `error.status`; it never has to
 * catch.
 */
export async function requestJson<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
  const { signal, timeoutMs = 5000, body, credentials = 'same-origin' } = options;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('timeout', 'TimeoutError')),
    timeoutMs,
  );

  const headers: Record<string, string> =
    body === undefined ? {} : { 'content-type': 'application/json' };

  try {
    const response = await fetch(apiUrl(path), {
      method,
      signal: controller.signal,
      credentials,
      headers,
      // A GET with a body is not a thing; keeping the branch explicit avoids a silent cast.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: { kind: 'http', status: response.status, message: `HTTP ${response.status}` },
      };
    }
    // `204 No Content` is a success with no body (the frozen `DELETE /api/session` response,
    // `docs/CONTRACTS.md` §17.4). Parsing it as JSON would throw and turn a successful delete into
    // a `network` error, so the empty-body case is answered before the parser is reached.
    if (response.status === 204 || response.status === 205) {
      return { ok: true, data: undefined as T };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      const timedOut = reason instanceof DOMException && reason.name === 'TimeoutError';
      return {
        ok: false,
        error: timedOut
          ? { kind: 'timeout', message: `request timed out after ${timeoutMs}ms` }
          : { kind: 'aborted', message: 'request aborted' },
      };
    }
    return {
      ok: false,
      error: { kind: 'network', message: error instanceof Error ? error.message : 'network error' },
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** GET a JSON endpoint with cancellation + timeout. */
export function getJson<T>(
  path: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  return requestJson<T>('GET', path, options);
}

/** POST a JSON body. Used for the session bootstrap, which must send its cookie. */
export function postJson<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
  return requestJson<T>('POST', path, options);
}

/**
 * DELETE a resource. `204` resolves `ok: true` with `undefined`, which is what the session
 * logout path needs (`docs/CONTRACTS.md` §17.4: `DELETE /api/session` → `204`).
 */
export function deleteJson<T = void>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
  return requestJson<T>('DELETE', path, options);
}

export function fetchHealth(options?: {
  signal?: AbortSignal;
}): Promise<ApiResult<HealthResponse>> {
  return getJson<HealthResponse>('/health', options);
}
