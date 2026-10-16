/**
 * In-memory IndexedDB double for Node tests (A1 test support).
 *
 * ## What this is, and what it is NOT
 *
 * This is a **test double**, not a browser. It implements the slice of the
 * IndexedDB surface that `lib0/indexeddb` (and therefore `y-indexeddb`) actually
 * calls: `open`/`onupgradeneeded`, `transaction`/`objectStore`, `add` with
 * `autoIncrement`, `getAll` with key ranges, `delete`, `count`, `openCursor` and
 * `openKeyCursor`.
 *
 * It lets A1 verify the *real* `y-indexeddb` provider — that updates are written to
 * a store, that the replica is replayed into a fresh `Y.Doc`, and that a destroyed
 * provider stops writing — in a Node process with no browser.
 *
 * It does **not** prove that browser IndexedDB works. Transactions here commit
 * synchronously instead of on a task boundary, there is no quota, no structured
 * clone (values are held by reference), no version-change handling, and no real
 * crash durability. The browser path is covered by the manual runbook in
 * `apps/web/src/collab/README.md` (edit → reload → offline → content restored),
 * which is the only way to verify it honestly.
 */

type Key = number;

interface StoredRecord {
  key: Key;
  value: unknown;
}

interface RangeLike {
  lower: Key | undefined;
  lowerOpen: boolean;
  upper: Key | undefined;
  upperOpen: boolean;
}

interface KeyRangeConstructor {
  bound(lower: Key, upper: Key, lowerOpen?: boolean, upperOpen?: boolean): RangeLike;
  upperBound(upper: Key, upperOpen?: boolean): RangeLike;
  lowerBound(lower: Key, lowerOpen?: boolean): RangeLike;
  only(value: Key): RangeLike;
}

class FakeRequest {
  onsuccess: ((event: { target: FakeRequest }) => void) | null = null;

  onerror: ((event: { target: FakeRequest }) => void) | null = null;

  onupgradeneeded: ((event: { target: FakeRequest }) => void) | null = null;

  result: unknown = undefined;

  error: unknown = null;

  /** Deliver a result on a microtask, the way a real IDB request behaves. */
  succeed(value: unknown): void {
    this.result = value;
    queueMicrotask(() => {
      this.onsuccess?.({ target: this });
    });
  }

  fail(error: unknown): void {
    this.error = error;
    queueMicrotask(() => {
      this.onerror?.({ target: this });
    });
  }
}

class FakeCursor {
  /** Next index to serve; advanced by `continue()`. */
  index = 0;

  constructor(
    private readonly records: StoredRecord[],
    private readonly withValue: boolean,
  ) {}

  get key(): Key {
    return this.records[this.index]!.key;
  }

  get value(): unknown {
    return this.withValue ? this.records[this.index]!.value : undefined;
  }

  /** Queue the next cursor step; the request re-fires `onsuccess` with it. */
  continue(): void {
    this.index += 1;
    queueMicrotask(() => {
      this.notify?.();
    });
  }

  /** Set by the owning request so `continue()` can deliver the next record. */
  notify: (() => void) | undefined;
}

class FakeObjectStore {
  readonly records: StoredRecord[] = [];

  constructor(readonly name: string) {}

  private nextKey(): Key {
    let max = 0;
    for (const record of this.records) {
      if (record.key > max) max = record.key;
    }
    return max + 1;
  }

  inRange(range: RangeLike | null | undefined): StoredRecord[] {
    if (range === null || range === undefined) return [...this.records];
    return this.records.filter((record) => {
      if (range.lower !== undefined) {
        if (range.lowerOpen ? record.key <= range.lower : record.key < range.lower) return false;
      }
      if (range.upper !== undefined) {
        if (range.upperOpen ? record.key >= range.upper : record.key > range.upper) return false;
      }
      return true;
    });
  }

  add(value: unknown, key?: Key): FakeRequest {
    const request = new FakeRequest();
    const assigned = key ?? this.nextKey();
    this.records.push({ key: assigned, value });
    request.succeed(assigned);
    return request;
  }

  put(value: unknown, key?: Key): FakeRequest {
    const request = new FakeRequest();
    const assigned = key ?? this.nextKey();
    const existing = this.records.findIndex((record) => record.key === assigned);
    if (existing >= 0) this.records[existing] = { key: assigned, value };
    else this.records.push({ key: assigned, value });
    request.succeed(assigned);
    return request;
  }

  get(key: Key): FakeRequest {
    const request = new FakeRequest();
    const found = this.records.find((record) => record.key === key);
    request.succeed(found?.value);
    return request;
  }

  getAll(range?: RangeLike | null, limit?: number): FakeRequest {
    const request = new FakeRequest();
    const matched = this.inRange(range).map((record) => record.value);
    request.succeed(limit === undefined ? matched : matched.slice(0, limit));
    return request;
  }

  getAllKeys(range?: RangeLike | null, limit?: number): FakeRequest {
    const request = new FakeRequest();
    const matched = this.inRange(range).map((record) => record.key);
    request.succeed(limit === undefined ? matched : matched.slice(0, limit));
    return request;
  }

  count(range?: RangeLike | null): FakeRequest {
    const request = new FakeRequest();
    request.succeed(this.inRange(range).length);
    return request;
  }

