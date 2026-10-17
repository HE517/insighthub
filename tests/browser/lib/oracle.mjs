/**
 * An independent Yjs peer on the **real** server, used as a convergence witness.
 *
 * The browser tabs are the subjects under test; this is the third observer. It
 * speaks the frozen wire format (`packages/shared/src/binary-frame.ts`) and the
 * frozen control plane (`packages/shared/src/protocol.ts`) — the same code the
 * apps use, not a re-implementation — so "A, B and the server agree" is measured
 * against a participant that shares no code with the A1 client.
 *
 * It deliberately publishes **no awareness state**, so it never appears in
 * `getCollaborators()` and cannot perturb a presence assertion. It does join the
 * room, so it keeps the room alive while attached; tests that care about room
 * teardown close the oracle first.
 */
import {
  importDependency,
  loadAwarenessProtocol,
  loadShared,
  loadSyncProtocol,
  loadYjs,
} from './deps.mjs';

const JOIN_TIMEOUT_MS = 20_000;

/** The origin this oracle stamps its own edits with, so it never treats them as remote. */
const ORACLE_ORIGIN = 'insighthub:qa-oracle';

export class WireOracle {
  #shared;
  #encoding;
  #decoding;
  #syncProtocol;
  #doc;
  #text;
  #awarenessProtocol;
  #awareness;
  #presenceEnabled = false;
  #socket;
  #joined = false;
  #errors = [];
  #framesIn = 0;
  #framesOut = 0;
  #awarenessClientIds = new Set();
  #joinResolve;
  #joinReject;
  #joinSettled;

