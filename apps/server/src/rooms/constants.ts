/**
 * A3 tuning constants for the realtime collaboration server.
 *
 * These are **not** part of the shared contract: they are server-side operational
 * limits, so they live in `apps/server` and can be tuned without a Supervisor
 * review or a `PROTOCOL_VERSION` bump. Anything that *is* contractual (frame
 * limits, error codes, awareness bounds) is imported from `@insighthub/shared`
 * and never redefined here — see `AGENTS.md` R1 and R12.
 *
 * Rationale for each value is recorded next to it, because "why 30 seconds" is
 * the question a reviewer will actually ask.
 */

/**
 * How often the server sends a WebSocket ping to every open socket.
 *
 * Chosen so a client that vanishes without a close frame (laptop lid closed,
 * network dropped, process killed) is detected in a human-scale window rather
 * than lingering as a zombie participant. 30 s matches the awareness
 * `outdatedTimeout` that `y-protocols` already uses, so the server-side reaper and
 * the client-side awareness expiry agree on the timescale instead of disagreeing.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long a socket may go without a pong before it is considered dead.
 *
 * A live peer answers a ping within one network round trip, so 10 s is generous
 * for any realistic RTT while staying well under `HEARTBEAT_INTERVAL_MS`. A dead
 * socket is therefore reaped in the worst case after
 * `HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS` (40 s).
 */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * `socket.bufferedAmount` ceiling for a single outbound collaboration frame.
 *
 * If a peer is slower at reading than the room is at writing, `ws` queues every
 * frame in memory. An unbounded queue turns one slow client into a server-wide
 * memory leak, so a peer whose kernel/user buffer is already this far behind is
 * **dropped** instead of queued. 4 MiB is far above a normal Yjs update (usually
 * kilobytes) and far below `MAX_BINARY_FRAME_BYTES` (16 MiB), so it can only be
 * reached by a genuinely stalled reader.
 */
export const SLOW_CLIENT_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;

/** WebSocket close code used when a peer is dropped for backpressure. */
export const SLOW_CLIENT_CLOSE_CODE = 1013; // "Try Again Later"

/**
 * WebSocket close code used when a peer fails the liveness check.
 *
 * 1001 ("Going Away") is the honest description: the server is about to drop the
 * connection because the peer stopped responding. It is sent as a best-effort
 * courtesy — a socket that cannot answer a ping may never deliver it, which is why
 * the heartbeat follows the close frame with `terminate()` rather than waiting for
 * a close handshake that will not come.
 */
export const DEAD_SOCKET_CLOSE_CODE = 1001;
