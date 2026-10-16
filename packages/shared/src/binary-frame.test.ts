import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

import {
  DOCUMENT_TEXT_KEY,
  FRAME_TYPES,
  MAX_BINARY_FRAME_BYTES,
  MIN_BINARY_FRAME_BYTES,
  SYNC_MESSAGE_TYPES,
  UNDO_TRACKED_ORIGINS,
  TRANSACTION_ORIGINS,
  decodeBinaryFrame,
  decodeSyncFrame,
  encodeAwarenessFrame,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeSyncUpdate,
  frameByteLength,
  isBinaryFrame,
  readSyncMessageType,
  readSyncStep1StateVector,
  readSyncStep2Payload,
  readSyncUpdatePayload,
  varUintByteLength,
} from './binary-frame.js';
import { WS_ERROR_CODES } from './errors.js';

/** A doc with content, so sync payloads are non-trivial. */
function makeDoc(text = 'hello world'): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(DOCUMENT_TEXT_KEY).insert(0, text);
  return doc;
}

/**
 * Build an awareness frame carrying exactly one remote entry.
 *
 * `clientId` is returned instead of rediscovered, because a destroyed `Awareness`
 * has already dropped its own meta entry: encoding after `destroy()` silently
 * produces an empty update, so the id must be captured while the instance is live.
 */
function makeAwarenessFrame(): { frame: Uint8Array; clientId: number } {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const clientId = awareness.clientID;
  awareness.setLocalStateField('user', { id: 'u1', name: 'Ada' });

  const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId], awareness.states);
  // Non-empty: the fixture would be meaningless otherwise.
  assert.ok(update.byteLength > 2, 'awareness fixture must carry a state entry');

  awareness.destroy();
  doc.destroy();
  return { frame: encodeAwarenessFrame(update), clientId };
}

describe('binary frame codec — valid frames', () => {
  it('is byte-faithful to y-protocols: frame payload equals writeSyncStep1 output', () => {
    // The codec MUST NOT reinterpret the payload. Asserting against lib0's own
    // encoder output is what proves that: strip the 1-byte frame header and the
    // remainder has to be exactly what y-protocols wrote.
    const doc = makeDoc();
    const reference = encoding.createEncoder();
    syncProtocol.writeSyncStep1(reference, doc);

    const frame = encodeSyncStep1(doc);
    assert.equal(frame[0], FRAME_TYPES.sync);
    assert.deepEqual(
      Array.from(frame.subarray(1)),
      Array.from(encoding.toUint8Array(reference)),
      'sync frame payload differs from the y-protocols encoding',
    );

    const decoded = decodeBinaryFrame(frame);
    assert.equal(decoded.success, true);
    if (!decoded.success) return;
    assert.equal(decoded.frame.kind, 'sync');
    doc.destroy();
  });

  it('drives a real sync cycle between two empty/loaded documents', () => {
    // A: has content. B: empty. B initiates SyncStep1, A answers with Step2
    // (its full state, since B's vector is empty), B applies it and converges.
    // This is the wiring the real client/server will use.
    const docA = makeDoc('hello world');
    const docB = new Y.Doc();

    const step1FromB = encodeSyncStep1(docB);
    const decodedStep1 = decodeBinaryFrame(step1FromB);
    assert.equal(decodedStep1.success, true);
    if (!decodedStep1.success || decodedStep1.frame.kind !== 'sync') {
      throw new Error('expected a sync frame');
    }

    // A reads B's state vector and produces the missing update as SyncStep2.
    const replyForB = encoding.createEncoder();
    const readType = syncProtocol.readSyncMessage(
      decoding.createDecoder(decodedStep1.frame.bytes),
      replyForB,
      docA,
      'server',
    );
    assert.equal(readType, syncProtocol.messageYjsSyncStep1);

    // B receives that frame through the codec and applies it.
    const step2Frame = encodeSyncStep2(docA, Y.encodeStateVector(docB));
    const decodedStep2 = decodeBinaryFrame(step2Frame);
    assert.equal(decodedStep2.success, true);
    if (!decodedStep2.success || decodedStep2.frame.kind !== 'sync') {
      throw new Error('expected a sync frame');
    }
    syncProtocol.readSyncMessage(
      decoding.createDecoder(decodedStep2.frame.bytes),
      encoding.createEncoder(),
      docB,
      'client',
    );

    assert.equal(docB.getText(DOCUMENT_TEXT_KEY).toString(), 'hello world');
    assert.equal(
      docB.getText(DOCUMENT_TEXT_KEY).toString(),
      docA.getText(DOCUMENT_TEXT_KEY).toString(),
    );

    docA.destroy();
    docB.destroy();
  });

  it('accepts a sync step2 frame', () => {
    const doc = makeDoc('synced content');
    const decoded = decodeBinaryFrame(encodeSyncStep2(doc));
    assert.equal(decoded.success, true);
    if (!decoded.success) return;
    assert.equal(decoded.frame.kind, 'sync');
    doc.destroy();
  });

  it('accepts a sync update frame and applies it to a peer', () => {
    const doc = makeDoc('base');
    const update = Y.encodeStateAsUpdate(doc);
    const decoded = decodeBinaryFrame(encodeSyncUpdate(update));
    assert.equal(decoded.success, true);
    if (!decoded.success) return;

    const peer = new Y.Doc();
    syncProtocol.readSyncMessage(
      decoding.createDecoder(decoded.frame.bytes),
      encoding.createEncoder(),
      peer,
      'test',
    );
    assert.equal(peer.getText(DOCUMENT_TEXT_KEY).toString(), 'base');

    doc.destroy();
    peer.destroy();
  });

  it('accepts an awareness frame and reports the client ids it mentions', () => {
    const { frame, clientId } = makeAwarenessFrame();
    assert.equal(frame[0], FRAME_TYPES.awareness);

    const decoded = decodeBinaryFrame(frame);
    assert.equal(decoded.success, true);
    if (!decoded.success || decoded.frame.kind !== 'awareness') {
      throw new Error('expected an awareness frame');
    }
    assert.deepEqual(decoded.frame.clients, [clientId]);

    // The payload must be directly applicable by y-protocols. Note that an
    // `Awareness` constructor already registers its own local client, so the map
    // holds that entry plus the one remote entry this frame carries.
    const observerDoc = new Y.Doc();
    const observer = new awarenessProtocol.Awareness(observerDoc);
    awarenessProtocol.applyAwarenessUpdate(observer, decoded.frame.bytes, 'test');

    const observerStates = observer.getStates();
    assert.equal(observerStates.has(clientId), true);
    assert.equal((observerStates.get(clientId) as { user?: { name?: string } }).user?.name, 'Ada');
    observer.destroy();
    observerDoc.destroy();
  });

  it('accepts a full-document sync snapshot with an empty state vector', () => {
    const doc = makeDoc('non-trivial content for the snapshot path');
    const decoded = decodeBinaryFrame(encodeSyncStep2(doc));
    assert.equal(decoded.success, true);
    doc.destroy();
  });

  it('reports frame size helpers consistently', () => {
    const frame = encodeSyncStep1(makeDoc());
    assert.equal(frameByteLength(frame), frame.byteLength);
    assert.equal(varUintByteLength(0), 1);
    assert.equal(varUintByteLength(FRAME_TYPES.sync), 1);
    assert.equal(varUintByteLength(300), 2);
    assert.ok(frame.byteLength > varUintByteLength(FRAME_TYPES.sync));
  });
});

