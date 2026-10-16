/**
 * Per-connection state, and the data structure that makes R15 enforceable.
 *
 * `AGENTS.md` R15 / `docs/CONTRACTS.md` §5.4: **one socket carries at most one
 * active document room.** The way that rule is made structural rather than
 * aspirational is that a connection's room lives in exactly one field —
 * `activeRoom` — so there is no representation in which a socket holds two rooms.
 * A second `join-room` for a different document therefore cannot "add" a room; it
 * can only replace the one in this field.
 */
import type { Peer } from './peer.js';
import type { DocumentRoom } from './room.js';

export interface SocketContext {
  readonly connectionId: string;
  readonly peer: Peer;
  /**
   * The single room this socket is currently in, or `null`.
   *
   * Exactly one of these is non-null at a time; membership is never expressed as
   * a collection. `RoomRegistry` is the only writer.
   */
  activeRoom: DocumentRoom | null;
  /**
   * Yjs awareness `clientID`s this socket has spoken for.
   *
   * The server holds awareness on behalf of each peer, so when a peer goes away
   * its entries must be removed by id and the removal broadcast. Deriving those
   * ids from the peer's own relayed updates (rather than guessing) is what keeps a
   * departing client from leaving a ghost cursor behind.
   */
  readonly awarenessClients: Set<number>;
}
