/**
 * M0 control-plane channel — **not mounted in the running app** (M1-A0.2).
 *
 * This hook opened a second `/ws` socket alongside the session's own connection. One
 * socket carries at most one document room (`docs/CONTRACTS.md` §5.4, R15), so mounting
 * it in production would either be rejected by the server or split the app across two
 * transports. The document realtime connection is owned solely by `CollaborativeSession`,
 * reached through `apps/web/src/collab/public.ts`.
 *
 * It is kept because it documents the M0 acceptance evidence (`/health` plus a `connected`
 * handshake on `/ws`), and `apps/server/scripts/m0-verify.mjs` proves that path against a
 * real server. **Do not mount it in `App.tsx`.** Anything needing connection status should
 * read the live session's `connectionStatus` via
 * `apps/web/src/features/status/connectionPresentation.ts`.
 *
 * Behaviour if ever mounted: connect, validate every inbound frame with the shared parser,
 * push accepted messages into Redux, and reconnect with capped exponential backoff.
 */
import { useEffect, useRef } from 'react';

import { parseMessageJson } from '@insighthub/shared';

import { connectionActions } from '../store/connectionSlice.js';
import { useAppDispatch } from '../store/hooks.js';
import { realtimeActions } from '../store/realtimeSlice.js';

const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10_000;

/** Derive the WS URL: explicit env override first, then the current origin. */
export function resolveWsUrl(): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (configured !== undefined && configured.trim() !== '') return configured;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function useRealtimeChannel(url: string = resolveWsUrl()): void {
  const dispatch = useAppDispatch();
  const attemptRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleReconnect = (): void => {
      if (disposed) return;
      const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** attemptRef.current, MAX_RETRY_DELAY_MS);
      attemptRef.current += 1;
      retryTimer = setTimeout(open, delay);
    };

    const open = (): void => {
      if (disposed) return;
      dispatch(
        attemptRef.current === 0
          ? connectionActions.connecting()
          : connectionActions.reconnecting(),
      );

      const ws = new WebSocket(url);
      socket = ws;

      ws.onmessage = (event: MessageEvent<string>) => {
        const parsed = parseMessageJson(event.data);
        if (!parsed.success || parsed.data === undefined) {
          dispatch(realtimeActions.protocolError(parsed.error ?? 'invalid server message'));
          return;
        }
        // Every control-plane message this build can receive is recorded. There is
        // no `presence` message: ephemeral presence comes from Yjs awareness only.
        const message = parsed.data;
        if (message.type === 'connected') {
          attemptRef.current = 0;
          dispatch(connectionActions.connected({ connectionId: message.payload.connectionId }));
        }
        if (
          message.type === 'connected' ||
          message.type === 'room-joined' ||
          message.type === 'error'
        ) {
          dispatch(realtimeActions.serverMessageReceived(message));
        }
      };

      ws.onerror = () => {
        dispatch(connectionActions.failed('websocket error'));
      };

      ws.onclose = () => {
        if (disposed) return;
        dispatch(connectionActions.disconnected());
        scheduleReconnect();
      };
    };

    open();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [dispatch, url]);
}
