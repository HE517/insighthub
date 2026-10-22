import { describe, expect, it } from 'vitest';

import { unifiedDiff } from './diff.js';

/** Content lines only — the `---` / `+++` headers also start with `-` and `+`. */
function contentLines(diff: string, prefix: '+' | '-'): string[] {
  return diff
    .split('\n')
    .slice(2)
    .filter((line) => line.startsWith(prefix));
}

/**
 * The diff is display text for the Diff Preview. These tests pin the four scenarios the round
 * brief names — pure insert, pure delete, replace, empty document — plus hunk grouping, because a
 * preview that renders a wrong header would misdescribe what Accept is about to do.
 */

describe('unifiedDiff: the four required scenarios', () => {
  it('describes a pure insertion with a + line and no - line', () => {
    const diff = unifiedDiff('a\nb', 'a\nX\nb');

    expect(diff).toBe('--- original\n+++ proposed\n@@ -1,2 +1,3 @@\n a\n+X\n b\n');
    expect(contentLines(diff, '+')).toEqual(['+X']);
    expect(contentLines(diff, '-')).toEqual([]);
  });

  it('describes a pure deletion with a - line and no + line', () => {
    const diff = unifiedDiff('a\nX\nb', 'a\nb');

    expect(diff).toBe('--- original\n+++ proposed\n@@ -1,3 +1,2 @@\n a\n-X\n b\n');
    expect(contentLines(diff, '-')).toEqual(['-X']);
    expect(contentLines(diff, '+')).toEqual([]);
  });

  it('describes a replacement as one - line and one + line', () => {
    const diff = unifiedDiff('hello', 'world');

    expect(diff).toBe('--- original\n+++ proposed\n@@ -1 +1 @@\n-hello\n+world\n');
  });

  it('returns an empty string when both documents are empty', () => {
    expect(unifiedDiff('', '')).toBe('');
  });

  it('inserts into an empty document with the -0,0 header convention', () => {
    expect(unifiedDiff('', 'first')).toBe('--- original\n+++ proposed\n@@ -0,0 +1 @@\n+first\n');
  });

  it('deletes the only line with the +0,0 header convention', () => {
    expect(unifiedDiff('first', '')).toBe('--- original\n+++ proposed\n@@ -1 +0,0 @@\n-first\n');
  });
});

describe('unifiedDiff: hunks and context', () => {
  it('groups nearby changes into one hunk and splits distant ones', () => {
    const before = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join('\n');
    const afterLines = before.split('\n');
    afterLines[1] = 'changed2';
    afterLines[8] = 'changed9';
    const diff = unifiedDiff(before, afterLines.join('\n'), { context: 1 });

    const headers = diff.split('\n').filter((line) => line.startsWith('@@'));
    expect(headers).toEqual(['@@ -1,3 +1,3 @@', '@@ -8,3 +8,3 @@']);
    expect(diff).toContain('-line2');
    expect(diff).toContain('+changed2');
    expect(diff).toContain('-line9');
    expect(diff).toContain('+changed9');
  });

  it('supports zero context lines', () => {
    const diff = unifiedDiff('a\nchange-me\nb', 'a\nnew\nb', { context: 0 });

    expect(diff).toBe('--- original\n+++ proposed\n@@ -2 +2 @@\n-change-me\n+new\n');
  });

  it('honours custom header labels', () => {
    const diff = unifiedDiff('one', 'two', {
      beforeLabel: 'document (current)',
      afterLabel: 'document (proposed)',
    });

    expect(diff.startsWith('--- document (current)\n+++ document (proposed)\n')).toBe(true);
  });
});

describe('unifiedDiff: purity and line model', () => {
  it('is deterministic for the same input', () => {
    const before = 'alpha\nbeta\ngamma\n';
    const after = 'alpha\nBETA\ngamma\ndelta\n';

    expect(unifiedDiff(before, after)).toBe(unifiedDiff(before, after));
  });

  it('treats CRLF as line endings and a trailing newline as a terminator', () => {
    // "a\r\nb\r\n" is two lines; changing b must produce one hunk, not a whole-file rewrite.
    const diff = unifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n');

    expect(diff).toBe('--- original\n+++ proposed\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
  });

  it('does not emit a diff for a trailing-newline-only difference', () => {
    // Display-only normalisation: line terminators do not change line content.
    expect(unifiedDiff('a\nb', 'a\nb\n')).toBe('');
  });
});
