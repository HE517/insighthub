/**
 * T7 — the Unicode contract of the restore diff (A7 Q5; `docs/agent-governance/P0-1-CONTRACTS.md`
 * C9: this runs inside `pnpm test`).
 *
 * ## What is proven, and what is a known limitation
 *
 * The 5 code-point cases assert the **production** helper (`versions/text-diff.ts`), not the
 * experiment script: the experiment's 33 checks live under `tests/experiments/**`, which the
 * gate does not run, so a defect could come back in the production copy unnoticed (A7 Q5-5).
 *
 * The 4 grapheme cases are the accepted limitation: boundaries are code points, not grapheme
 * clusters. A family emoji can be edited piecewise, so a remote cursor may be anchored inside
 * the cluster for a frame — but the final text is character-for-character the target. That is
 * the property restore promises, and it is asserted here rather than described in prose.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as Y from 'yjs';

import { applyTextEdits, restoreTextDiff, type TextEdit } from './text-diff.js';

/** Apply the edits to a plain string, exactly as the production helper does to `Y.Text`. */
function applyToString(current: string, edits: readonly TextEdit[]): string {
  let result = current;
  for (const edit of [...edits].sort((left, right) => right.index - left.index)) {
    result = result.slice(0, edit.index) + edit.insert + result.slice(edit.index + edit.deleteLength);
  }
  return result;
}

function assertNoLoneSurrogate(value: string, label: string): void {
  // `isWellFormed` is the runtime's own definition of "no unpaired surrogate". Node ≥ 20 has it.
  const isWellFormed = (value as string & { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof isWellFormed === 'function') {
    assert.ok(isWellFormed.call(value), `${label} must not contain a lone surrogate`);
    return;
  }
  // Fallback for a runtime without it: walk the code units.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      index += 1;
      assert.ok(
        index < value.length && value.charCodeAt(index) >= 0xdc00 && value.charCodeAt(index) <= 0xdfff,
        `${label} must not contain a lone high surrogate`,
      );
      continue;
    }
    assert.ok(code < 0xdc00 || code > 0xdfff, `${label} must not contain a lone low surrogate`);
  }
}

describe('T7 — code-point restore diff (5 cases)', () => {
  const cases: { name: string; current: string; target: string }[] = [
    { name: 'ASCII replacement', current: 'alpha', target: 'beta' },
    { name: 'emoji replacement (surrogate pair)', current: 'hello😀', target: 'hello😃' },
    { name: 'emoji insertion', current: 'a😀b', target: 'a😀🎉b' },
    { name: 'emoji deletion', current: 'a😀b', target: 'ab' },
    { name: 'CJK + emoji replacement', current: '你好😀世界', target: '你好🌍世界' },
  ];

  for (const { name, current, target } of cases) {
    it(`produces the target exactly: ${name}`, () => {
      const edits = restoreTextDiff(current, target);
      assert.equal(edits.length, 1, 'a single replacement is expected');
      assert.equal(applyToString(current, edits), target);

      // Every boundary must be a code-point boundary: slicing the prefix cannot cut a pair.
      for (const edit of edits) {
        const prefix = current.slice(0, edit.index);
        assertNoLoneSurrogate(prefix, `prefix of ${name}`);
        assertNoLoneSurrogate(edit.insert, `insert of ${name}`);
      }
    });
  }

  it('returns no edit for identical texts', () => {
    assert.deepEqual(restoreTextDiff('same', 'same'), []);
  });

  it('applies to a real Y.Text through the shared helper', () => {
    const doc = new Y.Doc();
    try {
      const text = doc.getText('content');
      text.insert(0, 'hello😀');
      const edits = restoreTextDiff(text.toString(), 'hello😃');
      const changed = applyTextEdits(edits, text, (body) => {
        doc.transact(body);
      });
      assert.equal(changed, true);
      assert.equal(text.toString(), 'hello😃');
    } finally {
      doc.destroy();
    }
  });
});

describe('T7 — grapheme-cluster known limitation (4 cases)', () => {
  const cases: { name: string; current: string; target: string }[] = [
    { name: 'family ZWJ replacement', current: 'a👨‍👩‍👧b', target: 'a👨‍👦‍👧b' },
    { name: 'family ZWJ member deletion', current: 'a👨‍👩‍👧b', target: 'a👨‍👧b' },
    { name: 'flag replacement', current: 'x🇨🇳y', target: 'x🇺🇸y' },
    { name: 'skin-tone replacement', current: 'x👍🏽y', target: 'x👍🏿y' },
  ];

  for (const { name, current, target } of cases) {
    it(`still restores the exact text: ${name}`, () => {
      const edits = restoreTextDiff(current, target);
      // Known limitation: the boundary is a code point, so it may fall *inside* the cluster
      // (a ZWJ sequence, a flag's regional indicators, a modifier). The final text is exact.
      assert.equal(applyToString(current, edits), target);
      assertNoLoneSurrogate(applyToString(current, edits), name);
    });
  }
});
