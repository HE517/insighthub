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
 */
export const SHARED_CONTRACT_VERSION = 2;
