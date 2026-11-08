/**
 * The pure half of the version **diff preview** (P0-1 pre-requisite 2).
 *
 * These tests pin the properties the HTTP endpoint relies on, without a server:
 *
 * - the segment order is `equal → delete → insert → equal`, so a renderer can walk the array;
 * - the concatenated equal/insert segments equal the target and the equal/delete segments equal
 *   the current text — i.e. the diff is a complete, non-overlapping partition of both bodies;
 * - boundaries are **code points**, so an emoji is one unit and `stats` counts it as one;
 * - equal texts produce no insert/delete segment, and two empty bodies produce `[]`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildVersionDiff, type TextDiffSegment } from './diff.js';

function joined(segments: readonly TextDiffSegment[], kinds: readonly string[]): string {
  return segments
    .filter((segment) => kinds.includes(segment.type))
    .map((segment) => segment.text)
    .join('');
}

describe('buildVersionDiff', () => {
  it('returns one equal segment when the texts match', () => {
    const result = buildVersionDiff('unchanged', 'unchanged');
    assert.deepEqual(result.diff, [{ type: 'equal', text: 'unchanged' }]);
    assert.deepEqual(result.stats, { inserted: 0, deleted: 0 });
  });

  it('returns [] for two empty bodies', () => {
    assert.deepEqual(buildVersionDiff('', ''), { diff: [], stats: { inserted: 0, deleted: 0 } });
  });

  it('renders an insertion between two equal spans', () => {
    const result = buildVersionDiff('abcdef', 'abcXdef');
    assert.deepEqual(result.diff, [
      { type: 'equal', text: 'abc' },
      { type: 'insert', text: 'X' },
      { type: 'equal', text: 'def' },
    ]);
    assert.deepEqual(result.stats, { inserted: 1, deleted: 0 });
    assert.equal(joined(result.diff, ['equal', 'insert']), 'abcXdef');
    assert.equal(joined(result.diff, ['equal', 'delete']), 'abcdef');
  });

  it('renders a deletion between two equal spans', () => {
    const result = buildVersionDiff('abcXdef', 'abcdef');
    assert.deepEqual(result.diff, [
      { type: 'equal', text: 'abc' },
      { type: 'delete', text: 'X' },
      { type: 'equal', text: 'def' },
    ]);
    assert.deepEqual(result.stats, { inserted: 0, deleted: 1 });
  });

  it('renders a replacement as delete then insert', () => {
    const result = buildVersionDiff('left old right', 'left new right');
    assert.deepEqual(result.diff, [
      { type: 'equal', text: 'left ' },
      { type: 'delete', text: 'old' },
      { type: 'insert', text: 'new' },
      { type: 'equal', text: ' right' },
    ]);
    assert.deepEqual(result.stats, { inserted: 3, deleted: 3 });
  });

  it('counts a family emoji as its code points, never as UTF-16 units', () => {
    const family = '👩‍👩‍👧';
    // `buildVersionDiff(current, target)`: the version (target) inserted a five-code-point ZWJ
    // sequence where the current body has a single-code-point globe.
    const result = buildVersionDiff('Hello 🌍 world', `Hello ${family} world`);
    assert.equal(Array.from(family).length, 5, 'the fixture is a five-code-point ZWJ sequence');
    assert.deepEqual(result.diff, [
      { type: 'equal', text: 'Hello ' },
      { type: 'delete', text: '🌍' },
      { type: 'insert', text: family },
      { type: 'equal', text: ' world' },
    ]);
    // One code point deleted, five inserted: not the 2/11 UTF-16 units.
    assert.deepEqual(result.stats, { inserted: 5, deleted: 1 });
    // No segment boundary splits a surrogate pair.
    for (const segment of result.diff) {
      for (const codePoint of Array.from(segment.text)) {
        assert.ok(codePoint.length >= 1);
      }
    }
  });

  it('handles a pure prefix change with no equal suffix', () => {
    const result = buildVersionDiff('abcdef', 'Xbcdef');
    assert.deepEqual(result.diff, [
      { type: 'delete', text: 'a' },
      { type: 'insert', text: 'X' },
      { type: 'equal', text: 'bcdef' },
    ]);
    assert.deepEqual(result.stats, { inserted: 1, deleted: 1 });
  });

  it('handles a pure suffix append', () => {
    const result = buildVersionDiff('abcdef', 'abcdef!');
    assert.deepEqual(result.diff, [
      { type: 'equal', text: 'abcdef' },
      { type: 'insert', text: '!' },
    ]);
  });

  it('never emits an empty segment', () => {
    for (const [current, target] of [
      ['', 'new'],
      ['old', ''],
      ['a', 'b'],
      ['same', 'same'],
    ] as const) {
      for (const segment of buildVersionDiff(current, target).diff) {
        assert.notEqual(segment.text, '');
      }
    }
  });
});
