import type * as awarenessProtocol from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { ZodError } from 'zod';

import {
  awarenessCursorSchema,
  awarenessSelectionSchema,
  type AwarenessState,
} from './awareness-state.js';
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

/* ---------------------------------------------------------------------- *
 * Presence write seam (M2-P0-2, frozen by `docs/CONTRACTS.md` §15)
 * ---------------------------------------------------------------------- */

/**
 * A presence update published through `CollaborativeSession.publishPresence`.
 *
 * ## Why presence needed a write seam at all
 *
 * The read side of presence was already contract-governed: `getCollaborators()`
 * filters peer entries through `awarenessStateSchema`. The write side was not —
 * callers wrote the raw `Awareness` instance, so *the shape this client publishes was
 * nobody's contract*, and `updatedAt` was maintained by the caller, duplicating
 * bookkeeping the collaboration layer already does.
 *
 * ## Scope restraint (frozen)
 *
 * Only `cursor` and `selection` are covered. Identity (`user`) is established by the
 * session at construction and is not a per-keystroke write; allowing it here would
 * invite changing identity mid-session, which nothing in M2 needs.
 *
 * `updatedAt` is deliberately absent: the collaboration layer owns it, so a caller
 * can neither supply it nor forget it. `parsePresencePatch` rejects it at runtime too,
 * because an untyped caller has no compiler to stop it.
 *
 * ## Absent vs `null`
 *
 * Omitting a field leaves that field unchanged; `null` clears it. That is what makes
 * a partial patch legal: publishing only `cursor` must not clear `selection`.
 */
export interface PresencePatch {
  /** `null` clears the cursor; omit to leave it unchanged. */
  readonly cursor?: { anchor: number; head: number } | null;
  /** `null` clears the selection; omit to leave it unchanged. */
  readonly selection?: { from: number; to: number } | null;
}

/** The only fields a presence patch may carry. */
export const PRESENCE_PATCH_FIELDS = ['cursor', 'selection'] as const;

export type PresencePatchField = (typeof PRESENCE_PATCH_FIELDS)[number];

/**
 * A presence patch that violates the contract.
 *
 * Validation is a **programming-error** guard, not a runtime/user condition: a
 * rejected patch means the caller built something the contract does not allow. It is
 * thrown instead of returned because there is no sensible recovery — and, critically,
 * so that it can never reach the wire.
 */
export class PresencePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresencePatchError';
  }
}

/** The keys each presence field owns. The write side is strict about extras. */
const PRESENCE_FIELD_KEYS: Record<PresencePatchField, readonly string[]> = {
  cursor: ['anchor', 'head'],
  selection: ['from', 'to'],
};

function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<value>'}: ${issue.message}`)
    .join('; ');
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PresencePatchError(`${label} must be an object, got ${describeType(value)}`);
  }
  return value as Record<string, unknown>;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Reject keys the contract does not define.
 *
 * The read side is intentionally lenient about unknown peer keys — a peer running a
 * newer build must not be rejected, and its extra fields are simply dropped by
 * `awarenessStateSchema`. The write side is the opposite: an unknown key here is our
 * own bug, and dropping it silently is how a caller comes to believe it published
 * something it did not.
 */
function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    if (key === 'updatedAt') {
      throw new PresencePatchError(
        'updatedAt is owned by the collaboration layer and must not be supplied by the caller',
      );
    }
    throw new PresencePatchError(
      `${label} does not accept "${key}" (allowed: ${allowed.join(', ') || 'none'})`,
    );
  }
}