  constructor({
    url,
    documentId,
    label,
    shared,
    Y,
    syncProtocol,
    awarenessProtocol,
    encoding,
    decoding,
  }) {
    this.url = url;
    this.documentId = documentId;
    this.label = label;
    this.#shared = shared;
    this.#encoding = encoding;
    this.#decoding = decoding;
    this.#syncProtocol = syncProtocol;
    this.#awarenessProtocol = awarenessProtocol;
    this.#doc = new Y.Doc();
    this.#text = this.#doc.getText(shared.DOCUMENT_TEXT_KEY);
    this.#awareness = new awarenessProtocol.Awareness(this.#doc);

    this.#joinSettled = new Promise((resolve, reject) => {
      this.#joinResolve = resolve;
      this.#joinReject = reject;
    });
    // The reject path is observed through `waitForJoin`, so an unhandled rejection
    // here would only be noise.
    this.#joinSettled.catch(() => {});
  }

  /**
   * Connect, join the document room and complete the client-initiated sync
   * handshake. Resolves once the room is joined (not converged — call
   * `waitForText` for that).
   */
  static async connect({ url, documentId, label = 'oracle' }) {
    const [shared, Y, syncProtocol, awarenessProtocol, encoding, decoding] = await Promise.all([
      loadShared(),
      loadYjs(),
      loadSyncProtocol(),
      loadAwarenessProtocol(),
      importDependency('lib0/encoding'),
      importDependency('lib0/decoding'),
    ]);

    const oracle = new WireOracle({
      url,
      documentId,
      label,
      shared,
      Y,
      syncProtocol,
      awarenessProtocol,
      encoding,
      decoding,
    });
    oracle.#open();
    await oracle.waitForJoin();
    return oracle;
  }

  /** This peer's awareness client id (only meaningful after `enablePresence`). */
  get awarenessClientId() {
    return this.#awareness.clientID;
  }

  get documentLength() {
    return this.#text.length;
  }

  /** The oracle's view of the document — after sync, the server's state. */
  get text() {
    return this.#text.toString();
  }

  get joined() {
    return this.#joined;
  }

  get errors() {
    return [...this.#errors];
  }

  get statistics() {
    return {
      framesIn: this.#framesIn,
      framesOut: this.#framesOut,
      awarenessClientIds: [...this.#awarenessClientIds].sort((a, b) => a - b),
    };
  }

  /* ---------------------------------------------------------------- *
   * Wire
   * ---------------------------------------------------------------- */

  #sendBinary(frame) {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== 1) return false;
    try {
      socket.send(frame);
      this.#framesOut += 1;
      return true;
    } catch {
      return false;
    }
  }

  #open() {
    const shared = this.#shared;
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    const timer = setTimeout(() => {
      this.#settleJoin(
        new Error(`${this.label} did not join room ${this.documentId} within ${JOIN_TIMEOUT_MS}ms`),
      );
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }, JOIN_TIMEOUT_MS);

    // Relay this oracle's own edits as ordinary incremental updates, exactly as the
    // real client does, and never echo what arrived from the wire.
    this.#doc.on('update', (update, origin) => {
      if (origin === shared.TRANSACTION_ORIGINS.remote) return;
      if (!this.#joined) return;
      this.#sendBinary(shared.encodeSyncUpdate(update));
    });

    socket.addEventListener('open', () => {
      // The control plane is TEXT carrying a JSON envelope: `send` must receive a
      // string, not the envelope object.
      socket.send(
        JSON.stringify(
          shared.createEnvelope(shared.WS_MESSAGE_TYPES.joinRoom, {
            documentId: this.documentId,
            protocolVersion: shared.PROTOCOL_VERSION,
            mode: 'readwrite',
          }),
        ),
      );
    });

    socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        this.#handleControl(data, timer);
        return;
      }
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.#handleBinary(bytes);
    });

    socket.addEventListener('error', () => {
      this.#errors.push('socket error');
    });

    socket.addEventListener('close', () => {
      const wasJoined = this.#joined;
      this.#joined = false;
      clearTimeout(timer);
      if (!wasJoined) {
        this.#settleJoin(
          new Error(
            `${this.label} socket closed before joining ${this.documentId}` +
              (this.#errors.length > 0 ? ` (${this.#errors.join('; ')})` : ''),
          ),
        );
      }
    });
  }

  #handleControl(raw, timer) {
    const shared = this.#shared;
    let decoded;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.#errors.push('server sent a non-JSON text frame');
      return;
    }
    const parsed = shared.parseServerMessage(decoded);
    if (!parsed.success) {
      this.#errors.push(`invalid server message: ${parsed.error ?? 'unknown'}`);
      return;
    }
    const message = parsed.data;
    if (message.type === shared.WS_MESSAGE_TYPES.roomJoined) {
      this.#joined = true;
      clearTimeout(timer);
      // Frozen client-initiated handshake (docs/CONTRACTS.md §10.2).
      this.#sendBinary(shared.encodeSyncStep1(this.#doc));
      this.#settleJoin(null);
      return;
    }
    if (message.type === shared.WS_MESSAGE_TYPES.error) {
      this.#errors.push(`${message.payload.code}: ${message.payload.message}`);
    }
  }

  #handleBinary(bytes) {
    const shared = this.#shared;
    this.#framesIn += 1;
    const decoded = shared.decodeBinaryFrame(bytes);
    if (!decoded.success || decoded.frame === undefined) {
      this.#errors.push(`undecodable frame: ${decoded.error ?? 'unknown'}`);
      return;
    }
    if (decoded.frame.kind === 'awareness') {
      // Record who announced (evidence for ghost-collaborator assertions) and apply
      // the update to this peer's own awareness, so the oracle can also be a witness
      // of presence rather than only of text.
      for (const clientId of decoded.frame.clients) this.#awarenessClientIds.add(clientId);
      try {
        this.#awarenessProtocol.applyAwarenessUpdate(
          this.#awareness,
          decoded.frame.bytes,
          this.#shared.TRANSACTION_ORIGINS.remote,
        );
      } catch (error) {
        this.#errors.push(`applyAwarenessUpdate failed: ${String(error)}`);
      }
      return;
    }

    const decoder = this.#decoding.createDecoder(decoded.frame.bytes);
    const encoder = this.#encoding.createEncoder();
    try {
      this.#syncProtocol.readSyncMessage(
        decoder,
        encoder,
        this.#doc,
        shared.TRANSACTION_ORIGINS.remote,
      );
    } catch (error) {
      this.#errors.push(`readSyncMessage failed: ${String(error)}`);
      return;
    }
    if (this.#encoding.length(encoder) === 0) return;
    const reply = this.#encoding.toUint8Array(encoder);
    this.#sendBinary(
      shared.encodeSyncFrame((target) => {
        this.#encoding.writeUint8Array(target, reply);
      }),
    );
  }

  #settleJoin(error) {
    if (this.#joinResolve === undefined) return;
    const resolve = this.#joinResolve;
    const reject = this.#joinReject;
    this.#joinResolve = undefined;
    this.#joinReject = undefined;
    if (error === null) resolve(this);
    else reject(error);
  }

  waitForJoin() {
    return this.#joinSettled;
  }

  /* ---------------------------------------------------------------- *
   * Document access
   * ---------------------------------------------------------------- */

  /** Make a real edit through the real wire, so the server relays it to peers. */
  append(str) {
    this.#doc.transact(() => {
      this.#text.insert(this.#text.length, str);
    }, ORACLE_ORIGIN);
    return this.text;
  }

  /** Insert at an absolute offset (used for concurrent-edit scenarios). */
  insertAt(index, str) {
    this.#doc.transact(() => {
      this.#text.insert(index, str);
    }, ORACLE_ORIGIN);
    return this.text;
  }

  /** Delete a range (used for "delete on one side, insert on the other"). */
  deleteAt(index, length) {
    this.#doc.transact(() => {
      this.#text.delete(index, length);
    }, ORACLE_ORIGIN);
    return this.text;
  }

  /** Replace the whole document (used to build a 5 000-line body). */
  replaceAll(str) {
    this.#doc.transact(() => {
      this.#text.delete(0, this.#text.length);
      this.#text.insert(0, str);
    }, ORACLE_ORIGIN);
    return this.text;
  }

  /* ---------------------------------------------------------------- *
   * Presence (real y-protocols awareness, over the real server)
   * ---------------------------------------------------------------- */

  /**
   * Start publishing presence for this peer.
   *
   * Uses the real `y-protocols` awareness encoder, so the frame the browser
   * receives is byte-for-byte what a second A1 client would send.
   */
  enablePresence(user, { cursor = null, selection = null } = {}) {
    if (this.#presenceEnabled) return this.#awareness.clientID;
    this.#presenceEnabled = true;
    this.#awareness.on('update', ({ added, updated, removed }, origin) => {
      // Echo suppression: never relay back what arrived from the wire.
      if (origin === this.#shared.TRANSACTION_ORIGINS.remote) return;
      const clients = [...added, ...updated, ...removed];
      if (clients.length === 0) return;
      const update = this.#awarenessProtocol.encodeAwarenessUpdate(this.#awareness, clients);
      this.#sendBinary(this.#shared.encodeAwarenessFrame(update));
    });
    this.#awareness.setLocalState({ user, cursor, selection, updatedAt: Date.now() });
    return this.#awareness.clientID;
  }

  /** Move this peer's cursor (one real awareness update). */
  setCursor(cursor) {
    if (!this.#presenceEnabled) return;
    this.#awareness.setLocalStateField('cursor', cursor);
    this.#awareness.setLocalStateField('updatedAt', Date.now());
  }

  /** Set this peer's selection range (`null` when collapsed). */
  setSelection(selection) {
    if (!this.#presenceEnabled) return;
    this.#awareness.setLocalStateField('selection', selection);
    this.#awareness.setLocalStateField('updatedAt', Date.now());
  }

  /**
   * Publish a deliberately malformed awareness state.
   *
   * The payload is still structurally valid to the wire codec (a JSON state blob),
   * so the server relays it — which is the point: the *client* must reject it, and
   * must not render a collaborator or a cursor for it.
   */
  publishMalformedPresence(state) {
    if (!this.#presenceEnabled) return false;
    this.#awareness.setLocalState(state);
    return true;
  }

  /** This peer's own view of everyone's awareness entries. */
  presenceStates() {
    return new Map(this.#awareness.getStates());
  }

  /** Remove this peer's entry and broadcast the departure, like `destroy()`. */
  withdrawPresence() {
    if (!this.#presenceEnabled) return;
    this.#presenceEnabled = false;
    this.#awareness.setLocalState(null);
  }

  async waitForText(expected, { timeoutMs = 20_000, label } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.text === expected) return true;
      if (Date.now() >= deadline) {
        throw new Error(
          `${label ?? this.label} did not converge within ${timeoutMs}ms: ` +
            `expected ${expected.length} chars, observed ${this.#text.length} — ` +
            describeDivergence(expected, this.text),
        );
      }
      await delay(50);
    }
  }

  async waitFor(predicate, { timeoutMs = 20_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate(this)) return true;
      if (Date.now() >= deadline) throw new Error(`${this.label} timed out waiting for ${label}`);
      await delay(50);
    }
  }

  close() {
    try {
      if (this.#presenceEnabled) this.withdrawPresence();
      this.#socket?.close();
    } catch {
      /* already closed */
    }
    this.#joined = false;
    // Releases the y-protocols 3 s liveness interval, so the harness process exits.
    try {
      this.#awareness.destroy();
    } catch {
      /* already destroyed */
    }
  }
}

/**
 * Compare two strings and describe the first difference, so a failed convergence
 * assertion says *what* diverged instead of just "not equal".
 */
export function describeDivergence(left, right) {
  if (left === right) return 'identical';
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  const window = 40;
  return (
    `diverges at index ${index} (left ${left.length} chars, right ${right.length} chars): ` +
    `left ${JSON.stringify(left.slice(Math.max(0, index - window), index + window))} | ` +
    `right ${JSON.stringify(right.slice(Math.max(0, index - window), index + window))}`
  );
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
