/**
 * The **version restore** contract shared by the HTTP layer and the room registry
 * (P0-1; `docs/agent-governance/P0-1-CONTRACTS.md` C1/C4/C5; `docs/DECISIONS.md` D-090).
 *
 * ## The two halves
 *
 * - {@link DocumentVersionService} is what `createApp` receives as an injectable capability.
 *   It is deliberately **not** `RoomRegistry`'s internal type: `app.ts` maps decisions to HTTP
 *   and must not depend on the WebSocket transport.
 * - {@link computeRestoreUpdate} is the pure(ish) Yjs half: it turns "restore `documentId` to
 *   the text of version `versionId`" into the **forward update** that is applied to the live
 *   room and persisted.
 *
 * ## Why the update is computed on a staging clone (A7 P1-7 / Q1-7)
 *
 * A version's `yjs_state` is a full state, not a delta. When the selected version is an
 * ancestor of the current document, `encodeStateAsUpdate(versionDoc, stateVector(current))`
 * is **empty** — the current document already contains every struct — so "restore" would
 * change nothing. The only correct construction is:
 *
 * ```text
 * clone current → compute the text diff (code points) → apply it to the clone
 *   → encodeStateAsUpdate(clone, stateVector(current))
 * ```
 *
 * The clone never touches the room, so a failure while computing the update cannot leave the
 * live document half-restored. The update is then applied to the room by the registry, inside
 * the FIFO slot, before it is persisted (`apply → persist → broadcast`, D-RW1 = A).
 */
import { createHash } from 'node:crypto';

import { TRANSACTION_ORIGINS } from '@insighthub/shared';
import * as Y from 'yjs';

import type {
  DocumentVersionSummary,
  StoredDocumentVersion,
} from '../persistence/document-versions.js';
import type { VersionDiffRequest, VersionDiffResult } from './diff.js';
import { applyTextEdits, restoreTextDiff } from './text-diff.js';

/** C4: `operationId` is 8..128 characters. */
export const RESTORE_OPERATION_ID_MIN_LENGTH = 8;
export const RESTORE_OPERATION_ID_MAX_LENGTH = 128;

/**
 * The answer to the in-slot authorization re-check (`docs/CONTRACTS.md` §12.1 G1,
 * `docs/DECISIONS.md` D-090 §10).
 *
 * Deliberately the same non-disclosure vocabulary the entry check produces, and only its two
 * refusal states: `not_found` is one value for "no membership" and "unknown document" alike, so a
 * queued answer cannot differ in status or body from an entry-time answer for the same caller
 * state (§17.4).
 */
export type RestoreRecheckDecision =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'not_found' | 'forbidden' };

/**
 * The authorization re-check **injected by the HTTP layer** into {@link RestoreVersionRequest}.
 *
 * The registry must not know where permissions come from. `app.ts` owns the `AuthzService`
 * decision — it holds the session's user id and the document id — and closes over them, while the
 * registry only sees "ask again". Importing `authz/**` from here would give the durable
 * version/room seam a reverse dependency on the HTTP authorization stack and a second rule table.
 *
 * The registry awaits this **inside the document's FIFO slot**, before the operation-id lookup and
 * before any read of the version: a membership can be revoked while a restore waits in the queue,
 * and the entry-time permission is not evidence of the permission at commit time (G1).
 */
export type RestoreRecheck = () => Promise<RestoreRecheckDecision>;

/** One restore request, after every HTTP-level check has passed. */
export interface RestoreVersionRequest {
  readonly documentId: string;
  readonly versionId: string;
  /** Content revision the client previewed (D-RC1). */
  readonly baseRevision: number;
  /** Client-generated idempotency key, persisted by the client until the response arrives. */
  readonly operationId: string;
  /** Hash of the request that this operation id first executed (C3). */
  readonly requestHash: string;
  /** The restore initiator — an Owner (`canManageMembers`, D-V1). */
  readonly actorId: string;
  /**
   * G1: ask the caller's permission again inside the queue slot. Required — a restore request has
   * no way to say "the entry-time answer is enough", because that is exactly the claim G1
   * rejects.
   */
  readonly recheckAuthorization: RestoreRecheck;
}

/**
 * The outcome of a restore attempt.
 *
 * `stale_revision` and `operation_conflict` are *refusals*, not failures: the transaction
 * wrote nothing, the room's text is unchanged, and the client may fix its state and retry
 * with a new operation id.
 */
