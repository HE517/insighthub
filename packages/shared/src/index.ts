/**
 * @insighthub/shared - the single source of truth for anything crossing the
 * web <-> server boundary: domain contracts, Zod schemas and the WebSocket
 * protocol.
 *
 * Both apps MUST import from here. Copying a shared type into an app is a
 * review-blocking violation (see AGENTS.md).
 */

export * from './document.js';
export * from './permission.js';
export * from './connection.js';
export * from './ai-suggestion.js';
export * from './protocol.js';

/** Protocol version spoken by this build of the contracts. */
export const SHARED_CONTRACT_VERSION = 1;
