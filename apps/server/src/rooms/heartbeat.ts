/**
 * Liveness detection for open sockets.
 *
 * ## Why not rely on the `close` event
 *
 * A TCP connection does not fail when the peer *vanishes*: if a laptop lid closes, a
 * phone loses signal or a process is killed, the socket stays open on the server side
 * indefinitely (until the OS keep-alive fires, which is measured in hours). Nothing calls
 * `close`, so room membership, awareness entries, timers and context objects would all
 * leak — and, worse, the room would keep a "participant" that never answers, which is the
 * zombie the task brief calls out.
 *
 * ## What this does
 *
 * A standard ping/pong sweep:
 *
 * - every `HEARTBEAT_INTERVAL_MS`, mark each socket as not yet alive for this round and
 *   send a WebSocket ping;
 * - a socket that answers with a pong (or sends any traffic at all) is marked alive;
 * - `HEARTBEAT_TIMEOUT_MS` after the ping, any socket still not alive is **terminated**,
 *   not politely closed, because a peer that cannot answer a ping cannot be trusted to
 *   complete a close handshake.
 *
 * Termination is only the transport half: the caller's `close` handler runs the full
 * cleanup (room membership, awareness removal + broadcast, context, timers), so there is
 * exactly one teardown path (`RoomRegistry.disconnect`).
 */
import {
  DEAD_SOCKET_CLOSE_CODE,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
} from './constants.js';

/** The bits of a socket the heartbeat needs. */
export interface HeartbeatSocket {
  readonly readyState: number;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'pong', listener: () => void): unknown;
  on(event: 'message', listener: () => void): unknown;
}

export interface HeartbeatOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Invoked after a socket is terminated as unresponsive. */
  onTerminate?: (reason: string) => void;
}

interface Liveness {
  alive: boolean;
  terminated: boolean;
}

const WS_OPEN = 1;

export class Heartbeat {
  readonly #sockets = new Map<HeartbeatSocket, Liveness>();
  /** Socket → the timer that will reap it if it does not answer this round. */
  readonly #reapTimers = new Map<HeartbeatSocket, NodeJS.Timeout>();
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #onTerminate: ((reason: string) => void) | undefined;
  #sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: HeartbeatOptions = {}) {
    this.#intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.#onTerminate = options.onTerminate;
  }

  /** Track a socket. Any pong or inbound message counts as proof of life. */
  track(socket: HeartbeatSocket): void {
    this.#sockets.set(socket, { alive: true, terminated: false });

    const markAlive = (): void => {
      const liveness = this.#sockets.get(socket);
      if (liveness !== undefined) liveness.alive = true;
    };

    socket.on('pong', markAlive);
    // Inbound traffic is equally good evidence: a busy socket that is slow to pong must
    // not be reaped. `ws` emits `message` before the handler in `ws.ts` runs, so this
    // cannot be starved by a slow handler.
    socket.on('message', markAlive);
  }

  /** Stop tracking a socket and cancel any pending reap for it. */
  untrack(socket: HeartbeatSocket): void {
    this.#sockets.delete(socket);
    const timer = this.#reapTimers.get(socket);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#reapTimers.delete(socket);
    }
  }

  /**
   * Record that a tracked socket has proven liveness.
   *
   * Equivalent to what an inbound pong or message does, and exposed separately so a test
   * can model liveness precisely in cases a real socket cannot produce — notably a client
   * that still answers at the TCP layer but must nevertheless be treated as unresponsive.
   */
  markAlive(socket: HeartbeatSocket): void {
    const liveness = this.#sockets.get(socket);
    if (liveness !== undefined) liveness.alive = true;
  }

  /** True while the heartbeat still tracks `socket` (i.e. it has not been reaped). */
  isTracked(socket: HeartbeatSocket): boolean {
    return this.#sockets.has(socket);
  }

  /**
   * Force `socket` to be treated as unresponsive on the next `sweep()`.
   *
   * Needed because a real test client answers every ping at the TCP layer, so the state
   * this method creates — an open socket that has produced nothing — cannot be produced
   * from the outside. The reap path it triggers is the production path.
   */
  markUnresponsive(socket: HeartbeatSocket): void {
    const liveness = this.#sockets.get(socket);
    if (liveness === undefined) return;
    liveness.alive = false;
    // Cancel a pending reap so there is exactly one termination, driven by the sweep.
    const timer = this.#reapTimers.get(socket);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#reapTimers.delete(socket);
    }
  }

  start(): void {
    if (this.#sweepTimer !== null) return;
    this.#sweepTimer = setInterval(() => this.sweep(), this.#intervalMs);
    // Never hold the process open just for the heartbeat; shutdown must not hang.
    this.#sweepTimer.unref?.();
  }

  stop(): void {
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    for (const timer of this.#reapTimers.values()) clearTimeout(timer);
    this.#reapTimers.clear();
    this.#sockets.clear();
  }

  get trackedCount(): number {
    return this.#sockets.size;
  }

  /**
   * One liveness round.
   *
   * Exposed (rather than hidden inside the interval) so a test can drive the exact same
   * code deterministically instead of sleeping for a real heartbeat period.
   */
  sweep(): void {
    for (const [socket, liveness] of [...this.#sockets]) {
      if (socket.readyState !== WS_OPEN) {
        this.untrack(socket);
        continue;
      }
      if (liveness.terminated) continue;

      if (!liveness.alive) {
        // Missed a whole round: this socket had its chance and produced nothing.
        this.#terminate(socket, 'heartbeat: no pong before the timeout elapsed');
        continue;
      }

      // Give it this round to answer, then reap.
      liveness.alive = false;
      try {
        socket.ping();
      } catch {
        this.#terminate(socket, 'heartbeat: ping could not be sent');
        continue;
      }

      const timer = setTimeout(() => {
        this.#reapTimers.delete(socket);
        const current = this.#sockets.get(socket);
        if (current === undefined || current.alive || current.terminated) return;
        this.#terminate(socket, 'heartbeat: no pong within the timeout window');
      }, this.#timeoutMs);
      timer.unref?.();
      this.#reapTimers.set(socket, timer);
    }
  }

  #terminate(socket: HeartbeatSocket, reason: string): void {
    const liveness = this.#sockets.get(socket);
    if (liveness !== undefined) liveness.terminated = true;
    this.#onTerminate?.(reason);
    try {
      // Best-effort courtesy close first so a peer that is merely slow, not dead, learns
      // why it is being dropped. `terminate()` follows immediately in the same tick:
      // waiting for a close handshake with a socket that just failed a liveness check is
      // waiting for something that will not arrive.
      socket.close(DEAD_SOCKET_CLOSE_CODE, 'heartbeat timeout');
    } catch {
      // Already gone.
    }
    try {
      socket.terminate();
    } catch {
      // Already gone; untracking below is what matters.
    }
    this.untrack(socket);
  }
}
