/**
 * Deterministic 100,000-character Markdown fixture shared by the preview tests.
 *
 * It is intentionally *block-structured* (headings, paragraphs, lists, quotes) like the
 * D-086 performance fixture, so the measurement is about the renderer's own parsing and
 * React element creation, not about one pathological 100k line.
 *
 * Test-only module: it is never imported by application code.
 */
const BLOCK =
  '## Section\n\nParagraph with **bold**, *italic* and [a link](https://example.com).\n\n' +
  '- first item\n- second item\n\n> a quoted line\n\n';

/** Exactly 100,000 characters, identical on every call. */
export function hundredThousandMarkdown(): string {
  return BLOCK.repeat(Math.ceil(100_000 / BLOCK.length)).slice(0, 100_000);
}
