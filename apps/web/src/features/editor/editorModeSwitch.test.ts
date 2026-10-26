/**
 * Edit/preview mode: the control, and the canvas that keeps the editor mounted.
 *
 * ## Why this is a structural test
 *
 * This workspace's Vitest environment is `node` with no jsdom, so there is no way to render a
 * React tree, click `预览` and observe the DOM. The two things that *can* be proven here are
 * the two that would actually regress:
 *
 * 1. the toolbar is a controlled `aria-pressed` pair with exactly one active segment, and the
 *    default is edit;
 * 2. `DocumentCanvas` renders the editor subtree in **both** modes — in preview mode the pane
 *    only gains the hiding class, it is never conditionally removed — while the preview pane
 *    exists only in preview mode.
 *
 * The remaining half ("the same `EditorView` instance survives, scrollTop is restored") is
 * observable only in a real browser and is recorded as A6's evidence. Static markup cannot
 * prove instance identity, and this file does not pretend it does.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import type { ConnectionStatus, CollaboratorInfo, UndoState } from '@insighthub/shared';

import { capabilityGate } from '../permissions/capabilityGate.js';
import { DocumentCanvas } from './DocumentCanvas.js';
import { DocumentHeader } from './DocumentHeader.js';
import { DEFAULT_EDITOR_MODE, type EditorMode } from './editorMode.js';

const STATUS: ConnectionStatus = 'offline';
const UNDO_STATE: UndoState = { canUndo: false, canRedo: false };
const COLLABORATORS: readonly CollaboratorInfo[] = [];

function headerMarkup(mode: EditorMode): string {
  return renderToStaticMarkup(
    createElement(DocumentHeader, {
      documentId: 'doc-a',
      status: STATUS,
      gate: capabilityGate('editor'),
      collaborators: COLLABORATORS,
      localClientId: 1,
      undoState: UNDO_STATE,
      onUndo: () => {},
      onRedo: () => {},
      aiOpen: false,
      onToggleAi: () => {},
      mode,
      onModeChange: () => {},
    }),
  );
}

function canvasMarkup(mode: EditorMode): string {
  return renderToStaticMarkup(
    createElement(DocumentCanvas, {
      mode,
      editor: createElement('div', { 'data-testid': 'markdown-editor' }),
      preview: createElement('div', { 'data-testid': 'markdown-preview' }),
    }),
  );
}

/** The opening tag of the element carrying `data-testid="<testId>"`. */
function tagFor(html: string, testId: string): string {
  const match = new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`no element with data-testid="${testId}"`);
  return match[0];
}

/** The opening tag of the canvas pane whose `data-pane` is `pane`. */
function paneTag(html: string, pane: string): string {
  const match = new RegExp(`<div class="[^"]*"[^>]*data-pane="${pane}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`no pane "${pane}"`);
  return match[0];
}

describe('mode switch: default and pressed state', () => {
  it('defaults to edit mode', () => {
    expect(DEFAULT_EDITOR_MODE).toBe('editor');
  });

  it('renders `编辑` pressed and `预览` not pressed in edit mode', () => {
    const html = headerMarkup('editor');
    expect(html).toContain('data-testid="mode-editor"');
    expect(html).toContain('data-testid="mode-preview"');
    expect(tagFor(html, 'mode-editor')).toContain('aria-pressed="true"');
    expect(tagFor(html, 'mode-preview')).toContain('aria-pressed="false"');
    expect(html).toContain('>编辑</button>');
    expect(html).toContain('>预览</button>');
  });

  it('renders `预览` pressed and `编辑` not pressed in preview mode', () => {
    const html = headerMarkup('preview');
    expect(tagFor(html, 'mode-editor')).toContain('aria-pressed="false"');
    expect(tagFor(html, 'mode-preview')).toContain('aria-pressed="true"');
  });

  it('does not disable either mode for a viewer (preview is read-only, edit is gated elsewhere)', () => {
    const html = renderToStaticMarkup(
      createElement(DocumentHeader, {
        documentId: 'doc-a',
        status: STATUS,
        gate: capabilityGate('viewer'),
        collaborators: COLLABORATORS,
        localClientId: 1,
        undoState: UNDO_STATE,
        onUndo: () => {},
        onRedo: () => {},
        aiOpen: false,
        onToggleAi: () => {},
        mode: 'editor',
        onModeChange: () => {},
      }),
    );
    expect(tagFor(html, 'mode-editor')).not.toContain('disabled');
    expect(tagFor(html, 'mode-preview')).not.toContain('disabled');
  });
});

describe('mode switch: the editor is not unmounted in preview mode', () => {
  it('renders the editor pane in edit mode with no preview pane', () => {
    const html = canvasMarkup('editor');
    expect(html.match(/data-testid="markdown-editor"/g)).toHaveLength(1);
    expect(html).not.toContain('data-testid="markdown-preview"');
    expect(html).not.toContain('data-pane="preview"');
    expect(paneTag(html, 'editor')).toContain('canvas-pane--editor');
    expect(paneTag(html, 'editor')).not.toContain('canvas-pane--hidden');
  });

  it('keeps the editor pane (hidden) in preview mode and adds the preview pane', () => {
    const html = canvasMarkup('preview');
    // The editor subtree is still part of the render: this is the structural half of
    // "switching modes must not remount CodeMirror".
    expect(html.match(/data-testid="markdown-editor"/g)).toHaveLength(1);
    expect(paneTag(html, 'editor')).toContain('canvas-pane--hidden');
    // The preview exists only while visible, so its Y.Text subscription cannot linger.
    expect(html.match(/data-testid="markdown-preview"/g)).toHaveLength(1);
    expect(paneTag(html, 'preview')).toContain('canvas-pane--preview');
  });

  it('publishes the active mode on the canvas for CSS and tooling', () => {
    expect(canvasMarkup('editor')).toContain('data-mode="editor"');
    expect(canvasMarkup('preview')).toContain('data-mode="preview"');
  });
});
