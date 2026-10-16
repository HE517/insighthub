/**
 * Outbound side of one WebSocket connection, as the room layer sees it.
 *
 * The room layer must not know about `ws`, heartbeats or HTTP — it only needs
 * "write these bytes to this peer". Keeping that behind an interface has two
 * payoffs:
 *
 * 1. the backpressure policy lives in exactly one place (`class Peer`), and
 * 2. a room is unit-testable without opening a socket.
 */
import { MAX_BINARY_FRAME_BYTES, createErrorMessage, type WsErrorCode } from '@insighthub/shared';

import { SLOW_CLIENT_BUFFER_LIMIT_BYTES, SLOW_CLIENT_CLOSE_CODE } from './constants.js';

/** Minimal structural view of the bits of `ws.WebSocket` this layer uses. */
export interface SocketLike {
  readonly readyState: number;
  /** Bytes queued in the socket but not yet written to the OS. */
  readonly bufferedAmount: number;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** `ws` `readyState` value for an open socket. */
const WS_OPEN = 1;

export interface Peer {
  readonly connectionId: string;
  /** True while the underlying socket can still accept frames. */
  isOpen(): boolean;
  /**
   * Send a validated server control message as a TEXT frame.
   *
   * Returns false when the write was refused (socket gone, or the peer is too far
   * behind to be worth queueing for). Callers treat `false` as "this peer is
   * finished" — the socket is already closing.
   */
  sendControl(message: object): boolean;
  /** Send a raw binary collaboration frame. Same false-means-dropped contract. */
  sendBinary(frame: Uint8Array): boolean;
  /** Send a frozen-vocabulary error. Non-fatal codes never close the socket. */
  sendError(code: WsErrorCode, message: string, requestId?: string): boolean;
  /** Client-requested close. */
  close(code?: number, reason?: string): void;
  /** Abrupt close, for a peer that cannot be trusted to answer a close frame. */
  terminate(): void;
}

export class PeerImpl implements Peer {
  readonly connectionId: string;
  readonly #socket: SocketLike;

  constructor(socket: SocketLike, connectionId: string) {
    this.#socket = socket;
    this.connectionId = connectionId;
  }

  isOpen(): boolean {
    return this.#socket.readyState === WS_OPEN;
  }

  sendControl(message: object): boolean {
    return this.#write(JSON.stringify(message));
  }

  sendBinary(frame: Uint8Array): boolean {
    // The codec caps a *received* frame at MAX_BINARY_FRAME_BYTES. A room-level
    // frame is a relay or a state-vector reply, so exceeding the shared ceiling
    // would mean we are about to make a peer reject our own message. Refuse to
    // send rather than corrupt the conversation.
    if (frame.byteLength > MAX_BINARY_FRAME_BYTES) return false;
    return this.#write(frame);
  }

  sendError(code: WsErrorCode, message: string, requestId?: string): boolean {
    return this.sendControl(
      createErrorMessage(code, message, requestId === undefined ? {} : { requestId }),
    );
  }

  close(code?: number, reason?: string): void {
    try {
      this.#socket.close(code, reason);
    } catch {
      // A socket already past CLOSING throws on a second close; that is not an
      // error worth propagating into the room layer.
    }
  }

  terminate(): void {
    try {
      this.#socket.terminate();
    } catch {
      // Same reasoning as `close`.
    }
  }

  /**
   * The single write path, and therefore the single backpressure enforcement
   * point.
   *
   * A peer whose socket buffer already holds `SLOW_CLIENT_BUFFER_LIMIT_BYTES` is
   * dropped instead of queued: queueing would convert one slow reader into
   * unbounded server memory growth, which is the failure mode this guard exists to
   * prevent. Note we do NOT try to send a "you are too slow" error first — the
   * buffer is full precisely because frames are not draining, so an extra frame
   * would make the condition worse.
   */
  #write(data: string | Uint8Array): boolean {
    if (this.#socket.readyState !== WS_OPEN) return false;

    if (this.#socket.bufferedAmount > SLOW_CLIENT_BUFFER_LIMIT_BYTES) {
      this.#socket.close(SLOW_CLIENT_CLOSE_CODE, 'slow client: send buffer limit exceeded');
      return false;
    }

    try {
      this.#socket.send(data);
      return true;
    } catch {
      // A write to a socket that closed between the readyState check and `send`
      // is a disconnect, not a server fault. The close handler does the cleanup.
      return false;
    }
  }
}
