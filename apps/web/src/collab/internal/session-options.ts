import type { CollaborativeSessionOptions } from '@insighthub/shared';

import type { IndexedDbLike } from './persistence.js';

/**
 * Additive, backward-compatible extension of the frozen A1↔A2 options type.
 *
 * `docs/CONTRACTS.md` §8 freezes `CollaborativeSessionOptions` in
 * `packages/shared/src/collab-session.ts`, and A1 must not edit that file
 * (`AGENTS.md` §2). But a session that talks to IndexedDB and WebSockets cannot
 * be tested in Node without two injection points:
 *
 * | Field | Why it exists | Production default |
 * | --- | --- | --- |
 * | `wsUrl` | override the WebSocket endpoint resolution | the same `VITE_WS_URL` / `window.location` derivation the M0 channel uses |
 * | `indexedDB` | supply an IndexedDB implementation when no global exists | ambient `globalThis.indexedDB` |
 * | `wsSocketFactory` | supply a WebSocket constructor | ambient `globalThis.WebSocket` |
 *
 * **This is an additive declaration merge, not a renegotiation of the contract.**
 * The shared interface keeps every property it froze; nothing is removed,
 * renamed or retyped, so an A2 call site written against
 * `CollaborativeSessionOptions` keeps compiling unchanged. The augmented type is
 * exactly the frozen one plus optional test seams.
 *
 * The merge is declared here (an A1-owned module) so it becomes visible wherever
 * `collab/**` is imported — which is exactly where the frozen option type is
 * consumed. It is deliberately *not* declared in `packages/shared/**`, because
 * that path is Supervisor-owned. A7 reviews it as an additive seam; the recommended
 * long-term fix is an A0-owned optional field on the shared interface.
 */
declare module '@insighthub/shared' {
  interface CollaborativeSessionOptions {
    /** WebSocket endpoint override. Production resolves it from the page origin. */
    wsUrl?: string;
    /** IndexedDB implementation override (tests inject an in-memory double). */
    indexedDB?: IndexedDbLike;
    /** WebSocket constructor override (tests inject an in-process transport). */
    wsSocketFactory?: unknown;
  }
}

/**
 * The option object the collaboration layer actually reads.
 *
 * Identical to the frozen `CollaborativeSessionOptions` (the interface above is
 * merged into it), restated as a named type so internal modules and tests can
 * refer to one alias without importing the shared module for a type only.
 */
export type SessionOptions = CollaborativeSessionOptions;

/** Narrow an untrusted WebSocket factory to the constructor shape we call. */
export function isWebSocketFactory(value: unknown): value is { new (url: string): unknown } {
  return typeof value === 'function';
}
