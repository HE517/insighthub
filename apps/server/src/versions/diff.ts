/**
 * The **version diff preview** shape (P0-1 pre-requisite 2): the pure text half and the frozen
 * request/response contract `GET /api/documents/:id/versions/:versionId/diff?baseRevision=<n>`
 * serves.
 *
 * ## Why the diff is a segment list and not a patch string
 *
 * The client renders the version's body against the current body (insertions/deletions/equal
 * spans), not a machine-applicable patch: there is no "apply this diff" endpoint and V1 restore
 * is its own audited operation (C4). A segment list is the smallest shape that renders without
 * re-tokenising text in the browser.
 *
 * ## Why it reuses `restoreTextDiff`
 *
 * Restore and preview must agree about what changed. `restoreTextDiff` computes the one forward
 * edit between two texts over **code points** (never UTF-16 units), so a surrogate pair in an
 * emoji cannot be split. The preview presents exactly that edit as segments: the shared prefix,
 * the deleted span, the inserted span, the shared suffix. A second diff algorithm would be a
 * second answer to "what will restore change?", which is the class of divergence this module
 * exists to prevent.
 *
 * ## Counts
 *
 * `stats` counts **code points**, like the boundary the edit is computed on. A family emoji is
 * several code points (ZWJ sequence); this is stated rather than hidden, and matches the
 * documented limitation of the restore edit.
 */
import { restoreTextDiff } from './text-diff.js';

/** The three segment kinds the UI renders. */
export type TextDiffKind = 'insert' | 'delete' | 'equal';

/** One contiguous span of the diff. `text` is never empty. */
export interface TextDiffSegment {
  readonly type: TextDiffKind;
  readonly text: string;
}

/** Code-point counts of what the selected version would insert/delete against the current body. */
export interface VersionDiffStats {
  readonly inserted: number;
  readonly deleted: number;
}

/** The rendered diff plus its counts. */
export interface VersionDiff {
  readonly diff: readonly TextDiffSegment[];
  readonly stats: VersionDiffStats;
}

/**
 * Compute the rendered diff from `currentText` (the live body) to `targetText` (the version).
 *
 * When the texts are equal the answer is one `equal` segment (or `[]` for two empty bodies):
 * "no change" is a diff with no insert/delete, not an error and not a missing field.
 */
export function buildVersionDiff(currentText: string, targetText: string): VersionDiff {
  const edits = restoreTextDiff(currentText, targetText);
  if (edits.length === 0) {
    return {
      diff: currentText.length === 0 ? [] : [{ type: 'equal', text: currentText }],
      stats: { inserted: 0, deleted: 0 },
    };
  }

  const segments: TextDiffSegment[] = [];
  let inserted = 0;
  let deleted = 0;
  let cursor = 0;

  // `restoreTextDiff` returns exactly one edit today. The loop keeps the segment construction
  // correct if that ever becomes a general edit script, without encoding "one edit" into the
  // response shape.
  const ordered = [...edits].sort((left, right) => left.index - right.index);
  for (const edit of ordered) {
    if (edit.index > cursor) {
      segments.push({ type: 'equal', text: currentText.slice(cursor, edit.index) });
    }
    if (edit.deleteLength > 0) {
      const removed = currentText.slice(edit.index, edit.index + edit.deleteLength);
      segments.push({ type: 'delete', text: removed });
      deleted += Array.from(removed).length;
    }
    if (edit.insert.length > 0) {
      segments.push({ type: 'insert', text: edit.insert });
      inserted += Array.from(edit.insert).length;
    }
    cursor = edit.index + edit.deleteLength;
  }

  if (cursor < currentText.length) {
    segments.push({ type: 'equal', text: currentText.slice(cursor) });
  }

  return { diff: segments, stats: { inserted, deleted } };
}

/**
 * One preview request, after the HTTP layer has authorized `canRead` and validated the query.
 *
 * `baseRevision` is the **content revision** the client last saw. It must equal the current one;
 * a mismatch is `409 stale_revision` and no body text is returned, because rendering a diff
 * against a revision the client no longer holds would be a preview of the wrong document state.
 */
export interface VersionDiffRequest {
  readonly documentId: string;
  readonly versionId: string;
  readonly baseRevision: number;
}

/**
 * The preview outcome.
 *
 * `not_found` is deliberately one value for three caller-visible situations: a version id that
 * belongs to another document, a version id that does not exist, and a missing durable version
 * capability. The HTTP layer has already answered "no membership / unknown document" with its own
 * `404`, so the body is the same `not_found` in every case and cannot be used to probe another
 * document's version ids.
 */
export type VersionDiffResult =
  | {
      readonly ok: true;
      readonly versionId: string;
      readonly baseRevision: number;
      readonly currentRevision: number;
      /** The selected version's decoded body. Never its `yjs_state`. */
      readonly targetText: string;
      /** The live body the diff is computed from. */
      readonly currentText: string;
      readonly diff: readonly TextDiffSegment[];
      readonly stats: VersionDiffStats;
    }
  | { readonly ok: false; readonly reason: 'stale_revision'; readonly currentRevision: number }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'failed' };