export type RestoreVersionResult =
  | { readonly ok: true; readonly versionId: string; readonly sequence: number }
  | { readonly ok: false; readonly reason: 'stale_revision'; readonly currentRevision: number }
  | { readonly ok: false; readonly reason: 'operation_conflict' }
  | { readonly ok: false; readonly reason: 'not_found' }
  /**
   * G1: the caller may still read the document but may no longer manage it (usually a downgrade
   * to `viewer`/`editor`). The HTTP layer maps it to the frozen `403 forbidden`, never to a body
   * that names the role or the membership.
   */
  | { readonly ok: false; readonly reason: 'forbidden' }
  | { readonly ok: false; readonly reason: 'restore_failed' };

/** The version surface `app.ts` mounts (C4). Implemented by `RoomRegistry`. */
export interface DocumentVersionService {
  /** Restore one version, inside the document's FIFO slot. */
  restoreVersion(request: RestoreVersionRequest): Promise<RestoreVersionResult>;

  /** Versions of one document, newest first. `[]` for an unknown/never-versioned document. */
  listVersions(documentId: string): Promise<readonly DocumentVersionSummary[]>;

  /** The document's current **content revision** (the value `baseRevision` must match). */
  contentRevision(documentId: string): Promise<number>;

  /**
   * Preview one version against the live body, inside the document's FIFO slot.
   *
   * Read-only: it never applies an update, appends a row or broadcasts. Running it in the slot is
   * what makes `currentRevision` and `currentText` describe the **same** state — the revision
   * check and the text are read from the same serialized task that every mutation goes through,
   * mirroring `restoreVersion`. A mutation that wins the race is caught by the same
   * `baseRevision` compare and answered `409 stale_revision`.
   */
  previewVersionDiff(request: VersionDiffRequest): Promise<VersionDiffResult>;
}

/**
 * The idempotency **request hash** (C1's `requestHash`, C3's `request_hash`).
 *
 * Covers every input that changes what the restore *means*: the document, the selected
 * version, the previewed revision and the actor. The operation id itself is excluded — it is
 * the key the hash is stored under, not part of the request.
 *
 * A different body under the same operation id therefore produces a different hash and is
 * refused as `operation_conflict` instead of replaying a result that belongs to another
 * request. A field added later must be added here too, which is why the fields are named
 * rather than hashed from `JSON.stringify(request)` (property order would silently matter).
 */
export function restoreRequestHash(input: {
  readonly documentId: string;
  readonly versionId: string;
  readonly baseRevision: number;
  readonly actorId: string;
}): string {
  const canonical = [
    'insighthub:version-restore:v1',
    input.documentId,
    input.versionId,
    String(input.baseRevision),
    input.actorId,
  ].join('\u0000');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Decode a version's self-contained state into its body text.
 *
 * A throw here means the stored blob is not a valid Yjs update. The caller maps that to
 * `restore_failed`; restoring from an unreadable version must not touch the live document.
 */
export function versionText(version: Pick<StoredDocumentVersion, 'state'>): string {
  const doc = new Y.Doc();
  try {
    if (version.state.byteLength > 0) {
      Y.applyUpdate(doc, version.state, TRANSACTION_ORIGINS.persistence);
    }
    return doc.getText('content').toString();
  } finally {
    doc.destroy();
  }
}

/** The forward update that restores `current`'s body to `targetText`, plus its effect. */
export interface RestoreUpdate {
  /** Relative update against `current`; empty when the text already equals the target. */
  readonly update: Uint8Array;
  /** True when the update is non-empty, i.e. the body changes. */
  readonly changed: boolean;
}

/**
 * Compute the restore update on a **staging clone of the current document** (A7 P1-7).
 *
 * `current` is read, never mutated: the registry applies `update` to the room itself, inside
 * the FIFO slot, so the capture of the pre-restore state and the apply stay adjacent.
 *
 * Returns `changed: false` and an empty update when the selected version's text already is the
 * current text. The caller still records the two version rows and the operation (the request
 * is a real restore request), but must not claim the body changed.
 */
export function computeRestoreUpdate(current: Y.Doc, targetText: string): RestoreUpdate {
  const currentState = Y.encodeStateAsUpdate(current);
  const currentStateVector = Y.encodeStateVector(current);

  const staging = new Y.Doc();
  try {
    if (currentState.byteLength > 0) {
      Y.applyUpdate(staging, currentState, TRANSACTION_ORIGINS.persistence);
    }
    const text = staging.getText('content');
    const edits = restoreTextDiff(text.toString(), targetText);
    if (edits.length === 0) {
      return { update: new Uint8Array(0), changed: false };
    }
    applyTextEdits(edits, text, (body) => {
      staging.transact(body, TRANSACTION_ORIGINS.remote);
    });
    const update = Y.encodeStateAsUpdate(staging, currentStateVector);
    return { update, changed: update.byteLength > 0 };
  } finally {
    staging.destroy();
  }
}