describe('binary frame codec — malformed frames', () => {
  it('rejects an empty frame', () => {
    const decoded = decodeBinaryFrame(new Uint8Array(0));
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.INVALID_BINARY_FRAME);
  });

  it('rejects every truncation of a valid frame', () => {
    const frame = encodeSyncStep1(makeDoc());
    // Bytes 1..third-to-last are all truncated; the minimum-size rule and the
    // payload checks must both fire depending on where the cut lands.
    for (let length = 1; length < frame.byteLength; length += 1) {
      const decoded = decodeBinaryFrame(frame.subarray(0, length));
      assert.equal(decoded.success, false, `prefix of ${length} bytes was accepted`);
    }
  });

  it('rejects a frame shorter than the minimum size', () => {
    const decoded = decodeBinaryFrame(new Uint8Array([FRAME_TYPES.sync]));
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.INVALID_BINARY_FRAME);
    assert.equal(MIN_BINARY_FRAME_BYTES, 2);
  });

  it('rejects trailing bytes after a sync payload', () => {
    const frame = encodeSyncStep1(makeDoc());
    const padded = new Uint8Array(frame.byteLength + 2);
    padded.set(frame, 0);
    padded.set([0xde, 0xad], frame.byteLength);

    const decoded = decodeBinaryFrame(padded);
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.INVALID_BINARY_FRAME);
    assert.match(String(decoded.detail), /trailing/);
  });

  it('rejects trailing bytes after an awareness payload', () => {
    const { frame } = makeAwarenessFrame();
    const padded = new Uint8Array(frame.byteLength + 1);
    padded.set(frame, 0);
    padded[frame.byteLength] = 0x01;

    const decoded = decodeBinaryFrame(padded);
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.INVALID_BINARY_FRAME);
  });

  it('rejects a sync frame with an unknown inner message type', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, FRAME_TYPES.sync);
    encoding.writeVarUint(encoder, 99);
    encoding.writeVarUint8Array(encoder, new Uint8Array([1, 2, 3]));

    const decoded = decodeBinaryFrame(encoding.toUint8Array(encoder));
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.INVALID_BINARY_FRAME);
    assert.match(String(decoded.detail), /unknown sync message type/);
  });

  it('rejects a sync frame whose payload is not a length-prefixed byte array', () => {
    // Declares a 9-byte array but supplies only 2 bytes.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, FRAME_TYPES.sync);
    encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep1);
    encoding.writeVarUint(encoder, 9);
    encoding.writeUint8Array(encoder, new Uint8Array([1, 2]));

    const decoded = decodeBinaryFrame(encoding.toUint8Array(encoder));
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.INVALID_BINARY_FRAME);
  });

  it('rejects an awareness payload that is not a valid awareness update', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, FRAME_TYPES.awareness);
    // Claims one entry but stops before the clock/state fields.
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, 42);

    const decoded = decodeBinaryFrame(encoding.toUint8Array(encoder));
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.INVALID_BINARY_FRAME);
    assert.match(String(decoded.detail), /awareness/);
  });

  it('rejects a bare awareness update sent without the frame header', () => {
    // This is the classic mistake: encodeAwarenessUpdate has no message-type
    // prefix, so byte 0 is the client count, not a frame type. The codec must
    // reject it rather than mistake it for a SYNC frame.
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalStateField('user', { id: 'u1', name: 'Ada' });
    const bareUpdate = awarenessProtocol.encodeAwarenessUpdate(
      awareness,
      [awareness.clientID],
      awareness.states,
    );

    const decoded = decodeBinaryFrame(bareUpdate);
    assert.equal(decoded.success, false);

    awareness.destroy();
    doc.destroy();
  });
});