function parseCursor(value: unknown): { anchor: number; head: number } {
  const record = assertPlainObject(value, 'presence.cursor');
  rejectUnknownKeys(record, PRESENCE_FIELD_KEYS.cursor, 'presence.cursor');
  // The value rules come from the *read* side schema, so publish and consume cannot
  // disagree about what a valid offset is.
  const parsed = awarenessCursorSchema.safeParse(record);
  if (!parsed.success) {
    throw new PresencePatchError(`presence.cursor is invalid: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function parseSelection(value: unknown): { from: number; to: number } {
  const record = assertPlainObject(value, 'presence.selection');
  rejectUnknownKeys(record, PRESENCE_FIELD_KEYS.selection, 'presence.selection');
  const parsed = awarenessSelectionSchema.safeParse(record);
  if (!parsed.success) {
    throw new PresencePatchError(`presence.selection is invalid: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Validate a presence patch **before** anything is written.
 *
 * Returns a normalized patch containing only the fields the caller actually supplied,
 * so the writer can distinguish "leave unchanged" (`undefined`) from "clear" (`null`).
 *
 * Rejected here, and never allowed onto the wire:
 *
 * - `updatedAt` or any other key the contract does not define;
 * - a cursor/selection carrying extra fields (typos, or the old hand-rolled shape);
 * - negative, fractional or `NaN` offsets;
 * - `selection.from > selection.to`.
 *
 * This is exported so a caller — including a test double of `CollaborativeSession` —
 * can apply the *same* rule the real session applies instead of re-deriving it.
 */
export function parsePresencePatch(patch: unknown): PresencePatch {
  const record = assertPlainObject(patch, 'publishPresence(patch)');
  rejectUnknownKeys(record, PRESENCE_PATCH_FIELDS, 'publishPresence(patch)');

  const normalized: { -readonly [K in PresencePatchField]?: PresencePatch[K] } = {};

  if (record.cursor !== undefined) {
    normalized.cursor = record.cursor === null ? null : parseCursor(record.cursor);
  }
  if (record.selection !== undefined) {
    normalized.selection = record.selection === null ? null : parseSelection(record.selection);
  }

  return normalized;
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
  /**
   * Local persistence mode. Defaults to `'indexeddb'`.
   *
   * `'none'` opens a memory-only session: local durability is skipped, and the
   * `Y.Doc` lives only for the session's lifetime. It exists for environments with no
   * IndexedDB (a Node integration test that only needs the real network path) and is
   * **never** what a browser app should choose — a production caller that opts out of
   * persistence loses offline durability, which is `docs/ARCHITECTURE.md` §2 Path 1.
   *
   * Added by M1-A0.2 as a Supervisor-owned field, replacing the option seam A1 had
   * documented as a local augmentation (`docs/DECISIONS.md` D-034).
   */
  persistence?: 'indexeddb' | 'none';
}

/**
 * The slice of `y-protocols`' `Awareness` a **binding** legitimately needs
 * (M2-P0-2 step 3).
 *
 * ## Why this exists
 *
 * `docs/CONTRACTS.md` §15.2 rule 4 says the raw `Awareness` "may remain exposed only as
 * a binding input". Until step 3 that was a comment: the seam exposed the full class, so
 * `session.awareness.setLocalState(...)` compiled and every caller could write presence
 * directly, bypassing validation and the collaboration layer's `updatedAt` ownership.
 *
 * This type makes the rule structural instead of advisory:
 *
 * | Member | Why a binding needs it |
 * | --- | --- |
 * | `getStates()` | a cursor extension reads peer entries to compute remote cursors |
 * | `on` / `off` | the extension subscribes to `change`/`update` and unsubscribes on teardown |
 * | `clientID` | the binding has to tell the local entry from peers |
 *
 * Everything else is gone: `setLocalState`, `setLocalStateField`, `states`, `meta` and
 * `destroy` are **not reachable** through this type. Presence is written only through
 * `CollaborativeSession.publishPresence`.
 *
 * ## Why `getStates` is narrowed to `ReadonlyMap`
 *
 * `Awareness.getStates()` returns the live `Map`, so `Pick<Awareness, 'getStates'>`
 * would still have handed out a writable map — a write path wearing a read interface.
 * The declared return is therefore `ReadonlyMap<number, unknown>`, which is also the
 * shape a binding actually consumes (`collectValidAwarenessStates` takes exactly that).
 * The values stay `unknown` on purpose: they are untrusted peer payloads and must go
 * through `awarenessStateSchema` before anyone renders them (R14).
 *
 * `on`/`off` are taken from `Awareness` itself rather than re-declared, so the
 * subscription signatures cannot drift from `y-protocols`.
 */
export interface AwarenessBinding extends Pick<awarenessProtocol.Awareness, 'clientID' | 'on' | 'off'> {
  /** Peer presence entries, exactly as they came off the wire. Validate before use. */
  getStates(): ReadonlyMap<number, unknown>;
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
  /**
   * Ephemeral presence, as a **binding input only** (`docs/CONTRACTS.md` §15.2 rule 4).
   *
   * This is deliberately not the raw `y-protocols` instance: writing through it does not
   * compile (`AwarenessBinding` has no write member), because the only supported write
   * path is `publishPresence` below. It is also not UI state — render collaborators from
   * `getCollaborators()`, which is schema-validated (R14).
   */
  readonly awareness: AwarenessBinding;

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
   * Publish this client's presence (M2-P0-2).
   *
   * This is the **only** supported write path for presence. `updatedAt` is stamped by
   * the collaboration layer, never by the caller. The patch is validated before
   * anything is written, and an invalid one throws `PresencePatchError` rather than
   * being published — a bad patch is a caller bug, not a runtime condition.
   *
   * Partial patches are the normal case: naming only `cursor` leaves `selection`
   * untouched. Awareness stays the single presence channel (`docs/DECISIONS.md`
   * D-021); no control-plane presence message exists or is added.
   *
   * The raw `awareness` instance above is a binding input only and has no write member.
   * Use this method; it is the sole presence write path, and it is what makes the
   * published shape the contract's business rather than the caller's.
   */
  publishPresence(patch: PresencePatch): void;

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
