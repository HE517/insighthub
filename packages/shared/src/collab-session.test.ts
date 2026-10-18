import { describe, expect, it } from 'vitest';

import {
  parsePresencePatch,
  PresencePatchError,
  PRESENCE_PATCH_FIELDS,
  type CollaborativeSession,
  type PresencePatch,
} from './collab-session.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { SHARED_CONTRACT_VERSION } from './index.js';

/**
 * Contract tests for the presence **write** seam (`docs/CONTRACTS.md` §15, M2-P0-2).
 *
 * These pin the rule the seam exists to add: the *shape this client publishes* is now
 * owned by the contract and validated before anything is written, using the same
 * schemas the read side applies to peer input.
 *
 * They are red before the seam exists in the only way that matters: `publishPresence`
 * is not on `CollaborativeSession` and `parsePresencePatch` does not exist, so this
 * file cannot even compile against the previous contract version. The behavioural
 * assertions below are what make the *next* refactor of the write path safe.
 */

/** A helper so a test can assert "this throws a PresencePatchError". */
function expectRejected(patch: unknown, pattern?: RegExp): void {
  expect(() => parsePresencePatch(patch)).toThrow(PresencePatchError);
  if (pattern !== undefined) expect(() => parsePresencePatch(patch)).toThrow(pattern);
}

describe('presence patch contract', () => {
  it('accepts a cursor-only patch and keeps the other field absent', () => {
    const patch = parsePresencePatch({ cursor: { anchor: 3, head: 7 } });
    expect(patch).toEqual({ cursor: { anchor: 3, head: 7 } });
    // Absent means "leave unchanged" — not "clear". This is what makes a partial
    // patch safe, and it is observable as a missing own key.
    expect(Object.hasOwn(patch, 'selection')).toBe(false);
  });

  it('accepts a selection-only patch and keeps the other field absent', () => {
    const patch = parsePresencePatch({ selection: { from: 2, to: 9 } });
    expect(patch).toEqual({ selection: { from: 2, to: 9 } });
    expect(Object.hasOwn(patch, 'cursor')).toBe(false);
  });

  it('accepts explicit nulls, which mean "clear" rather than "unchanged"', () => {
    const patch = parsePresencePatch({ cursor: null, selection: null });
    expect(patch).toEqual({ cursor: null, selection: null });
    expect(Object.hasOwn(patch, 'cursor')).toBe(true);
  });

  it('accepts an empty patch (a presence refresh with no geometry change)', () => {
    expect(parsePresencePatch({})).toEqual({});
  });

  it('treats an explicit undefined field as absent', () => {
    const patch = parsePresencePatch({ cursor: undefined, selection: { from: 1, to: 1 } });
    expect(patch).toEqual({ selection: { from: 1, to: 1 } });
    expect(Object.hasOwn(patch, 'cursor')).toBe(false);
  });

  it('exposes exactly the two covered fields', () => {
    expect(PRESENCE_PATCH_FIELDS).toEqual(['cursor', 'selection']);
  });

  it('rejects a caller-supplied updatedAt, naming the real reason', () => {
    expectRejected(
      { cursor: { anchor: 0, head: 0 }, updatedAt: 1 },
      /updatedAt is owned by the collaboration layer/,
    );
  });

  it('rejects unknown patch keys, including the identity', () => {
    expectRejected({ user: { id: 'u', name: 'U' } }, /does not accept "user"/);
    expectRejected({ clientId: 7 }, /does not accept "clientId"/);
  });

  it('rejects extra fields inside cursor and selection', () => {
    expectRejected({ cursor: { anchor: 0, head: 0, extra: 1 } }, /does not accept "extra"/);
    expectRejected({ selection: { from: 0, to: 1, anchor: 0 } }, /does not accept "anchor"/);
  });

  it('rejects out-of-range cursor offsets', () => {
    expectRejected({ cursor: { anchor: -1, head: 0 } }, /cursor is invalid/);
    expectRejected({ cursor: { anchor: 0.5, head: 0 } }, /cursor is invalid/);
    expectRejected({ cursor: { anchor: Number.NaN, head: 0 } }, /cursor is invalid/);
    expectRejected({ cursor: { anchor: Number.POSITIVE_INFINITY, head: 0 } }, /cursor is invalid/);
  });

  it('rejects a reversed or malformed selection', () => {
    // The message comes from `awarenessSelectionSchema`'s own refine, which is the
    // point: the write side reuses the read side's rule instead of restating it.
    expectRejected({ selection: { from: 9, to: 2 } }, /selection\.from must be <= selection\.to/);
    expectRejected({ selection: { from: -1, to: 2 } }, /selection is invalid/);
    expectRejected({ selection: { from: Number.NaN, to: Number.NaN } }, /selection is invalid/);
    expectRejected({ selection: { from: 1 } }, /selection is invalid/);
  });

  it('rejects a non-object patch or a malformed field value', () => {
    expectRejected(null, /must be an object/);
    expectRejected(undefined, /must be an object/);
    expectRejected('cursor', /must be an object/);
    expectRejected([{ cursor: null }], /must be an object/);
    expectRejected({ cursor: 'here' }, /cursor must be an object/);
    expectRejected({ selection: 42 }, /selection must be an object/);
  });

  it('never mutates the caller-supplied patch', () => {
    const cursor = { anchor: 1, head: 2 };
    const patch = { cursor };
    parsePresencePatch(patch);
    expect(cursor).toEqual({ anchor: 1, head: 2 });
    expect(Object.keys(patch)).toEqual(['cursor']);
  });
});

describe('presence seam shape', () => {
  it('puts publishPresence on CollaborativeSession, taking a PresencePatch', () => {
    // Compile-time: the method exists on the frozen seam with the frozen signature.
    type Publish = CollaborativeSession['publishPresence'];
    const publish: Publish = (patch: PresencePatch): void => {
      void patch;
    };
    expect(typeof publish).toBe('function');
  });

  it('does not let a caller supply updatedAt in a patch', () => {
    const valid: PresencePatch = { cursor: { anchor: 0, head: 0 } };
    expect(valid.cursor).toEqual({ anchor: 0, head: 0 });

    // Compile-time: `updatedAt` is not part of the patch type.
    // @ts-expect-error updatedAt is owned by the collaboration layer, not the caller.
    const rejected: PresencePatch = { cursor: null, updatedAt: 1 };
    void rejected;
  });

  it('bumps the shared contract version but not the protocol version', () => {
    // The seam is an interface-level addition: version up.
    expect(SHARED_CONTRACT_VERSION).toBe(3);
    // The wire is untouched: awareness already carried cursor and selection.
    expect(PROTOCOL_VERSION).toBe(2);
  });
});
