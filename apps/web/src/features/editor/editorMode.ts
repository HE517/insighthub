/**
 * The one editor-surface mode (V1 Markdown preview).
 *
 * `editor` is CodeMirror bound to `Y.Text`; `preview` is a read-only rendering of the same
 * `Y.Text`. It is UI state only — it is never persisted, never dispatched to Redux and it
 * carries no document content. The document body stays in `Y.Text` in both modes
 * (`AGENTS.md` R11).
 *
 * The type lives in its own module so the toolbar (`DocumentHeader`) and the canvas
 * (`DocumentCanvas`) agree on one vocabulary without importing each other.
 */
export type EditorMode = 'editor' | 'preview';

/** V1 opens in edit mode, exactly as the editor did before preview existed. */
export const DEFAULT_EDITOR_MODE: EditorMode = 'editor';
