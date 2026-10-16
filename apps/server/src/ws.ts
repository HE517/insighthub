/**
 * WebSocket collaboration transport.
 *
 * M0 scope: accept an upgrade on `config.wsPath`, assign a connection id and
 * send the `connected` handshake defined in `@insighthub/shared`.
 *
 * Explicitly NOT in M0: document rooms, Yjs sync frames, presence fan-out.
 * M1 (A3 Realtime Backend) builds those on top of the seams left here.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import {
  WS_MESSAGE_TYPES,
  createConnectedMessage,
  parseMessageJson,
  type WsServerMessage,
} from '@insighthub/shared';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ServerConfig } from './config.js';

export interface WebSocketHandle {
  readonly wss: WebSocketServer;
  /** Number of currently open sockets. */
  clientCount(): number;
  close(): Promise<void>;
}

/**
 * Attach the collaboration socket to an existing HTTP server.
 *
 * Uses `noServer` + an explicit `upgrade` handler so that a request to an
 * unexpected path is rejected with 404 instead of silently being accepted.
 */
export function attachWebSocketServer(server: Server, config: ServerConfig): WebSocketHandle {
  const wss = new WebSocketServer({ noServer: true });
  const connectionIds = new Map<WebSocket, string>();

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (pathname !== config.wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  const send = (ws: WebSocket, message: WsServerMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message));
  };

  wss.on('connection', (ws: WebSocket) => {
    const connectionId = randomUUID();
    connectionIds.set(ws, connectionId);

    // The M0 acceptance criterion: the client receives `{ type: "connected" }`.
    send(ws, createConnectedMessage(connectionId));

    ws.on('message', (raw) => {
      // Until M1 handles join-room, inbound frames are only validated and
      // logged. Malformed frames get an explicit error rather than silence.
      const parsed = parseMessageJson(raw.toString());
      if (!parsed.success) {
        send(ws, {
          type: WS_MESSAGE_TYPES.error,
          payload: { code: 'invalid_message', message: parsed.error ?? 'invalid message' },
          ts: new Date().toISOString(),
        });
        return;
      }
      // M1: route join-room / leave-room here.
    });

    ws.on('close', () => {
      connectionIds.delete(ws);
    });

    ws.on('error', (error: Error) => {
      console.error(`[ws] connection ${connectionId} error:`, error.message);
    });
  });

  return {
    wss,
    clientCount: () => connectionIds.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of connectionIds.keys()) {
          ws.terminate();
        }
        connectionIds.clear();
        wss.close(() => resolve());
      }),
  };
}