describe('binary frame codec — unknown frame types', () => {
  it('rejects the unknown frame type in the parsed header', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 99);
    encoding.writeVarUint8Array(encoder, new Uint8Array([0]));

    const decoded = decodeBinaryFrame(encoding.toUint8Array(encoder));
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.INVALID_BINARY_FRAME);
    assert.match(String(decoded.detail), /unsupported frame type 99/);
  });

  it('rejects the y-websocket auth and query-awareness frame types', () => {
    for (const frameType of [2, 3]) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, frameType);
      encoding.writeVarUint8Array(encoder, new Uint8Array([0]));

      const decoded = decodeBinaryFrame(encoding.toUint8Array(encoder));
      assert.equal(decoded.success, false, `frame type ${frameType} was accepted`);
    }
  });

  it('rejects a large varUint frame type instead of overflowing', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 100000);
    encoding.writeVarUint8Array(encoder, new Uint8Array([0]));

    const decoded = decodeBinaryFrame(encoding.toUint8Array(encoder));
    assert.equal(decoded.success, false);
  });
});

describe('binary frame codec — size limits', () => {
  it('rejects a frame larger than the default limit', () => {
    const decoded = decodeBinaryFrame(new Uint8Array(MAX_BINARY_FRAME_BYTES + 1));
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.FRAME_TOO_LARGE);
  });

  it('accepts a frame exactly at the default limit (size check is not off by one)', () => {
    // Padding at the tail makes this a trailing-bytes failure, which proves the
    // size gate passed and the payload gate is what rejected it.
    const decoded = decodeBinaryFrame(new Uint8Array(MAX_BINARY_FRAME_BYTES));
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.INVALID_BINARY_FRAME);
  });

  it('honours a caller-supplied smaller limit before doing any decode work', () => {
    const frame = encodeSyncStep1(makeDoc());
    const decoded = decodeBinaryFrame(frame, { maxFrameBytes: frame.byteLength - 1 });
    assert.equal(decoded.success, false);
    if (decoded.success) return;
    assert.equal(decoded.error, WS_ERROR_CODES.FRAME_TOO_LARGE);

    // The same frame passes with an exact-fit limit.
    assert.equal(decodeBinaryFrame(frame, { maxFrameBytes: frame.byteLength }).success, true);
  });
});

describe('binary frame codec — helpers', () => {
  it('identifies binary input', () => {
    assert.equal(isBinaryFrame(new Uint8Array([1])), true);
    assert.equal(isBinaryFrame('text frame'), false);
    assert.equal(isBinaryFrame(undefined), false);
  });

  it('tracks local and ai origins for undo but never remote', () => {
    assert.deepEqual(
      [...UNDO_TRACKED_ORIGINS],
      [TRANSACTION_ORIGINS.local, TRANSACTION_ORIGINS.ai],
    );
    expect(UNDO_TRACKED_ORIGINS).not.toContain(TRANSACTION_ORIGINS.remote);
    expect(UNDO_TRACKED_ORIGINS).not.toContain(TRANSACTION_ORIGINS.persistence);
  });
});

/**
 * The sync accessors exist so consumers (the server's room layer, tests, tooling) never
 * write their own varint reader. `apps/server` previously had one, which is exactly the
 * duplication these tests lock down (`AGENTS.md` R12).
 */
