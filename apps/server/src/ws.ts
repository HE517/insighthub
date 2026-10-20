/**
 * WebSocket collaboration transport.
 *
 * M0 scope: accept an upgrade on `config.wsPath`, assign a connection id and send
 * the `connected` handshake defined in `@insighthub/shared`.
 *
 * M1-A0 froze the two-plane model: TEXT frames are JSON control messages, BINARY
 * frames are collaboration data.
 *
 * M1-A3 (this change) implements the realtime backend on top of those seams:
 *
 * - document rooms via `RoomRegistry`, with the one-socket-one-room rule and atomic
 *   replace on re-join (`docs/CONTRACTS.md` §5.4);
 * - Yjs sync relay and awareness fan-out, using the shared codec only — this file
 *   contains no frame parsing at all (`AGENTS.md` R12);
 * - connection lifecycle: heartbeat, dead-socket termination, and one teardown path
 *   so a disappearing client cannot leave a zombie participant behind.
 *
 * This module owns **only** transport concerns: framing decisions, error delivery,
 * liveness and shutdown. Membership, Yjs state and awareness cleanup live in
 * `./rooms/**`.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';

import {
  WS_ERROR_CODES,
  WS_MESSAGE_TYPES,
  createConnectedMessage,
  createErrorMessage,
  createRoomJoinedMessage,
  isFatalErrorCode,
  parseMessageJson,
  type DocumentRole,
  type WsErrorCode,
  type WsServerMessage,
} from '@insighthub/shared';
import { WebSocketServer, type WebSocket } from 'ws';

import type { AuthzService } from './authz/public.js';
import type { ServerConfig } from './config.js';
import { Heartbeat } from './rooms/heartbeat.js';
import { RoomRegistry, type HydrationOutcome, type RoomRegistryOptions } from './rooms/registry.js';
import type { SocketContext } from './rooms/context.js';
import type { DocumentRoom } from './rooms/room.js';

export interface WebSocketHandle {
  readonly wss: WebSocketServer;
  /** The room registry, exposed for operational introspection and tests. */
  readonly registry: RoomRegistry;
  /** Number of currently open sockets. */
  clientCount(): number;
  /**
   * Run one heartbeat liveness round immediately.
   *
   * Exposed for tests: the real heartbeat runs on a 30 s interval, so proving that a
   * client which vanished without a close frame is reaped must drive the same code
   * without sleeping for it. Production never calls this — `start()` owns the
   * interval.
   */
  heartbeatSweep(): void;
  /**
   * Treat the socket with this connection id as unresponsive for the next sweep.
   *
   * A local test client always answers a ping at the TCP layer, so "the peer is gone but
   * the socket is still open" cannot be produced from the client side. This simulates the
   * heartbeat's own detection so the **cleanup** it triggers — room membership, awareness
   * removal and broadcast, context, timers — runs for real over a real socket. Production
   * never calls it.
   */
  markPeerUnresponsive(connectionId: string): void;
  close(): Promise<void>;
}

/** Known control-plane `type` values, for the invalid-vs-unknown distinction. */
const KNOWN_MESSAGE_TYPES: ReadonlySet<string> = new Set(Object.values(WS_MESSAGE_TYPES));

/**
 * True when the raw frame is JSON carrying a `type` this build implements.
 *
 * Used only to choose between `INVALID_MESSAGE` (the peer speaks our protocol but
 * sent a malformed payload) and `UNKNOWN_MESSAGE_TYPE` (the peer speaks a protocol
 * version we do not implement, e.g. the deleted `presence` message). A frame that is
 * not decodable JSON, or has no usable `type`, counts as invalid.
 */
function hasKnownMessageType(raw: string): boolean {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return true; // not a protocol message at all -> INVALID_MESSAGE
  }
  if (typeof decoded !== 'object' || decoded === null || !('type' in decoded)) {
    return true;
  }
  return KNOWN_MESSAGE_TYPES.has(String((decoded as { type: unknown }).type));
}

/**
 * Options for the socket layer.
 *
 * Extends the registry's options so a test can inject a logger or a join gate, and
 * adds the heartbeat knobs. Heartbeat defaults are the production constants; a test
 * narrows them to prove the reaper without waiting out the real window.
 */
export interface WebSocketServerOptions extends RoomRegistryOptions {
  heartbeat?: { intervalMs?: number; timeoutMs?: number };
}

/**
 * Attach the collaboration socket to an existing HTTP server.
 *
 * Uses `noServer` + an explicit `upgrade` handler so that a request to an unexpected
 * path is rejected with 404 instead of silently being accepted.
 */
