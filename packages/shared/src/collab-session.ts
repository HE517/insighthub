import type * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';

import type { AwarenessState } from './awareness-state.js';
import type { ConnectionStatus } from './connection.js';
import type { TransactionOrigin } from './binary-frame.js';

/**
 * A1 ↔ A2 public seam (frozen by M1-A0).
 *
 * ## The circular dependency this removes
 *
 * Before this freeze the M1 plan had A1 waiting on "the editor binding from A2"
 * while A2 waited on "`useDocument()` from A1". Both agents would have stalled.
 * The fix: the interface lives here (in `packages/shared`, owned by A0) and:
 *
 * - **A1 implements** `CollaborativeSession` and the `useCollaborativeDocument`
 *   hook (its factory lives in `apps/web/src/collab/public.ts`).
 * - **A2 only consumes** the interface. It may code against this type before A1
 *   finishes, using its own in-memory test double that implements it.
 *
 * Neither implementation is a dependency of the other's source. Only this
 * contract is shared.
 *
 * ## Ownership rule
 *
 * Document content has exactly one source of truth: the `Y.Text` exposed here.
 * It must NOT be mirrored into React state (beyond a transient render value) or
 * into Redux. Redux may hold `activeDocumentId`, metadata, permission, connection
 * status, collaborator metadata and UI state — never a full copy of the text.
 */

/** Lifecycle of the local session, independent of the network path. */
export const SESSION_STATES = ['initializing', 'active', 'destroyed'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** One remote participant, derived from awareness and already validated. */
export interface CollaboratorInfo {
  /** Yjs awareness client id (not the auth user id). */
  clientId: number;
  user: { id: string; name: string; color?: string };
  cursor: { anchor: number; head: number } | null;
  selection: { from: number; to: number } | null;
}

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

export interface CollaborativeSessionOptions {
  documentId: string;
  /** Local identity published through awareness. */
  user: { id: string; name: string; color?: string };
  /**
   * Called whenever the session's own state changes: connection status, session
   * state, or collaborator set. A2 uses this to drive UI without polling.
   * Returns an unsubscribe function.
   */
  onStateChange?(listener: () => void): () => void;
  /**
   * Origin tag for undo tracking. Defaults to `TRANSACTION_ORIGINS.local`.
   * Undo never reverts updates whose origin is `remote`.
   */
  localOrigin?: TransactionOrigin;
  /** Override the IndexedDB database name (tests use a throwaway name). */
  persistenceKey?: string;
}

/**
 * The one collaboration object A2 may depend on.
 *
 * Everything A2 is forbidden to know about (IndexedDB, reconnect queue, state
 * vectors, socket framing) is deliberately absent from this interface.
 */
export interface CollaborativeSession {
  readonly documentId: string;

  /** Document content truth. Bind the editor to this, never to a string copy. */
  readonly text: Y.Text;
  /** Full CRDT document, exposed for readiness/AI transactions in later milestones. */
  readonly doc: Y.Doc;
  /** Ephemeral presence. Read via `getCollaborators()`. */
  readonly awareness: awarenessProtocol.Awareness;

  /** Local lifecycle. `active` can be reached without any network connection. */
  readonly state: SessionState;
  /** Network path state. Purely informational for the UI; never gates editing. */
  readonly connectionStatus: ConnectionStatus;
  /** Local id this session publishes in its own awareness state. */
  readonly localClientId: number;

  /** Remote participants currently present (validated awareness entries). */
  getCollaborators(): readonly CollaboratorInfo[];
  /** The session's own awareness state as published. */
  getLocalAwarenessState(): AwarenessState | null;

  /**
   * Apply a local document change inside a Yjs transaction stamped with the
   * local origin. Use this from UI code so undo tracking and echo suppression
   * behave; direct `text.insert` calls bypass undo tracking.
   */
  transact(fn: (text: Y.Text) => void, origin?: TransactionOrigin): void;

  undo(): void;
  redo(): void;
  getUndoState(): UndoState;

  /** Open the network path. Safe to call when already connected. */
  connect(): void;
  /** Close the network path but keep the document and local persistence alive. */
  disconnect(): void;

  /** Subscribe to session/collaborator/connection changes. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;

  /**
   * Tear down everything: awareness entry (removed and broadcast), socket,
   * IndexedDB provider, timers, observers. Idempotent. After this the session is
   * unusable and a new one must be created for the document.
   */
  destroy(): void;
}

/**
 * Result of the A1-owned React hook `useCollaborativeDocument(options)`.
 *
 * A discriminated union because `state === 'active'` is the only case where a
 * session exists — this removes the `session | null` check from A2 entirely.
 */
export type CollaborativeSessionResult =
  | { state: 'initializing'; session?: undefined; error?: undefined }
  | { state: 'active'; session: CollaborativeSession; error?: undefined }
  | { state: 'failed'; session?: undefined; error: string };

/**
 * Environment prerequisites the caller must not violate.
 *
 * - Browser only (IndexedDB). Server-side rendering must not call this.
 * - `documentId` must be stable for the lifetime of the session.
 */
export const COLLAB_SESSION_CONSTRAINTS = {
  /** A session never blocks opening on the network; see ARCHITECTURE §3. */
  editableBeforeNetwork: true,
  /** Concurrent sessions for the same documentId on one client are not supported in M1. */
  oneSessionPerDocument: true,
} as const;
