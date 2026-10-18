/**
 * Store doubles for the acceptance scenarios that need to *fault* the persistence layer.
 *
 * Each one wraps a real `SqliteDocumentStore` and delegates everything it does not
 * deliberately interfere with, so a test can break exactly one property while the rest of
 * the system — real sockets, real rooms, real SQLite — keeps behaving normally. That is the
 * difference between "the handler returns an error when I call it" and "the server stops
 * claiming success".
 *
 * They implement the frozen `DocumentStore` seam and nothing else: no test double here
 * imports `node:sqlite`, `ws` or a room, which is also a standing check that the seam is
 * genuinely replaceable.
 */
import type { DocumentStore, StoredDocument } from './types.js';

/** Delegating base: records nothing, changes nothing. */
export class WrappedStore implements DocumentStore {
  protected readonly inner: DocumentStore;

  constructor(inner: DocumentStore) {
    this.inner = inner;
  }

  load(documentId: string): Promise<StoredDocument | null> {
    return this.inner.load(documentId);
  }

  append(documentId: string, update: Uint8Array): Promise<number> {
    return this.inner.append(documentId, update);
  }

  compact(documentId: string, snapshot: Uint8Array, throughSequence: number): Promise<void> {
    return this.inner.compact(documentId, snapshot, throughSequence);
  }

  delete(documentId: string): Promise<void> {
    return this.inner.delete(documentId);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * Fails the *n*-th `append` (1-based), for scenarios F and I.
 *
 * It counts **attempts**, not successes, so a test can assert that a queued mutation was
 * never even tried: that is the observable difference between "the pipeline stopped" and
 * "the pipeline kept draining and swallowed the errors".
 */
export class FaultInjectingStore extends WrappedStore {
  /** Payloads that reached `append`, in order. Length = attempts. */
  readonly attempts: Uint8Array[] = [];
  #failAt: number | null = null;

  /** Fail the n-th attempt (1-based). `null` disables injection. */
  failOnAttempt(attempt: number | null): void {
    this.#failAt = attempt;
  }

  get attemptCount(): number {
    return this.attempts.length;
  }

  override async append(documentId: string, update: Uint8Array): Promise<number> {
    this.attempts.push(update);
    if (this.#failAt !== null && this.attempts.length === this.#failAt) {
      throw new Error(`injected persist failure on attempt ${this.attempts.length}`);
    }
    return this.inner.append(documentId, update);
  }
}

/**
 * Counts `load` calls and can hold them open, for scenarios J and K.
 *
 * - **J (single-flight)**: N concurrent joins must produce exactly one `load`.
 * - **K (backlog overflow)**: holding `load` open is how a room is forced to stay
 *   `HYDRATING` long enough for a client to overflow the bounded backlog.
 */
export class ControllableStore extends WrappedStore {
  loadCalls = 0;
  appendCalls = 0;

  #loadGate: Promise<void> | null = null;
  #openLoadGate: (() => void) | null = null;
  #appendGate: Promise<void> | null = null;
  #openAppendGate: (() => void) | null = null;

  /** Make every subsequent `load` wait until `releaseLoads()` is called. */
  holdLoads(): void {
    if (this.#loadGate !== null) return;
    this.#loadGate = new Promise<void>((resolve) => {
      this.#openLoadGate = resolve;
    });
  }

  /** Let held (and future) loads through. */
  releaseLoads(): void {
    const open = this.#openLoadGate;
    this.#loadGate = null;
    this.#openLoadGate = null;
    open?.();
  }

  /**
   * Make every subsequent `append` wait until `releaseAppends()` is called.
   *
   * This is how "broadcast only after commit" is proven rather than asserted: while the
   * persist is held, no peer may have received the update.
   */
  holdAppends(): void {
    if (this.#appendGate !== null) return;
    this.#appendGate = new Promise<void>((resolve) => {
      this.#openAppendGate = resolve;
    });
  }

  releaseAppends(): void {
    const open = this.#openAppendGate;
    this.#appendGate = null;
    this.#openAppendGate = null;
    open?.();
  }

  override async load(documentId: string): Promise<StoredDocument | null> {
    this.loadCalls += 1;
    if (this.#loadGate !== null) await this.#loadGate;
    return this.inner.load(documentId);
  }

  override async append(documentId: string, update: Uint8Array): Promise<number> {
    this.appendCalls += 1;
    if (this.#appendGate !== null) await this.#appendGate;
    return this.inner.append(documentId, update);
  }
}
