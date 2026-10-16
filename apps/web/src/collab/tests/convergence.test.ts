import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { applyUpdate, decodeUpdate, encodeStateAsUpdate, encodeStateVector } from 'yjs';
import {
  DOCUMENT_TEXT_KEY,
  TRANSACTION_ORIGINS,
  decodeBinaryFrame,
  encodeSyncStep1,
  encodeSyncStep2,
} from '@insighthub/shared';

/**
 * Requirements 3, 4 and 5: duplicate idempotency, out-of-order convergence and
 * divergent-replica convergence.
 *
 * These are CRDT-level guarantees, so they are asserted directly on `Y.Doc` — the
 * same object the session exposes. The point of the assertions is that A1 does NOT
 * add a business layer on top: no dedup, no sequence numbers, no ordering
 * requirement (`docs/CONTRACTS.md` §10.3, explicit non-goal).
 */

/** Collect the updates a document emits for a set of edits. */
function captureUpdates(doc: Y.Doc, edit: (text: Y.Text) => void, origin = 'test'): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const listener = (update: Uint8Array): void => {
    updates.push(update.slice());
  };
  doc.on('update', listener);
  doc.transact(() => edit(doc.getText(DOCUMENT_TEXT_KEY)), origin);
  doc.off('update', listener);
  return updates;
}

function textOf(doc: Y.Doc): string {
  return doc.getText(DOCUMENT_TEXT_KEY).toString();
}

/**
 * Sort structs so two logically equal documents can be compared byte for byte.
 *
 * `encodeStateAsUpdate` writes structs in the order the store iterates them (client
 * id, then clock), so a straight byte comparison of two converged documents is
 * already stable — but sorting removes any doubt about iteration order from the
 * assertion.
 */
function structsOf(doc: Y.Doc): string[] {
  const structs = decodeUpdate(encodeStateAsUpdate(doc)).structs;
  return structs.map((struct) => `${struct.id.client}:${struct.id.clock}:${struct.length}`).sort();
}

describe('CRDT convergence (the guarantees A1 relies on)', () => {
  it('applies a duplicate update as a no-op', () => {
    const source = new Y.Doc();
    const [update] = captureUpdates(source, (text) => text.insert(0, 'duplicate me'));

    const target = new Y.Doc();
    applyUpdate(target, update!, TRANSACTION_ORIGINS.remote);
    const afterFirst = encodeStateAsUpdate(target);
    const structsAfterFirst = structsOf(target);

    // Same update delivered again, and a third time for good measure.
    applyUpdate(target, update!, TRANSACTION_ORIGINS.remote);
    applyUpdate(target, update!, TRANSACTION_ORIGINS.remote);

    expect(textOf(target)).toBe('duplicate me');
    expect(Array.from(encodeStateAsUpdate(target))).toEqual(Array.from(afterFirst));
    expect(structsOf(target)).toEqual(structsAfterFirst);
    source.destroy();
    target.destroy();
  });

  it('converges when updates arrive out of order', () => {
    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    const listener = (update: Uint8Array): void => {
      updates.push(update.slice());
    };
    source.on('update', listener);
    // Three edits, each causally dependent on the previous one.
    source.getText(DOCUMENT_TEXT_KEY).insert(0, 'a');
    source.getText(DOCUMENT_TEXT_KEY).insert(1, 'b');
    source.getText(DOCUMENT_TEXT_KEY).insert(2, 'c');
    source.off('update', listener);
    expect(updates).toHaveLength(3);

    const inOrder = new Y.Doc();
    const reversed = new Y.Doc();
    const shuffled = new Y.Doc();
    for (const update of updates) applyUpdate(inOrder, update, TRANSACTION_ORIGINS.remote);
    for (const update of [...updates].reverse()) {
      applyUpdate(reversed, update, TRANSACTION_ORIGINS.remote);
    }
    for (const update of [updates[2]!, updates[0]!, updates[1]!]) {
      applyUpdate(shuffled, update, TRANSACTION_ORIGINS.remote);
    }

    expect(textOf(inOrder)).toBe('abc');
    expect(textOf(reversed)).toBe('abc');
    expect(textOf(shuffled)).toBe('abc');
    expect(structsOf(reversed)).toEqual(structsOf(inOrder));
    expect(structsOf(shuffled)).toEqual(structsOf(inOrder));

    source.destroy();
    inOrder.destroy();
    reversed.destroy();
    shuffled.destroy();
  });

  it('converges two divergent replicas after exchanging updates', () => {
    const left = new Y.Doc();
    const right = new Y.Doc();

    left.getText(DOCUMENT_TEXT_KEY).insert(0, 'left');
    right.getText(DOCUMENT_TEXT_KEY).insert(0, 'right');

    // Exchange in both directions, the way a reconnect does.
    applyUpdate(right, encodeStateAsUpdate(left), TRANSACTION_ORIGINS.remote);
    applyUpdate(left, encodeStateAsUpdate(right), TRANSACTION_ORIGINS.remote);

    expect(textOf(left)).toBe(textOf(right));
    expect(structsOf(left)).toEqual(structsOf(right));
    // Byte-identical after convergence (acceptance criterion 3).
    expect(Array.from(encodeStateAsUpdate(left))).toEqual(Array.from(encodeStateAsUpdate(right)));
    left.destroy();
    right.destroy();
  });

  it('encodes a reconnect delta, not the document', () => {
    const server = new Y.Doc();
    const filler = 'x'.repeat(40_000);
    server.getText(DOCUMENT_TEXT_KEY).insert(0, filler);

    // A client that already has everything the server had before the last edit.
    const client = new Y.Doc();
    applyUpdate(client, encodeStateAsUpdate(server), TRANSACTION_ORIGINS.remote);
    server.getText(DOCUMENT_TEXT_KEY).insert(0, 'delta');

    const stateVector = encodeStateVector(client);
    const delta = encodeSyncStep2(server, stateVector);
    const fullSnapshot = encodeSyncStep2(server);

    expect(delta.byteLength).toBeLessThan(fullSnapshot.byteLength / 10);
    // The delta is still framed by the shared codec, header included.
    expect(encodeSyncStep1(client).byteLength).toBeGreaterThan(0);

    // Apply it exactly the way the provider does: through the shared codec, which
    // validates the frame and strips the frame-type header before `readSyncMessage`.
    const decoded = decodeBinaryFrame(delta);
    expect(decoded.success).toBe(true);
    if (!decoded.success || decoded.frame === undefined) throw new Error('delta did not decode');
    const decoder = decoding.createDecoder(decoded.frame.bytes);
    expect(decoding.readVarUint(decoder)).toBe(1); // y-protocols SyncStep2
    applyUpdate(client, decoding.readVarUint8Array(decoder), TRANSACTION_ORIGINS.remote);
    expect(textOf(client)).toBe(`delta${filler}`);
    server.destroy();
    client.destroy();
  });
});
