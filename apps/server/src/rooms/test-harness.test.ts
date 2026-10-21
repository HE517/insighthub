/**
 * Guard for the test harness's own liveness invariant (`docs/TASKS.md` TOOLING-P2, D-070).
 *
 * `y-protocols`' `Awareness` constructor starts a **ref'd** renewal timer. A test that failed
 * before `awareness.destroy()` therefore left the timer running: the `node:test` child had
 * already produced its results, but its event loop never drained, so the runner waited for it
 * forever and the gate printed every result and hung — hiding the red `not ok` in the process.
 *
 * `createTestAwareness` unrefs that timer. This test exists so the invariant cannot silently
 * regress back into a hung gate.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as Y from 'yjs';

import { createTestAwareness } from './test-harness.js';

describe('test harness liveness', () => {
  it('unrefs the client Awareness renewal timer so a failed test cannot hang the gate', () => {
    const doc = new Y.Doc();
    const awareness = createTestAwareness(doc);
    try {
      const timer = (
        awareness as unknown as { _checkInterval?: { hasRef?: () => boolean } | null }
      )._checkInterval;
      assert.ok(timer, 'y-protocols must have started its renewal timer');
      assert.equal(
        timer?.hasRef?.(),
        false,
        'the renewal timer must not keep a test process alive after a failure',
      );
    } finally {
      awareness.destroy();
      doc.destroy();
    }
  });
});
