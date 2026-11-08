import { describe, expect, it } from 'vitest';

import { versionDiffSchema, versionDiffSegmentSchema } from './version-diff.js';

describe('version diff contract', () => {
  it('accepts the exact 200 shape and rejects extra fields', () => {
    const value = {
      versionId: 'v1',
      baseRevision: 2,
      currentRevision: 3,
      targetText: 'beta',
      currentText: 'alpha',
      diff: [
        { type: 'delete', text: 'alpha' },
        { type: 'insert', text: 'beta' },
      ],
      stats: { inserted: 4, deleted: 5 },
    };
    expect(versionDiffSchema.parse(value)).toEqual(value);
    expect(versionDiffSchema.safeParse({ ...value, yjs_state: 'AA==' }).success).toBe(false);
  });

  it('rejects unknown segment types and negative counts', () => {
    expect(versionDiffSegmentSchema.safeParse({ type: 'replace', text: 'x' }).success).toBe(false);
    expect(
      versionDiffSchema.safeParse({
        versionId: 'v1',
        baseRevision: 0,
        currentRevision: 0,
        targetText: '',
        currentText: '',
        diff: [],
        stats: { inserted: -1, deleted: 0 },
      }).success,
    ).toBe(false);
  });
});
