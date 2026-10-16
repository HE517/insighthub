/**
 * The editor-facing surface the collaboration binding drives.
 *
 * The binding must not import `@codemirror/view`, because the interesting part
 * of the integration (echo suppression, delta translation, teardown) has to be
 * unit-testable without a DOM: CodeMirror's `EditorView` calls
 * `document.createElement` and cannot be constructed in a node test
 * environment. So the CodeMirror adapter lives in `codeMirrorSurface.ts` and the
 * algorithm works against this small interface, which a test can implement in a
 * dozen lines.
 *
 * Contract notes:
 *
 * - `applyDelta` must be a single editor transaction so one remote Yjs update
 *   maps to one CodeMirror update (one render), never N.
 * - `setText` is the divergence fallback (attach, or a resync); it must replace
 *   the whole document in one transaction.
 * - Offsets are UTF-16 code units, the unit both Yjs and CodeMirror use.
 */
import type { TextChange } from './textDiff.js';

export interface EditorTextSurface {
  /** Current editor text. Read once per sync step, never cached by the caller. */
  getText(): string;

  /**
   * Whether the editor already shows `text`.
   *
   * Cheaper than `getText() === text` for a large document, and the reconcile
   * path calls it on every remote update to avoid a needless O(document) diff.
   */
  hasText(text: string): boolean;

  /**
   * Apply ordered, non-overlapping deltas where `from`/`to` are offsets in the
   * document **as this call began** (the same convention as `Y.TextEvent.delta`).
   *
   * `origin` marks the change as *derived from `Y.Text`* rather than typed by the
   * user, so the adapter's own update listener can tell the two apart. Passing it
   * is what stops an undo or a remote update from being re-recorded as a new local
   * edit (see `REMOTE_SYNC_ANNOTATION`).
   *
   * Implementations MUST clamp a range to the current document instead of
   * throwing: this runs inside a Yjs observer, and a divergence between the
   * editor buffer and `Y.Text` must degrade to a bounded edit rather than an
   * exception escaping the CRDT update path.
   */
  applyDelta(changes: readonly TextChange[], origin?: unknown): void;

  /** Replace the whole document in one transaction. */
  setText(text: string, origin?: unknown): void;

  /** The current selection, clamped by the caller if needed. */
  getRange(): { anchor: number; head: number };
}