  delete(key: Key | RangeLike): FakeRequest {
    const request = new FakeRequest();
    const doomed =
      typeof key === 'number'
        ? this.records.filter((record) => record.key === key)
        : this.inRange(key);
    for (const record of doomed) {
      const index = this.records.indexOf(record);
      if (index >= 0) this.records.splice(index, 1);
    }
    request.succeed(undefined);
    return request;
  }

  openCursor(range?: RangeLike | null, direction: 'next' | 'prev' = 'next'): FakeRequest {
    return this.iterate(range, direction, true);
  }

  openKeyCursor(range?: RangeLike | null, direction: 'next' | 'prev' = 'next'): FakeRequest {
    return this.iterate(range, direction, false);
  }

  /**
   * Cursor iteration.
   *
   * The request delivers the first record on the next microtask. `cursor.continue()`
   * asks for the following one, which is delivered through the *same* request — so
   * `onsuccess` must stay attached across steps, exactly as a real cursor behaves.
   * That is why `getAll`/`getLastKey`-style helpers that stop early (`return false`
   * from the callback) do not receive further records.
   */
  private iterate(
    range: RangeLike | null | undefined,
    direction: 'next' | 'prev',
    withValue: boolean,
  ): FakeRequest {
    const request = new FakeRequest();
    const ordered = this.inRange(range).slice();
    if (direction === 'prev') ordered.reverse();
    const cursor = new FakeCursor(ordered, withValue);
    let first = true;

    const deliver = (): void => {
      if (cursor.index >= ordered.length) {
        request.succeed(null);
        return;
      }
      request.result = cursor;
      if (first) {
        first = false;
        queueMicrotask(() => {
          request.onsuccess?.({ target: request });
        });
      }
    };

    cursor.notify = deliver;
    deliver();
    return request;
  }
}

class FakeTransaction {
  constructor(private readonly database: FakeDatabase) {}

  objectStore(name: string): FakeObjectStore {
    const store = this.database.stores.get(name);
    if (store === undefined) throw new Error(`object store "${name}" does not exist`);
    return store;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, FakeObjectStore>();

  createObjectStore(name: string): FakeObjectStore {
    const store = new FakeObjectStore(name);
    this.stores.set(name, store);
    return store;
  }

  transaction(names: string | string[]): FakeTransaction {
    const list = Array.isArray(names) ? names : [names];
    for (const name of list) {
      if (!this.stores.has(name)) throw new Error(`object store "${name}" does not exist`);
    }
    return new FakeTransaction(this);
  }

  close(): void {
    /* nothing to release in memory */
  }
}

/** A complete in-memory `indexedDB` implementation plus `IDBKeyRange`. */
export class FakeIndexedDb {
  readonly databases = new Map<string, FakeDatabase>();

  /** Every database ever created, including deleted ones (for assertions). */
  readonly createdNames: string[] = [];

  open(name: string): FakeRequest {
    const request = new FakeRequest();
    let database = this.databases.get(name);
    const isNew = database === undefined;
    if (database === undefined) {
      database = new FakeDatabase();
      this.databases.set(name, database);
      this.createdNames.push(name);
    }
    const target = database;
    queueMicrotask(() => {
      request.result = target;
      if (isNew) request.onupgradeneeded?.({ target: request });
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  deleteDatabase(name: string): FakeRequest {
    const request = new FakeRequest();
    this.databases.delete(name);
    queueMicrotask(() => {
      request.result = undefined;
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  /** The `IDBKeyRange` global that `lib0/indexeddb` reads. */
  static readonly keyRange: KeyRangeConstructor = {
    bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({
      lower,
      upper,
      lowerOpen,
      upperOpen,
    }),
    upperBound: (upper, upperOpen = false) => ({
      lower: undefined,
      upper,
      lowerOpen: false,
      upperOpen,
    }),
    lowerBound: (lower, lowerOpen = false) => ({
      lower,
      upper: undefined,
      lowerOpen,
      upperOpen: false,
    }),
    only: (value) => ({ lower: value, upper: value, lowerOpen: false, upperOpen: false }),
  };

  /**
   * Install `indexedDB`/`IDBKeyRange` globals for the duration of a test.
   *
   * `lib0/indexeddb` closes over the globals, so this is how a Node test gives the
   * real `y-indexeddb` provider somewhere to write. The returned function restores
   * the previous state.
   */
  install(): () => void {
    const host = globalThis as {
      indexedDB?: unknown;
      IDBKeyRange?: unknown;
    };
    const previousDb = host.indexedDB;
    const previousRange = host.IDBKeyRange;
    host.indexedDB = this as unknown as IDBFactory;
    host.IDBKeyRange = FakeIndexedDb.keyRange;
    return () => {
      this.restore('indexedDB', previousDb);
      this.restore('IDBKeyRange', previousRange);
    };
  }

  private restore(field: 'indexedDB' | 'IDBKeyRange', previous: unknown): void {
    const host = globalThis as Record<string, unknown>;
    if (previous === undefined) {
      delete host[field];
      return;
    }
    host[field] = previous;
  }

  /** Raw stored records for one database/store, for direct assertions. */
  records(databaseName: string, storeName = 'updates'): readonly unknown[] {
    const database = this.databases.get(databaseName);
    if (database === undefined) return [];
    const store = database.stores.get(storeName);
    if (store === undefined) return [];
    return store.records.map((record) => record.value);
  }
}