export function attachWebSocketServer(
  server: Server,
  config: ServerConfig,
  options: WebSocketServerOptions = {},
): WebSocketHandle {
  // Fail closed on an ambiguous wiring: a config that names a data directory but arrives
  // without a store means somebody forgot the `openDocumentStore()` step. Continuing here
  // would silently run without durable storage — the M1 data-loss mode that `M2-P0-1`
  // removes (`docs/DECISIONS.md` D-051).
  if (options.store === undefined && config.dataPath !== undefined) {
    throw new Error(
      'durable storage is configured (config.dataPath) but no DocumentStore was supplied: ' +
        'await openDocumentStore(config.dataPath) and pass it as options.store',
    );
  }

  // The same fail-closed rule for authorization: a server that names a data directory is a
  // production-shaped server, and one of those must never accept an unauthenticated socket.
  // Without this the mistake is invisible — the transport simply stops enforcing
  // (`docs/CONTRACTS.md` §17.5), which looks like "permissions are broken" rather than "nobody
  // wired the resolver".
  if (options.authz === undefined && config.dataPath !== undefined) {
    throw new Error(
      'durable storage is configured (config.dataPath) but no AuthzService was supplied: ' +
        'await createAuthz({ dataPath }) and pass it as options.authz',
    );
  }

  const wss = new WebSocketServer({ noServer: true });
  const registry = new RoomRegistry(options);
  const authz: AuthzService | undefined = options.authz;
  const heartbeat = new Heartbeat({
    ...options.heartbeat,
    onTerminate: (reason) => {
      // Logged only: the peer that failed this check cannot be told anything.
      console.warn(`[ws] terminating peer: ${reason}`);
    },
  });

  /** The context for each live socket, so teardown knows which one died. */
  const contextBySocket = new Map<WebSocket, SocketContext>();

  /**
   * Identity resolved during the upgrade, handed to the `connection` handler.
   *
   * A `WeakMap` keyed by the upgrade request, not a header and not a query parameter: the
   * resolved `userId` never becomes part of anything the socket layer reads, so no frame,
   * header or query string can supply or override it (`docs/CONTRACTS.md` §17.5).
   */
  const userIdByUpgrade = new WeakMap<IncomingMessage, string>();

  /**
   * Refuse an unauthenticated upgrade with HTTP `401` (`docs/CONTRACTS.md` §17.5).
   *
   * Done at the HTTP level, before `handleUpgrade`, so **no WebSocket is established** — the
   * contract's wording, and the difference between "the client is told it has no session" and
   * "the client gets a socket that is then closed for reasons it must infer".
   *
   * The identity comes from the session cookie and from nowhere else: a `userId` in the query
   * string, in a header or in a later payload is not consulted, not validated and not logged
   * as a candidate (§17.1, §17.5).
   */
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (pathname !== config.wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (authz !== undefined) {
      const session = authz.resolveSession(request.headers.cookie);
      if (session === null) {
        // 401 with the same body shape the HTTP API uses for an unauthenticated caller
        // (§17.4), so one client rule covers both transports.
        const body = JSON.stringify({ error: 'unauthenticated' });
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\n' +
            'Connection: close\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            '\r\n' +
            body,
        );
        socket.destroy();
        return;
      }
      // Carried to the socket's context below. The cookie is not retained: only the resolved
      // identity is, so a token cannot leak into a room, a log line or an error message.
      userIdByUpgrade.set(request, session.userId);
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  /**
   * Send a server control message on the TEXT plane.
   *
   * Every `connected`, `room-joined` and `error` travels here — including errors
   * *caused* by a binary frame. A client must never infer an error's cause from the
   * frame kind it arrives on (`docs/ARCHITECTURE.md` §5).
   */
  const sendControl = (context: SocketContext, message: WsServerMessage): void => {
    context.peer.sendControl(message);
  };

  /**
   * Report a failure and enforce its fatality.
   *
   * Whether the socket dies is answered by `isFatalErrorCode` from the shared
   * contract rather than by the call site, so `ROOM_NOT_JOINED` keeps the socket open
   * while `INVALID_BINARY_FRAME` and `FRAME_TOO_LARGE` close it. The message is a
   * short human-facing string: never a stack trace, path or internal identifier.
   */
  const fail = (context: SocketContext, code: WsErrorCode, message: string): void => {
    sendControl(context, createErrorMessage(code, message));
    if (isFatalErrorCode(code)) {
      context.peer.close(1008, code);
    }
  };

  /**
   * Acknowledge a join, after the room's hydration barrier has released.
   *
   * ## The two-phase join (`docs/DECISIONS.md` D-043)
   *
   * Membership is already applied synchronously by `registry.joinRoom`. What this function
   * does is wait for **content readiness** and only then send `room-joined`, which the
   * contract already defines as the "before the data plane" gate (`docs/CONTRACTS.md` §4).
   * Deferring the acknowledgement needs no protocol change; making `joinRoom` itself async
   * would have reopened the intermediate-state bug M1 closed.
   *
   * ## Why the result is re-validated after the await
   *
   * A socket can close, or be atomically replaced into another room, while the load is in
   * flight. Sending `room-joined` then would acknowledge a room the client is no longer in —
   * or write to a dead socket (`docs/DECISIONS.md` D-049 obligation 1). So the barrier
   * result is **discarded** in that case: no delayed acknowledgement, no re-join, no flush.
   */
  const acknowledgeJoin = async (
    context: SocketContext,
    documentId: string,
    peers: string[],
    room: DocumentRoom,
    barrier: Promise<HydrationOutcome>,
    requestId: string | undefined,
    role: DocumentRole,
  ): Promise<void> => {
    const outcome = await barrier;

    if (!outcome.ok) {
      // `UNHEALTHY`: the registry already sent INTERNAL_ERROR to every participant and
      // closed them. `evicted`: the room went away while loading; there is nobody to
      // acknowledge and nothing to report.
      return;
    }

    // Re-validate (see the doc comment): the socket may have left, been replaced into
    // another room, or closed while the load was running.
    if (!context.peer.isOpen()) return;
    if (context.activeRoom !== room) return;

    sendControl(
      context,
      createRoomJoinedMessage(
        { documentId, connectionId: context.connectionId, peers, role },
        requestId === undefined ? {} : { requestId },
      ),
    );

    // Only now may the data plane carry anything for this room (§4). A joiner is told about
    // collaborators who announced before it arrived, otherwise presence stays invisible
    // until they happen to publish again (up to the 30 s awareness renewal).
    room.sendExistingAwarenessTo(context);

    // Frames a non-conforming client sent while the room was still hydrating are replayed
    // only after its acknowledgement, so the contract's ordering holds for their author.
    await registry.releaseHydrationBacklog(room);
  };

  /**
   * Route one TEXT control frame.
   *
   * Parsing uses the shared parser, which never throws and rejects unknown `type`
   * values rather than ignoring them, so protocol drift fails loudly
   * (`docs/DECISIONS.md` D-003).
   */
  const handleControlFrame = (context: SocketContext, text: string): void => {
    const parsed = parseMessageJson(text);
    if (!parsed.success || parsed.data === undefined) {
      // Distinguish "well-formed envelope with an unknown type" from "not parseable
      // at all": different faults, different fixes, and the frozen vocabulary has a
      // code for each. This is what makes a stale client speaking the deleted
      // `presence` message fail loudly instead of looking like corruption.
      fail(
        context,
        hasKnownMessageType(text)
          ? WS_ERROR_CODES.INVALID_MESSAGE
          : WS_ERROR_CODES.UNKNOWN_MESSAGE_TYPE,
        parsed.error ?? 'invalid message',
      );
      return;
    }

    const message = parsed.data;
    const requestId = message.requestId;

    if (message.type === WS_MESSAGE_TYPES.joinRoom) {
      const result = registry.joinRoom(context, message.payload);
      if (!result.ok) {
        fail(context, result.code, result.message);
        return;
      }
      // Deliberately not awaited here: membership is synchronous (that is the invariant),
      // and the acknowledgement is what waits (D-043). A rejection is impossible — the
      // barrier promises are built to settle, never to throw — but the transport still
      // must not leak an unhandled rejection if that ever changes.
      void acknowledgeJoin(
        context,
        result.documentId,
        result.peers,
        result.room,
        result.barrier,
        requestId,
        result.role,
      ).catch((error: unknown) => {
        console.error(
          `[ws] connection ${context.connectionId} join acknowledgement failed:`,
          error instanceof Error ? error.message : String(error),
        );
      });
      return;
    }

    if (message.type === WS_MESSAGE_TYPES.leaveRoom) {
      // A `leave-room` for a document this socket is not in is an explicit no-op: it
      // must never drop the room the socket actually occupies. There is no
      // acknowledgement in the frozen protocol — the contract says a client must not
      // wait for one, and `room-joined` is the signal that a switch completed.
      registry.leaveRoom(context, message.payload.documentId);
      return;
    }

    // The shared parser accepted a type this server does not route. That is a
    // protocol disagreement, not a payload fault.
    fail(context, WS_ERROR_CODES.UNKNOWN_MESSAGE_TYPE, `unhandled message type ${message.type}`);
  };

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const connectionId = randomUUID();
    // The identity comes from the session resolved at the upgrade — never from the frame
    // stream. `undefined` only in the no-authz mode described on `RoomRegistryOptions.authz`.
    const context = registry.registerSocket(ws, connectionId, userIdByUpgrade.get(request));
    contextBySocket.set(ws, context);
    heartbeat.track(ws);

    // The M0 acceptance criterion: the client receives `{ type: "connected" }`.
    sendControl(context, createConnectedMessage(connectionId));

    ws.on('message', (raw: Uint8Array | ArrayBuffer | Buffer | string, isBinary: boolean) => {
      const liveContext = contextBySocket.get(ws);
      // A frame from a socket whose context is gone belongs to no room. Dropping it
      // is the only safe option: routing it would need a room we do not have, and
      // R15 forbids guessing one.
      if (liveContext === undefined) return;

      if (isBinary) {
        // Framing, bounds, lifecycle gating and error classification are entirely the shared
        // codec's and the registry's job; the transport only delivers the outcome.
        //
        // `handleBinaryFrame` is async because persistence is awaited before broadcast
        // (`apply → persist → broadcast`, D-044). Per-document ordering does not depend on
        // this handler awaiting anything: the room's FIFO queue owns that, so two messages
        // arriving back to back still persist in arrival order.
        void registry
          .handleBinaryFrame(liveContext, toUint8Array(raw))
          .then((outcome) => {
            if (!outcome.ok) fail(liveContext, outcome.code, outcome.message);
          })
          .catch((error: unknown) => {
            // The registry converts its own failures into frozen codes; reaching here means
            // a genuine programming error. Log it and close, rather than leaving a socket in
            // an unknown state.
            console.error(
              `[ws] connection ${connectionId} binary frame failed:`,
              error instanceof Error ? error.message : String(error),
            );
            liveContext.peer.close(1011, 'INTERNAL_ERROR');
          });
        return;
      }

      handleControlFrame(liveContext, raw.toString());
    });

    ws.on('close', () => {
      heartbeat.untrack(ws);
      const liveContext = contextBySocket.get(ws);
      contextBySocket.delete(ws);
      if (liveContext === undefined) return;
      // The single teardown path: room membership, awareness removal + broadcast to
      // the peers that remain, context and timers all go through here. It is
      // idempotent, so a close racing the heartbeat's own termination cannot clean up
      // twice.
      registry.disconnect(liveContext);
    });

    ws.on('error', (error: Error) => {
      console.error(`[ws] connection ${connectionId} error:`, error.message);
    });
  });

  heartbeat.start();

  return {
    wss,
    registry,
    clientCount: () => registry.connectionCount,
    heartbeatSweep: () => heartbeat.sweep(),
    markPeerUnresponsive: (connectionId: string) => {
      for (const [ws, context] of contextBySocket) {
        if (context.connectionId !== connectionId) continue;
        // Simulate the detection decision, then let the production sweep reap it, so the
        // real termination and cleanup path runs over a real socket.
        heartbeat.markUnresponsive(ws);
        heartbeat.sweep();
        return;
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        heartbeat.stop();
        for (const ws of contextBySocket.keys()) {
          ws.terminate();
        }
        for (const context of contextBySocket.values()) {
          registry.disconnect(context);
        }
        contextBySocket.clear();
        registry.destroy();

        // `wss.close()` calls back once libuv reports every client socket closed. We have just
        // force-terminated all of them, so any further waiting is a stalled FIN rather than work
        // in progress — and an unbounded wait here is what turns "shutdown hangs" into "the whole
        // test gate never returns" (`docs/TASKS.md` TOOLING-P2).
        //
        // The bound is safe because this server is `noServer: true`: there is no listening handle
        // of its own to leak, and every socket is already terminated. Hitting the bound is
        // reported, never swallowed — silence would hide a real leak.
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          resolve();
        };
        const watchdog = setTimeout(() => {
          console.warn(
            `[ws] shutdown waited 2000ms for ${wss.clients.size} socket(s) to close; resolving anyway`,
          );
          settle();
        }, 2_000);
        // Reference-neutral: the stalled socket is what keeps the loop alive, so the watchdog
        // still fires when it matters, but a clean shutdown is not delayed by it.
        watchdog.unref?.();

        try {
          wss.close(() => settle());
        } catch (error: unknown) {
          // `wss.close()` throws if the server was never started; nothing to wait for.
          console.warn(`[ws] shutdown: ${error instanceof Error ? error.message : 'close failed'}`);
          settle();
        }
      }),
  };
}

/**
 * Normalise the shapes `ws` can hand us (`Buffer`, `ArrayBuffer` or a raw
 * `Uint8Array`) into one view, without copying when possible.
 *
 * No framing decision is made here — the bytes go straight to the shared codec.
 */
function toUint8Array(raw: Uint8Array | ArrayBuffer | Buffer | string): Uint8Array {
  if (typeof raw === 'string') {
    // A `string` on the binary channel means the frame was a text frame. An empty
    // byte view makes the codec report INVALID_BINARY_FRAME rather than letting text
    // be mistaken for collaboration data.
    return new Uint8Array(0);
  }
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}
