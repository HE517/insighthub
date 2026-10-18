/**
 * The per-document FIFO mutation queue: the mechanism behind
 * `docs/CONTRACTS.md` §14.6 and `docs/DECISIONS.md` D-048.
 *
 * ## The invariant, and why it is a queue rather than "the backend is synchronous"
 *
 * For one document, `apply → persist → broadcast` is one uninterruptible sequence:
 * `U(n+1)`'s `apply` may not begin before `U(n)` completes, and the same holds for
 * `persist` and `broadcast`. Different documents are independent and run in parallel.
 *
 * Writing that as "it works because `DatabaseSync` is synchronous" is not enough. If
 * U1's `persist` could interleave with U2's `broadcast`, there is a window in which the
 * server has already told a peer about U2 while its own durable order is undecided — or
 * while U1's persist is failing. Peer state and recoverable state then diverge, and a
 * divergence of that kind cannot be repaired by reconnecting, because reconnect merges the
 * difference as concurrent edits. So the ordering lives on the seam and must survive an
 * async adapter.
 *
 * ## Fail-stop is part of the queue, not of the caller
 *
 * The first failure stops the queue permanently. Two consequences the task brief calls out
 * explicitly:
 *
 * - the failing task is not retried;
 * - **already-queued tasks are never attempted.** A queue that keeps draining after a
 *   failure publishes state the server cannot recover (D-048 point 4 says this is the part
 *   usually missed).
 *
 * Implementing the stop here rather than at each call site means there is no way to
 * construct a pipeline that forgot it.
 */

/** Raised for a task that was queued but never attempted because the queue had stopped. */
export class QueueStoppedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`digest queue stopped: ${reason}`);
    this.name = 'QueueStoppedError';
    this.reason = reason;
  }
}

export class SerialTaskQueue {
  /** Resolves when the most recently enqueued task has settled. */
  #tail: Promise<void> = Promise.resolve();
  #stoppedReason: string | null = null;
  #queued = 0;

  /** True once the queue has stopped; nothing more will run. */
  get stopped(): boolean {
    return this.#stoppedReason !== null;
  }

  /** Why the queue stopped, or `null` while it is healthy. */
  get stoppedReason(): string | null {
    return this.#stoppedReason;
  }

  /** Tasks enqueued and not yet settled (running plus waiting). */
  get pending(): number {
    return this.#queued;
  }

  /**
   * Enqueue `task`, to run after every previously enqueued task has settled.
   *
   * The returned promise rejects with `QueueStoppedError` if the queue stopped before this
   * task could start, and with the task's own error if the task itself failed.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.#queued += 1;

    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return previous.then(async (): Promise<T> => {
      try {
        // Fail-stop point: a queued task that arrives after the stop is *not attempted*.
        if (this.#stoppedReason !== null) throw new QueueStoppedError(this.#stoppedReason);

        try {
          return await task();
        } catch (error) {
          // First failure stops the pipeline permanently (D-048). A `QueueStoppedError`
          // means the stop already happened elsewhere; it must not rewrite the reason.
          if (this.#stoppedReason === null && !(error instanceof QueueStoppedError)) {
            this.#stoppedReason = 'failed';
          }
          throw error;
        }
      } finally {
        this.#queued -= 1;
        release();
      }
    });
  }

  /**
   * Stop the queue. Idempotent; the first reason wins.
   *
   * Does not cancel a task that is already running (it cannot: the persist is in flight),
   * but guarantees that nothing queued behind it is ever started.
   */
  stop(reason: string): void {
    if (this.#stoppedReason === null) this.#stoppedReason = reason;
  }
}
