import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import {
  awarenessStateSchema,
  collectValidAwarenessStates,
  isAwarenessState,
  type AwarenessState,
} from './awareness-state.js';

const validState: AwarenessState = {
  user: { id: 'u1', name: 'Ada', color: '#1677ff' },
  cursor: { anchor: 4, head: 4 },
  selection: { from: 0, to: 4 },
  updatedAt: 1_700_000_000_000,
};

describe('awareness state contract', () => {
  it('accepts a well-formed state', () => {
    assert.equal(awarenessStateSchema.safeParse(validState).success, true);
    expect(isAwarenessState(validState)).toBe(true);
  });

  it('accepts the nullable cursor/selection shape', () => {
    const idle: AwarenessState = {
      user: { id: 'u2', name: 'Grace' },
      cursor: null,
      selection: null,
      updatedAt: 1,
    };
    assert.equal(isAwarenessState(idle), true);
  });

  it('rejects a state without an identity', () => {
    assert.equal(isAwarenessState({ cursor: null, selection: null, updatedAt: 1 }), false);
    assert.equal(isAwarenessState({ ...validState, user: { id: '', name: 'x' } }), false);
  });

  it('rejects a negative cursor offset', () => {
    assert.equal(isAwarenessState({ ...validState, cursor: { anchor: -1, head: 0 } }), false);
  });

  it('rejects an inverted selection', () => {
    assert.equal(isAwarenessState({ ...validState, selection: { from: 10, to: 3 } }), false);
  });

  it('rejects a non-hex colour instead of rendering it into the UI', () => {
    assert.equal(
      isAwarenessState({ ...validState, user: { id: 'u1', name: 'Ada', color: 'red' } }),
      false,
    );
    assert.equal(
      isAwarenessState({ ...validState, user: { id: 'u1', name: 'Ada', color: '#fff' } }),
      false,
    );
  });

  it('rejects arbitrary payloads, because peers are untrusted', () => {
    assert.equal(isAwarenessState(null), false);
    assert.equal(isAwarenessState('Ada'), false);
    assert.equal(isAwarenessState([]), false);
    assert.equal(isAwarenessState({ evil: '<script>' }), false);
  });

  it('filters a raw awareness map down to contract-valid entries', () => {
    const raw = new Map<number, unknown>([
      [1, validState],
      [2, { user: { id: 'u3', name: 'Alan' }, cursor: null, selection: null, updatedAt: 5 }],
      [3, { not: 'a valid state' }],
      [4, null],
    ]);

    const valid = collectValidAwarenessStates(raw);
    assert.equal(valid.size, 2);
    assert.deepEqual([...valid.keys()], [1, 2]);
    assert.equal(valid.get(1)?.user.name, 'Ada');
  });
});
