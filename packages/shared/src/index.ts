/**
 * @insighthub/shared - the single source of truth for anything crossing the
 * web <-> server boundary: domain contracts, Zod schemas and the WebSocket
 * protocol.
 *
 * Both apps MUST import from here. Copying a shared type into an app is a
 * review-blocking violation (see AGENTS.md).
 */

export * from './errors.js';
export * from './document.js';
export * from './permission.js';
export * from './connection.js';
export * from './ai-suggestion.js';
export * from './awareness-state.js';
export * from './binary-frame.js';
export * from './protocol.js';
export * from './collab-session.js';

/**
 * Version of the shared contract surface as a whole.
 *
 * v2 (M1-A0): added the binary data plane (`binary-frame.ts`), the awareness
 * state contract, the A1↔A2 `CollaborativeSession` seam, and the frozen error
 * code vocabulary. `PROTOCOL_VERSION` was bumped to 2 in the same change.
 *
 * v3 (M2-P0-2 step 1): added the presence **write** seam — `CollaborativeSession.publishPresence`,
 * `PresencePatch` and `parsePresencePatch`. Additive: every v2 member was still there.
 *
 * v4 (M2-P0-2 step 3): **breaking** — `CollaborativeSession.awareness` narrowed from the
 * raw `Awareness` to `AwarenessBinding`. The write members (`setLocalState`,
 * `setLocalStateField`, `states`, `meta`, `destroy`) are no longer reachable through the
 * seam, and `getStates()` now returns `ReadonlyMap`. Code that wrote presence through
 * the seam against v3 does not compile against v4 — which is the point. The **wire is
 * untouched** (awareness already carried cursor and selection), so `PROTOCOL_VERSION`
 * stays at 2.
 *
 * v5 (M2 Phase 2): `WS_ERROR_CODES` gained `FORBIDDEN` (`docs/CONTRACTS.md` §17.6) — a
 * **closed vocabulary grew**, which `docs/CONTRACTS.md` §13 and `AGENTS.md` §6 both
 * require to be versioned explicitly. Additive in every other respect: no member was
 * removed or narrowed, no payload shape changed, no new frame type, and `PROTOCOL_VERSION`
 * stays **2** — the code travels inside the existing `error` message, and the workspace
 * ships a single client build, so there is no older client to confuse (§17.6).
 *
 * v6 (M2 Phase 2, A3): `RoomJoinedPayload` gained a **required** `role`
 * (`docs/CONTRACTS.md` §5.2, §17.8) — the only channel that tells a client its own role in
 * the document it just joined, and it exists for UI gating alone. This is an additive change
 * to the payload (no field removed or retyped), but a **breaking** one to the interface: a
 * producer that omits `role` no longer typechecks and a consumer must handle it. Hence the
 * bump. `PROTOCOL_VERSION` stays **2**: no frame type, message type, framing rule or error
 * code changed — one payload grew one field, inside the existing `room-joined` message.
 *
 * See `docs/CONTRACTS.md` §15, §17 and `docs/DECISIONS.md` D-045 (design), D-057 (3 steps),
 * D-061 (M2 Phase 2 freeze) and D-062 (A3 owns `room-joined.role`).
 */
export const SHARED_CONTRACT_VERSION = 6;
