/**
 * The lazy preview renderer: Markdown → semantic DOM, and the security boundary.
 *
 * Rendered with `react-dom/server` (`renderToStaticMarkup`) in the workspace's `node` Vitest
 * environment. That is the honest level for this layer: the assertions are about **which
 * elements and attributes exist**, which is exactly what the renderer owns. Real-browser
 * paint, CSS and focus are A6's evidence, not this file's.
 *
 * The negative cases are the point:
 *
 * | Input | Required result |
 * | --- | --- |
 * | `<script>alert(1)</script>` | no `<script>` element; text is escaped |
 * | `<img src=x onerror=alert(1)>` | no `<img>` element, no event attribute |
 * | `[x](javascript:alert(1))` | no `javascript:` URL, no focusable anchor |
 * | `<iframe …>` | no `<iframe>` element |
 * | `![alt](https://…/x.png)` | alt text only — no `<img>`, no `src` |
 *
 * Raw HTML is not parsed because this module never enables `rehype-raw` and never uses
 * `dangerouslySetInnerHTML`; React escapes the text.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import MarkdownPreviewRenderer, { safePreviewUrl } from './MarkdownPreviewRenderer.js';
import { hundredThousandMarkdown } from './testing/previewFixture.js';

function render(source: string): string {
  return renderToStaticMarkup(createElement(MarkdownPreviewRenderer, { source }));
}

describe('markdown preview renderer: supported Markdown', () => {
  it('renders headings h1–h6', () => {
    for (let level = 1; level <= 6; level += 1) {
      const html = render(`${'#'.repeat(level)} Heading ${level}`);
      expect(html).toContain(`<h${level}>Heading ${level}</h${level}>`);
    }
  });

  it('renders paragraphs', () => {
    const html = render('First paragraph.\n\nSecond paragraph.');
    expect(html).toContain('<p>First paragraph.</p>');
    expect(html).toContain('<p>Second paragraph.</p>');
  });

  it('renders bold and italic', () => {
    const html = render('This is **bold** and *italic* and `inline code`.');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>inline code</code>');
  });

  it('renders an unordered list', () => {
    const html = render('- alpha\n- beta');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>alpha</li>');
    expect(html).toContain('<li>beta</li>');
    expect(html).toContain('</ul>');
  });

  it('renders an ordered list', () => {
    const html = render('1. first\n2. second');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<li>second</li>');
    expect(html).toContain('</ol>');
  });

  it('renders a blockquote', () => {
    const html = render('> quoted text');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<p>quoted text</p>');
    expect(html).toContain('</blockquote>');
  });

  it('renders a fenced code block as pre > code with the language class', () => {
    const fenced = ['```ts', 'const answer = 42;', '```'].join('\n');
    const html = render(fenced);
    expect(html).toContain('<pre>');
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('const answer = 42;');
  });

  it('renders a link with rel="noopener noreferrer" and no target', () => {
    const html = render('[InsightHub](https://example.com/docs)');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('>InsightHub</a>');
    expect(html).not.toContain('target=');
  });

  it('renders a GFM table (remark-gfm)', () => {
    const html = render('| Name | Role |\n| --- | --- |\n| Ada | owner |\n| Linus | viewer |');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<th>Role</th>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<td>Ada</td>');
    expect(html).toContain('<td>viewer</td>');
  });

  it('shows an explicit empty state for an empty document', () => {
    const html = render('   \n\n');
    expect(html).toContain('data-testid="markdown-preview-content"');
    expect(html).toContain('markdown-preview__empty');
    expect(html).toContain('This document is empty.');
  });
});

describe('markdown preview renderer: images never become requests', () => {
  it('renders alt text only, with no <img> and no src', () => {
    const html = render('![a diagram](https://example.com/tracker.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracker.png');
    expect(html).not.toContain('src=');
    expect(html).toContain('markdown-preview__image');
    expect(html).toContain('[image: a diagram]');
    expect(html).toContain('data-image-alt="a diagram"');
  });

  it('renders a placeholder for an image with empty alt text', () => {
    const html = render('![](https://example.com/tracker.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('[image]');
  });
});

describe('markdown preview renderer: raw HTML is not parsed', () => {
  it('escapes a <script> tag instead of creating an element', () => {
    const html = render('<script>alert(1)</script>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<\/script/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes an <img onerror> payload instead of creating an element', () => {
    const html = render('<img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<[^>]*onerror/i);
    expect(html).toContain('&lt;img');
  });

  it('escapes an <iframe> instead of creating an element', () => {
    const html = render('<iframe src="https://evil.example"></iframe>');
    expect(html).not.toMatch(/<iframe/i);
    expect(html).toContain('&lt;iframe');
  });

  it('does not turn inline HTML into markup', () => {
    const html = render('This is <b>not bold</b>.');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt;');
  });
});

describe('markdown preview renderer: dangerous URLs are refused', () => {
  it('drops a javascript: link target and leaves no anchor', () => {
    const html = render('[x](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toMatch(/<a[\s>]/i);
    expect(html).toContain('markdown-preview__link-blocked');
    expect(html).toContain('>x</span>');
  });

  it('drops a data: URL', () => {
    const html = render('[payload](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toMatch(/<a[\s>]/i);
    expect(html).toContain('markdown-preview__link-blocked');
  });

  it('keeps ordinary protocols and relative URLs', () => {
    for (const url of [
      'https://example.com/a',
      'http://example.com/b',
      'mailto:ada@example.com',
      '#section',
      '/docs/page',
      './relative/page',
    ]) {
      const html = render(`[label](${url})`);
      expect(html).toContain('href=');
      expect(html).not.toContain('markdown-preview__link-blocked');
    }
  });
});

describe('markdown preview renderer: 100k document', () => {
  it('parses and renders a 100k document in one pass (timing instrumentation)', () => {
    const source = hundredThousandMarkdown();
    expect(source).toHaveLength(100_000);

    const started = performance.now();
    const html = render(source);
    const elapsed = performance.now() - started;

    // Test instrumentation, not product telemetry (D-086 §2 allows it in the harness).
    console.log(
      `[perf] 100k renderToStaticMarkup (node, parse + React elements): ${elapsed.toFixed(
        2,
      )} ms; HTML ${html.length} bytes`,
    );

    // The fixture is block-structured, so the output must contain real elements, not one blob.
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(elapsed).toBeLessThan(20_000);
  });
});

describe('safePreviewUrl', () => {
  it('allows http, https, mailto, fragments and relative URLs', () => {
    expect(safePreviewUrl('https://example.com')).toBe('https://example.com');
    expect(safePreviewUrl('http://example.com')).toBe('http://example.com');
    expect(safePreviewUrl('mailto:ada@example.com')).toBe('mailto:ada@example.com');
    expect(safePreviewUrl('#install')).toBe('#install');
    expect(safePreviewUrl('/docs/page')).toBe('/docs/page');
    expect(safePreviewUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('refuses javascript:, data:, vbscript: and tel:', () => {
    expect(safePreviewUrl('javascript:alert(1)')).toBe('');
    expect(safePreviewUrl('JaVaScRiPt:alert(1)')).toBe('');
    expect(safePreviewUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(safePreviewUrl('vbscript:msgbox(1)')).toBe('');
    expect(safePreviewUrl('tel:+15555550100')).toBe('');
  });
});
