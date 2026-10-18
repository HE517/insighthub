/**
 * Store-level invariants for the durable persistence seam
 * (`docs/CONTRACTS.md` §14.1, §14.7; `docs/DECISIONS.md` D-042, D-052).
 *
 * These are the properties the room layer is allowed to rely on, asserted directly against
 * the SQLite adapter so a regression is reported as a store bug rather than surfacing later
 * as a mysterious convergence failure.
 *
 * Every test gets its own temporary directory (`docs/DECISIONS.md` D-041), so a run can
 * never touch `./.insighthub-data`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { TRANSACTION_ORIGINS } from '@insighthub/shared';
import * as Y from 'yjs';

import { applyStoredDocument } from './hydrator.js';
import { openDocumentStore } from './open-store.js';
import { StoreClosedError, type DocumentStore } from './types.js';

let dataPath: string;
let store: DocumentStore;

beforeEach(async () => {
  dataPath = mkdtempSync(join(tmpdir(), 'insighthub-store-test-'));
  store = (await openDocumentStore(dataPath)).store;
});

afterEach(async () => {
  await store.close();
  rmSync(dataPath, { recursive: true, force: true });
});

/** Rebuild a document from durable state alone, the way a fresh server would. */
async function replay(documentId: string): Promise<Y.Doc> {
  const stored = await store.load(documentId);
  const doc = new Y.Doc();
  if (stored !== null) applyStoredDocument(stored, doc);
  return doc;
}

/** The rendered text of the durable state, which is the projection a user would see. */
async function persistedText(documentId: string): Promise<string> {
  const doc = await replay(documentId);
  const text = doc.getText('content').toString();
  doc.destroy();
  return text;
}

/** An update that appends `value` to the document's text. */
function updateAppending(current: Y.Doc, value: string): Uint8Array {
  const before = Y.encodeStateVector(current);
  current.getText('content').insert(current.getText('content').length, value);
  return Y.encodeStateAsUpdate(current, before);
}

describe('DocumentStore — the "never stored" distinction', () => {
  it('returns null for a document that has never been stored', async () => {
    // `null` means "never stored", not "empty document" (`docs/CONTRACTS.md` §14.1). A
    // caller that conflated the two would have no way to tell a fresh document from a
    // failed read.
    assert.equal(await store.load('never-written'), null);
  });

  it('returns a stored document whose row exists but whose log is empty', async () => {
    const doc = new Y.Doc();
    const update = updateAppending(doc, 'first');
    await store.append('doc-created', update);
    await store.compact('doc-created', Y.encodeStateAsUpdate(doc), 1);

    const stored = await store.load('doc-created');
    assert.ok(stored !== null, 'a compacted document must still load');
    if (stored === null) return;
    assert.equal(stored.snapshotSequence, 1);
    assert.deepEqual(stored.updates, [], 'compaction removed every consumed log row');
    doc.destroy();
  });
});

describe('DocumentStore — sequence allocation (D-052)', () => {
  it('allocates strictly increasing sequences and returns each one', async () => {
    const doc = new Y.Doc();
    const sequences: number[] = [];
    for (const value of ['a', 'b', 'c']) {
      sequences.push(await store.append('doc-seq', updateAppending(doc, value)));
    }
    assert.deepEqual(sequences, [1, 2, 3]);
    doc.destroy();
  });

  it('never hands the same sequence to concurrent callers', async () => {
    // D-052 point 2: two concurrent callers must not receive the same sequence. Starting
    // both before awaiting either is the closest a single-threaded runtime gets to the
    // interleaving an async adapter could produce.
    const doc = new Y.Doc();
    const first = updateAppending(doc, 'one');
    const second = updateAppending(doc, 'two');

    const sequences = await Promise.all([
      store.append('doc-concurrent', first),
      store.append('doc-concurrent', second),
    ]);

    assert.equal(new Set(sequences).size, 2, `sequences must be distinct, got ${sequences.join()}`);
    assert.deepEqual(
      [...sequences].sort((a, b) => a - b),
      [1, 2],
    );
    doc.destroy();
  });

  it('keeps the sequence increasing across a compaction boundary', async () => {
    // The regression this exists for: compaction *deletes* the log rows it folded in, so a
    // naive `MAX(seq) + 1` drops back to 0 and the next append reuses sequence 1 — below
    // `snapshot_seq`. That is two defects at once: the sequence stops being strictly
    // increasing (D-052 point 1), and `load` filters `seq > snapshot_seq`, so the new rows
    // are silently skipped and the edit is lost.
    const doc = new Y.Doc();
    await store.append('doc-monotonic', updateAppending(doc, 'before '));
    await store.append('doc-monotonic', updateAppending(doc, 'compaction'));
    await store.compact('doc-monotonic', Y.encodeStateAsUpdate(doc), 2);

    const nextSequence = await store.append('doc-monotonic', updateAppending(doc, ' after'));
    assert.ok(nextSequence > 2, `sequence must continue past snapshot_seq, got ${nextSequence}`);

    // ...and the row must actually be visible, not filtered out by the snapshot pointer.
    const stored = await store.load('doc-monotonic');
    assert.ok(stored !== null);
    if (stored === null) return;
    assert.deepEqual(
      stored.updates.map((row) => row.sequence),
      [nextSequence],
    );
    assert.equal(await persistedText('doc-monotonic'), 'before compaction after');
    doc.destroy();
  });

  it('reports a snapshot_seq that only ever names a committed sequence', async () => {
    const doc = new Y.Doc();
    const first = await store.append('doc-pointer', updateAppending(doc, 'x'));
    const second = await store.append('doc-pointer', updateAppending(doc, 'y'));

    await store.compact('doc-pointer', Y.encodeStateAsUpdate(doc), second);

    const stored = await store.load('doc-pointer');
    assert.ok(stored !== null);
    if (stored === null) return;
    // D-052 point 3: the pointer may not run ahead of what was committed. Compacting
    // "through" a sequence that was never appended would let a later append reuse it.
    assert.ok(
      stored.snapshotSequence <= second,
      `snapshotSequence ${stored.snapshotSequence} must not exceed the last commit ${second}`,
    );
    assert.equal(stored.snapshotSequence, second);
    assert.ok(first < second);
    doc.destroy();
  });
});

