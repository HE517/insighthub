/**
 * The document canvas: one frame, two mutually exclusive panes.
 *
 * ## Why the editor pane is always rendered
 *
 * In `preview` mode the editor is **hidden with CSS, never unmounted**. The reason is the
 * acceptance contract for V1: switching modes must not destroy the CodeMirror surface, its
 * `Y.Text` binding, its undo history or its scroll position. If the editor were inside
 * `mode === 'editor' ? … : null`, React would tear it down and rebuild it on every switch —
 * a new `EditorView`, a new binding, a lost caret.
 *
 * The pane wrapper is what gets `display: none` (`styles.css`), so the child component keeps
 * its instance identity. `CollaborativeMarkdownEditor` receives `hidden` only to know when to
 * restore its scroll offset.
 *
 * The preview pane is the opposite: it is mounted only while visible, because its
 * subscription to `Y.Text` must not exist behind the editor (see `MarkdownPreview.tsx`).
 *
 * This component is presentational: it owns no mode state and reads no document. The mode is
 * UI state in `DocumentWorkspace`.
 */
import type { ReactNode } from 'react';

import type { EditorMode } from './editorMode.js';

export interface DocumentCanvasProps {
  /** The active mode. Only presentation changes; the editor pane stays mounted. */
  mode: EditorMode;
  /** Usually `<CollaborativeMarkdownEditor …/>`. Always rendered. */
  editor: ReactNode;
  /** Usually `<MarkdownPreview …/>`. Rendered (mounted) only in preview mode. */
  preview: ReactNode;
}

export function DocumentCanvas({ mode, editor, preview }: DocumentCanvasProps) {
  const editorHidden = mode === 'preview';

  return (
    <div className="canvas" data-mode={mode}>
      <div
        className={
          editorHidden
            ? 'canvas-pane canvas-pane--editor canvas-pane--hidden'
            : 'canvas-pane canvas-pane--editor'
        }
        data-pane="editor"
      >
        {editor}
      </div>

      {editorHidden ? (
        <div className="canvas-pane canvas-pane--preview" data-pane="preview">
          {preview}
        </div>
      ) : null}
    </div>
  );
}
