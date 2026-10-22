/**
 * Regression test for the remote-cursor name label's containing block.
 *
 * ## The defect this pins
 *
 * The label is `position: absolute`. As a *separate sibling* widget of the caret it had
 * no positioned ancestor between itself and `.cm-scroller` (`position: relative` in
 * CodeMirror's base theme), so `left: -1px; top: -1.25em` resolved against the scroll
 * container instead of the caret: measured at the editor's top-left corner, ~300px from
 * a caret on a later line, and clipped by the scroller's `overflow`.
 *
 * The fix is structural, so this test asserts the structure: the label is a **child** of
 * `.cm-remote-caret` (which `styles.css` makes `position: relative`), and both keep the
 * `data-insighthub-cursor` attributes the real-browser suite queries. What a Node test
 * cannot prove is the resulting geometry — `cursors/*` in `tests/browser` owns that, and
 * this file makes no layout claim.
 *
 * No jsdom: the workspace's Vitest environment is `node`, so a minimal element stub is
 * installed for the duration of the test and removed afterwards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DecorationSet, EditorView, WidgetType } from '@codemirror/view';

import { buildRemoteCursorDecorations, CURSOR_ATTRIBUTE } from './remoteCursorExtension.js';
import type { RemoteCursor } from './remoteCursors.js';

interface FakeElement {
  readonly tagName: string;
  className: string;
  readonly style: Record<string, string>;
  readonly attributes: Record<string, string>;
  readonly children: FakeElement[];
  textContent: string;
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeElement): void;
}

/**
 * The smallest `document.createElement` the widget's `toDOM` needs.
 *
 * Deliberately not a DOM: the test asks a question about parentage, not about layout.
 * A real browser rendering the label remains A6's evidence.
 */
function installFakeDocument(): void {
  const createElement = (tagName: string): FakeElement => {
    const element: FakeElement = {
      tagName,
      className: '',
      style: {},
      attributes: {},
      children: [],
      textContent: '',
      setAttribute(name, value) {
        element.attributes[name] = value;
      },
      appendChild(child) {
        element.children.push(child);
      },
    };
    return element;
  };
  vi.stubGlobal('document', { createElement });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function cursor(name = 'Peer Name', color = '#ff0000'): RemoteCursor {
  return {
    clientId: 42,
    user: { id: 'peer', name, color },
    head: 3,
    anchor: 3,
    selection: null,
  };
}

/** Every inline widget in a decoration set, in document order. */
function widgetsOf(set: DecorationSet): WidgetType[] {
  const widgets: WidgetType[] = [];
  for (let cursor = set.iter(); cursor.value !== null; cursor.next()) {
    const widget: WidgetType | undefined = cursor.value.spec?.widget;
    if (widget !== undefined) widgets.push(widget);
  }
  return widgets;
}

describe('remote cursor decorations', () => {
  it('nests the name label inside the caret so the caret is its containing block', () => {
    installFakeDocument();

    const widgets = widgetsOf(buildRemoteCursorDecorations([cursor()], 10));
    // One widget per peer: the caret owns its label. Two sibling widgets is exactly the
    // shape that produced the clipped label (the label had no positioned ancestor).
    expect(widgets).toHaveLength(1);

    const caret = widgets[0]!.toDOM({} as EditorView) as unknown as FakeElement;
    expect(caret.tagName).toBe('span');
    expect(caret.className).toBe('cm-remote-caret');
    expect(caret.attributes[CURSOR_ATTRIBUTE]).toBe('caret');
    expect(caret.style['borderLeftColor']).toBe('#ff0000');

    const labels = caret.children.filter((child) => child.attributes[CURSOR_ATTRIBUTE] === 'label');
    expect(labels).toHaveLength(1);
    const label = labels[0]!;
    expect(label.className).toBe('cm-remote-cursor-label');
    expect(label.textContent).toBe('Peer Name');
    expect(label.style['backgroundColor']).toBe('#ff0000');
  });

  it('treats a renamed collaborator as a different widget so the label repaints', () => {
    const before = widgetsOf(buildRemoteCursorDecorations([cursor('Ada')], 10))[0]!;
    const after = widgetsOf(buildRemoteCursorDecorations([cursor('Grace')], 10))[0]!;

    expect(before.eq(after)).toBe(false);
    expect(before.eq(before)).toBe(true);
  });
});
