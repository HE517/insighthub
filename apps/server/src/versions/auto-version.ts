/**
 * The **D-V2 auto-version policy**: when a real edit earns a `kind = 'auto'` snapshot.
 *
 * ## The rule this module owns
 *
 * ```text
 * body changed?
 *   no  → never capture (an empty update, a repeated body, a join's SyncStep2)
 *   yes → no auto version for this document yet?  → capture now ("the first version")
 *         newest auto version captured < 10 min ago? → do not capture
 *         otherwise                                  → capture
 * ```
 *
 * The comparison is against the **newest existing `auto` row**, never against an in-memory
 * "last capture" field: a restart, a second process, or a restore that happened to write a
 * `restored` row must not reset the interval. `createdAt` is the durable record of when the
 * snapshot was captured, so that is what this policy reads.
 *
 * ## Why this is a pure function here and a call site in the registry
 *
 * The *decision* is pure and testable without a clock, a socket or SQLite. The *capture* must
 * run inside the document's FIFO slot, immediately after the update that changed the body was
 * appended (see `rooms/registry.ts`), so it cannot race a restore or another append. Keeping the
 * two apart is what makes "10 minutes" a table-driven test instead of a 10-minute sleep.
 *
 * ## D-V2 and the `sequence` column
 *
 * A captured version stores `document_meta.content_revision` as its `sequence` (the store does
 * this inside {@link import('../persistence/document-versions.js').DocumentVersionStore.captureDocumentVersion}).
 * That is the same number `baseRevision` must equal for a diff/restore, so an auto version taken
 * right after an edit is immediately previewable and restorable against the revision it captured.
 */
import type { DocumentVersionSummary } from '../persistence/document-versions.js';

/** D-V2: at most one automatic version per document per ten minutes. */
export const AUTO_VERSION_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The author recorded for a snapshot whose writer was **not** a socket.
 *
 * Every production client update carries a resolved identity (`SocketContext.userId`), so this
 * value is only reachable when a transport was wired without an authz service — the M1-compatible
 * library mode. The column is free text (`document_version.author_id`), which is why the honest
 * word is preferred to inventing a user id.
 */
export const AUTO_VERSION_SYSTEM_AUTHOR = 'system';

/** Why the policy said yes or no. Logged and asserted; never sent on the wire. */
export type AutoVersionDecisionReason = 'first' | 'due' | 'too_soon' | 'unchanged';

export interface AutoVersionDecision {
  readonly capture: boolean;
  readonly reason: AutoVersionDecisionReason;
}

export interface AutoVersionPolicyInput {
  /** D-RC1's signal: did this update change the `Y.Text` body? */
  readonly contentChanged: boolean;
  /** `createdAt` of the newest existing `auto` version, in epoch ms, or `null` if there is none. */
  readonly lastAutoCapturedAt: number | null;
  /** Now, in epoch ms. Injected so tests advance time instead of sleeping. */
  readonly now: number;
  /** Override for a test; production always uses {@link AUTO_VERSION_MIN_INTERVAL_MS}. */
  readonly minIntervalMs?: number;
}

/**
 * Decide whether one committed content change should produce an `auto` snapshot.
 *
 * Order matters: an unchanged body is refused **before** the interval is consulted, so a client
 * that sends its state on join (an empty update) can never consume the "first version" slot.
 */
export function decideAutoVersionCapture(input: AutoVersionPolicyInput): AutoVersionDecision {
  if (!input.contentChanged) return { capture: false, reason: 'unchanged' };
  if (input.lastAutoCapturedAt === null) return { capture: true, reason: 'first' };

  const interval = input.minIntervalMs ?? AUTO_VERSION_MIN_INTERVAL_MS;
  // `>=` rather than `>`: "at least ten minutes apart" includes exactly ten minutes. A negative
  // delta (clock moved backwards) is also "too soon", which is the conservative answer.
  return input.now - input.lastAutoCapturedAt >= interval
    ? { capture: true, reason: 'due' }
    : { capture: false, reason: 'too_soon' };
}

/**
 * The capture time of the newest `auto` version, in epoch ms, or `null` when there is none.
 *
 * The list the API returns is already newest-first, but this scans for the maximum timestamp
 * rather than trusting order: a store is a replaceable seam and an adapter that sorts differently
 * must not silently change the capture cadence. An unparsable timestamp is ignored — the safe
 * direction is to treat the document as having no usable auto version and capture, not to stop
 * capturing forever because one row is corrupt.
 */
export function latestAutoVersionCapturedAt(
  versions: readonly DocumentVersionSummary[],
): number | null {
  let latest: number | null = null;
  for (const version of versions) {
    if (version.kind !== 'auto') continue;
    const capturedAt = Date.parse(version.createdAt);
    if (!Number.isFinite(capturedAt)) continue;
    if (latest === null || capturedAt > latest) latest = capturedAt;
  }
  return latest;
}
