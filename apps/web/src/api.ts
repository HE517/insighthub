/**
 * Thin HTTP client for the server API.
 *
 * Every call takes an AbortSignal and enforces its own timeout, so a slow or
 * dead server can never leave a request hanging forever (M0 seed for the
 * cancellation/stale-response work owned by A5).
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

/**
 * GET a JSON endpoint with cancellation + timeout.
 * Resolves with a discriminated result; never throws for expected failures.
 */
export async function getJson<T>(
  path: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  const { signal, timeoutMs = 5000 } = options;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('timeout', 'TimeoutError')),
    timeoutMs,
  );

  try {
    const response = await fetch(apiUrl(path), { signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        error: { kind: 'http', status: response.status, message: `HTTP ${response.status}` },
      };
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

export function fetchHealth(options?: {
  signal?: AbortSignal;
}): Promise<ApiResult<HealthResponse>> {
  return getJson<HealthResponse>('/health', options);
}
