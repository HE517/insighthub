import { describe, expect, it } from 'vitest';

import { singleRangeChange } from './textDiff.js';

describe('singleRangeChange', () => {
  it('returns null when nothing changed', () => {
    expect(singleRangeChange('abc', 'abc')).toBeNull();
    expect(singleRangeChange('', '')).toBeNull();
  });

  it('reports an insertion at the end', () => {
    expect(singleRangeChange('abc', 'abcd')).toEqual({ from: 3, to: 3, insert: 'd' });
  });

  it('reports an insertion at the start', () => {
    expect(singleRangeChange('abc', 'Xabc')).toEqual({ from: 0, to: 0, insert: 'X' });
  });

  it('reports a deletion as an empty insert', () => {
    expect(singleRangeChange('abcd', 'ad')).toEqual({ from: 1, to: 3, insert: '' });
  });

  it('reports a replacement of the changed middle', () => {
    expect(singleRangeChange('a-b-c', 'a-X-c')).toEqual({ from: 2, to: 3, insert: 'X' });
  });

  it('handles a repeated character without producing a negative range', () => {
    // 'ab' -> 'aab' shares a prefix ('a') and a suffix ('b'); a naive prefix +
    // suffix scan can consume the same character twice and yield to < from.
    const change = singleRangeChange('ab', 'aab');
    expect(change).not.toBeNull();
    expect(change!.from).toBeLessThanOrEqual(change!.to);
    expect(apply(change!, 'ab')).toBe('aab');
  });

  it('round-trips every case back to the target text', () => {
    const pairs: [string, string][] = [
      ['', 'hello'],
      ['hello', ''],
      ['hello', 'hello world'],
      ['hello world', 'hello'],
      ['aaa', 'aaaa'],
      ['aaaa', 'aaa'],
      ['line1\nline2\n', 'line1\nX\nline2\n'],
      ['# Title\n\nbody', '# Title\n\nbody\n'],
    ];

    for (const [before, after] of pairs) {
      const change = singleRangeChange(before, after);
      expect(change, `${before} -> ${after}`).not.toBeNull();
      expect(apply(change!, before)).toBe(after);
    }
  });

  it('keeps the changed range minimal for a single-character edit in a long body', () => {
    const before = 'x'.repeat(5000);
    const after = `${'x'.repeat(2500)}y${'x'.repeat(2499)}`;
    const change = singleRangeChange(before, after);
    // One byte replaced, not the whole 5000-character document: this is what
    // keeps a remote keystroke from rewriting the editor buffer.
    expect(change!.to - change!.from).toBe(1);
  });
});

function apply(change: { from: number; to: number; insert: string }, before: string): string {
  return before.slice(0, change.from) + change.insert + before.slice(change.to);
}
