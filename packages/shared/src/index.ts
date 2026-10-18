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
 * See `docs/CONTRACTS.md` §15, `docs/DECISIONS.md` D-045 (design) and D-057 (3 steps).
 */
export const SHARED_CONTRACT_VERSION = 4;
