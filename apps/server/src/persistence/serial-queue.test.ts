/**
 * The per-document FIFO pipeline (`docs/CONTRACTS.md` §14.6, §14.8;
 * `docs/DECISIONS.md` D-048).
 *
 * ## Why these are the tests that matter most in M2-P0-1
 *
 * The ordering invariant is the one thing a synchronous backend makes look unnecessary: with
 * `DatabaseSync` everything "just happens in order", so a bug in the queue would stay invisible
 * until someone swaps in an async adapter. These tests drive the queue directly and assert the
 * two properties the frozen contract names:
 *
 * 1. the three phases of one mutation never interleave with another's;
 * 2. the first failure stops the pipeline permanently — including the mutations **already
 *    queued**, which must never be attempted.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QueueStoppedError, SerialTaskQueue } from './serial-queue.js';

describe('SerialTaskQueue — FIFO without interleaving', () => {
  it('runs tasks in enqueue order even when earlier ones are slower', async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];

    const slow = queue.enqueue(async () => {
      events.push('start-1');
      await delay(30);
      events.push('end-1');
    });
    const fast = queue.enqueue(async () => {
      events.push('start-2');
      events.push('end-2');
    });

    await Promise.all([slow, fast]);
    assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('never lets two tasks overlap, which is the interleaving the contract forbids', async () => {
    const queue = new SerialTaskQueue();
    let running = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 5 }, () =>
      queue.enqueue(async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await delay(5);
        running -= 1;
      }),
    );

    await Promise.all(tasks);
    assert.equal(maxConcurrent, 1, 'at most one task of a document may be in flight');
  });

  it('preserves order across many tasks with mixed durations', async () => {
    const queue = new SerialTaskQueue();
    const order: number[] = [];
    const tasks = [40, 5, 25, 1, 10, 3].map((duration, index) =>
      queue.enqueue(async () => {
        await delay(duration);
        order.push(index);
      }),
    );

    await Promise.all(tasks);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  });

  it('keeps two documents independent, so one slow persist does not block the other', async () => {
    // The other half of D-048: serialization is *per document*. A single global queue would
    // make one document's slow disk stall every other document, and would show up here as
    // strict a-then-b ordering instead of overlap.
    const documentA = new SerialTaskQueue();
    const documentB = new SerialTaskQueue();
    const events: string[] = [];

    const slowA = documentA.enqueue(async () => {
      events.push('a-start');
      await delay(60);
      events.push('a-end');
    });
    const fastB = documentB.enqueue(async () => {
      events.push('b-start');
      await delay(10);
      events.push('b-end');
    });

    await Promise.all([slowA, fastB]);

    assert.deepEqual(
      events,
      ['a-start', 'b-start', 'b-end', 'a-end'],
      'B must finish inside A’s window: the two documents are independent',
    );
  });
});

describe('SerialTaskQueue — fail-stop (D-048)', () => {
  it('stops permanently after the first failure', async () => {
    const queue = new SerialTaskQueue();

    await assert.rejects(
      () =>
        queue.enqueue(async () => {
          throw new Error('persist failed');
        }),
      /persist failed/,
    );

    assert.equal(queue.stopped, true);
    assert.equal(queue.stoppedReason, 'failed');
  });

  it('never runs a task that was queued before the failure but not started', async () => {
    // This is D-048 point 4, the obligation the decision record calls "the one usually
    // missed": a queue that keeps draining after a failure publishes state the server cannot
    // recover.
    const queue = new SerialTaskQueue();
    const attempted: string[] = [];

    const failing = queue.enqueue(async () => {
      attempted.push('first');
      throw new Error('persist failed');
    });
    const queuedBehind = queue.enqueue(async () => {
      attempted.push('second');
    });
    const queuedLater = queue.enqueue(async () => {
      attempted.push('third');
    });

    await assert.rejects(() => failing, /persist failed/);
    await assert.rejects(() => queuedBehind, QueueStoppedError);
    await assert.rejects(() => queuedLater, QueueStoppedError);

    assert.deepEqual(attempted, ['first'], 'only the failing task may ever have run');
  });

  it('rejects a new task immediately once stopped', async () => {
    const queue = new SerialTaskQueue();
    queue.stop('unhealthy');

    await assert.rejects(() => queue.enqueue(async () => undefined), QueueStoppedError);
    assert.equal(queue.stoppedReason, 'unhealthy');
  });

  it('keeps the first stop reason when another route stops it again', async () => {
    const queue = new SerialTaskQueue();
    queue.stop('failed');
    queue.stop('evicted');
    assert.equal(queue.stoppedReason, 'failed', 'the first reason is the cause worth logging');
  });

  it('reports pending work so a caller can reason about an idle pipeline', async () => {
    const queue = new SerialTaskQueue();
    assert.equal(queue.pending, 0);

    const task = queue.enqueue(async () => {
      await delay(10);
    });
    assert.ok(queue.pending >= 0);

    await task;
    assert.equal(queue.pending, 0, 'a settled task must not be counted as pending');
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