describe('DocumentStore — compaction', () => {
  it('replaces the snapshot and truncates exactly the consumed log', async () => {
    const doc = new Y.Doc();
    for (const value of ['one ', 'two ', 'three']) {
      await store.append('doc-compact', updateAppending(doc, value));
    }
    const through = 2;

    // The snapshot covers sequences 1..2; row 3 must survive, because a compaction only ever
    // folds in what the snapshot actually contains.
    const snapshotDoc = new Y.Doc();
    const storedBefore = await store.load('doc-compact');
    assert.ok(storedBefore !== null);
    if (storedBefore === null) return;
    for (const row of storedBefore.updates.filter((entry) => entry.sequence <= through)) {
      Y.applyUpdate(snapshotDoc, row.update, TRANSACTION_ORIGINS.persistence);
    }

    await store.compact('doc-compact', Y.encodeStateAsUpdate(snapshotDoc), through);

    const storedAfter = await store.load('doc-compact');
    assert.ok(storedAfter !== null);
    if (storedAfter === null) return;
    assert.equal(storedAfter.snapshotSequence, through);
    assert.deepEqual(
      storedAfter.updates.map((row) => row.sequence),
      [3],
      'only sequences above the snapshot may remain in the log',
    );
    snapshotDoc.destroy();
    doc.destroy();
  });

  it('leaves the document readable and identical after compaction', async () => {
    const doc = new Y.Doc();
    for (const value of ['alpha ', 'beta ', 'gamma']) {
      await store.append('doc-identical', updateAppending(doc, value));
    }
    const before = await persistedText('doc-identical');

    await store.compact('doc-identical', Y.encodeStateAsUpdate(doc), 3);

    assert.equal(await persistedText('doc-identical'), before);
    assert.equal(before, 'alpha beta gamma');
    doc.destroy();
  });
});

describe('DocumentStore — document isolation (scenario G at the store layer)', () => {
  it('keeps two documents’ state completely separate', async () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    await store.append('doc-a', updateAppending(docA, 'content of A'));
    await store.append('doc-b', updateAppending(docB, 'content of B'));

    assert.equal(await persistedText('doc-a'), 'content of A');
    assert.equal(await persistedText('doc-b'), 'content of B');

    // Compacting one must not touch the other: a shared sequence counter or a snapshot
    // written to the wrong row would show up here as a wrong or emptied document.
    await store.compact('doc-a', Y.encodeStateAsUpdate(docA), 1);
    assert.equal(await persistedText('doc-a'), 'content of A');
    assert.equal(await persistedText('doc-b'), 'content of B');

    await store.delete('doc-a');
    assert.equal(await store.load('doc-a'), null);
    assert.equal(await persistedText('doc-b'), 'content of B');
    docA.destroy();
    docB.destroy();
  });
});

describe('DocumentStore — BLOB fidelity', () => {
  it('round-trips bytes containing NUL and every byte value', async () => {
    // Yjs updates are binary and routinely contain NUL bytes. An encoding that treats them
    // as a string terminator would corrupt every document, so this is asserted on the
    // stored bytes rather than only through a rendered text.
    const payload = new Uint8Array(256);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index;

    await store.append('doc-blob', payload);
    const stored = await store.load('doc-blob');
    assert.ok(stored !== null);
    if (stored === null) return;
    assert.equal(stored.updates.length, 1);
    const roundTripped = stored.updates[0]?.update;
    assert.ok(roundTripped !== undefined);
    assert.deepEqual([...roundTripped], [...payload]);
  });
});

describe('DocumentStore — delete and close', () => {
  it('removes a document durably and is idempotent', async () => {
    const doc = new Y.Doc();
    await store.append('doc-delete', updateAppending(doc, 'to be removed'));

    await store.delete('doc-delete');
    assert.equal(await store.load('doc-delete'), null);

    // Idempotent: deleting an unknown document is a no-op, not an error (§14.1).
    await store.delete('doc-delete');
    await store.delete('never-existed');
    doc.destroy();
  });

  it('is safe to close twice and rejects operations afterwards', async () => {
    await store.close();
    await store.close();
    await assert.rejects(
      () => store.append('doc-after-close', new Uint8Array([1])),
      StoreClosedError,
      'a closed store must reject rather than silently accept a write',
    );
  });

  it('keeps data across a close and reopen of the same directory', async () => {
    const doc = new Y.Doc();
    await store.append('doc-reopen', updateAppending(doc, 'survives close'));
    await store.close();

    // A second store instance on the same file is the in-process stand-in for "another
    // process reads what this one wrote"; the real process restart is scenario B.
    const reopened = (await openDocumentStore(dataPath)).store;
    try {
      const stored = await reopened.load('doc-reopen');
      assert.ok(stored !== null, 'the document must still exist after reopening');
      const replayDoc = new Y.Doc();
      if (stored !== null) applyStoredDocument(stored, replayDoc);
      assert.equal(replayDoc.getText('content').toString(), 'survives close');
      replayDoc.destroy();
    } finally {
      await reopened.close();
    }
    // `afterEach` closes `store` again, which must stay safe after this explicit close.
    doc.destroy();
  });
});