describe('sync accessors (M1-A0.2)', () => {
  it('keeps the message type constants equal to y-protocols', () => {
    assert.equal(SYNC_MESSAGE_TYPES.step1, syncProtocol.messageYjsSyncStep1);
    assert.equal(SYNC_MESSAGE_TYPES.step2, syncProtocol.messageYjsSyncStep2);
    assert.equal(SYNC_MESSAGE_TYPES.update, syncProtocol.messageYjsUpdate);
  });

  it('identifies the kind of each sync frame', () => {
    const doc = makeDoc();
    const step1 = decodeSyncFrame(encodeSyncStep1(doc));
    const step2 = decodeSyncFrame(encodeSyncStep2(doc));
    const update = decodeSyncFrame(encodeSyncUpdate(Y.encodeStateAsUpdate(doc)));
    assert.ok(step1 && step2 && update);

    assert.equal(readSyncMessageType(step1), SYNC_MESSAGE_TYPES.step1);
    assert.equal(readSyncMessageType(step2), SYNC_MESSAGE_TYPES.step2);
    assert.equal(readSyncMessageType(update), SYNC_MESSAGE_TYPES.update);
    doc.destroy();
  });

  it('extracts exactly the state vector y-protocols wrote', () => {
    const doc = makeDoc('some content for the vector');
    const frame = decodeSyncFrame(encodeSyncStep1(doc));
    assert.ok(frame);

    const vector = readSyncStep1StateVector(frame);
    assert.ok(vector !== null, 'a SyncStep1 frame must yield its state vector');
    // Byte-faithful, not merely parseable.
    assert.deepEqual([...(vector as Uint8Array)], [...Y.encodeStateVector(doc)]);
    assert.ok((vector as Uint8Array).byteLength > 0);
    doc.destroy();
  });

  it('extracts the raw update from an Update frame, and proves the frame is not the update', () => {
    const doc = makeDoc('payload');
    const update = Y.encodeStateAsUpdate(doc);
    const frame = decodeSyncFrame(encodeSyncUpdate(update));
    assert.ok(frame);

    const extracted = readSyncUpdatePayload(frame);
    assert.ok(extracted !== null, 'an Update frame must yield its update');
    assert.deepEqual([...(extracted as Uint8Array)], [...update]);

    // The frame body starts with the sync message type, so it is NOT an update. This is the
    // mistake the accessor exists to prevent: applying the body directly makes yjs read a
    // struct reference in the wrong format.
    assert.notDeepEqual([...frame.bytes], [...update]);

    // And the extracted bytes are what `applyUpdate` accepts, which the body is not.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, extracted as Uint8Array, 'test');
    assert.equal(peer.getText(DOCUMENT_TEXT_KEY).toString(), 'payload');
    peer.destroy();
    doc.destroy();
  });

  it('returns null when the accessor does not match the frame kind', () => {
    const doc = makeDoc('x');
    const step1 = decodeSyncFrame(encodeSyncStep1(doc));
    const step2 = decodeSyncFrame(encodeSyncStep2(doc));
    const update = decodeSyncFrame(encodeSyncUpdate(Y.encodeStateAsUpdate(doc)));
    assert.ok(step1 && step2 && update);

    assert.equal(readSyncStep1StateVector(step2), null);
    assert.equal(readSyncUpdatePayload(step1), null);
    assert.equal(readSyncStep2Payload(update), null);
    assert.ok(readSyncStep2Payload(step2) !== null);
    doc.destroy();
  });

  it('exposes the SyncStep2 payload, which is an update envelope and delete set', () => {
    const doc = makeDoc('step two payload');
    const frame = decodeSyncFrame(encodeSyncStep2(doc));
    assert.ok(frame);

    const payload = readSyncStep2Payload(frame);
    assert.ok(payload !== null);
    // Unlike an Update frame, a SyncStep2 body is an update envelope, so applying it
    // directly is valid — but it is still not a bare update of the same bytes.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, payload as Uint8Array, 'test');
    assert.equal(peer.getText(DOCUMENT_TEXT_KEY).toString(), 'step two payload');
    peer.destroy();
    doc.destroy();
  });

  it('returns null from decodeSyncFrame for a non-sync or invalid frame', () => {
    assert.equal(decodeSyncFrame(new Uint8Array(0)), null);
    assert.equal(decodeSyncFrame(encodeAwarenessFrame(new Uint8Array([1, 0]))), null);

    // A multi-byte frame type must be read as a varint rather than as `bytes[0]`, which is
    // what the removed hand-rolled helper did.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, FRAME_TYPES.awareness);
    encoding.writeVarUint8Array(encoder, new Uint8Array([0]));
    assert.equal(decodeSyncFrame(encoding.toUint8Array(encoder)), null);
  });
});
