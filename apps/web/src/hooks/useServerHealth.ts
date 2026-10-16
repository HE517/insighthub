/**
 * Polls GET /health so the UI can prove the backend is reachable, and so the
 * AbortController pattern (cancel on unmount, ignore stale responses) exists
 * from day one instead of being retrofitted later.
 */
import { useEffect, useState } from 'react';

import { fetchHealth, type HealthResponse } from '../api.js';

export type HealthState =
  | { status: 'loading' }
  | { status: 'ok'; data: HealthResponse }
  | { status: 'error'; message: string };

export function useServerHealth(pollMs = 5000): HealthState {
  const [state, setState] = useState<HealthState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const check = async (): Promise<void> => {
      const result = await fetchHealth({ signal: controller.signal });
      if (cancelled) return; // stale response guard: unmount wins
      setState(
        result.ok
          ? { status: 'ok', data: result.data }
          : { status: 'error', message: result.error.message },
      );
    };

    void check();
    const timer = setInterval(() => void check(), pollMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
      controller.abort();
    };
  }, [pollMs]);

  return state;
}
