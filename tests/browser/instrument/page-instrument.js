/**
 * Page-side instrumentation and chaos control for the A6 browser suite.
 *
 * This file is injected with `Page.addScriptToEvaluateOnNewDocument`, i.e. it runs
 * in the page *before* any application script. That is deliberate: it means the
 * harness needs **no production instrumentation hooks** and no changes to any file
 * owned by A1, A2 or A3 (`AGENTS.md` R2). Everything the suite observes, and every
 * fault it injects, goes through this wrapper.
 *
 * What it provides on `window.__qa`:
 *
 * | Area | Facility |
 * | --- | --- |
 * | Transport | every `WebSocket` is recorded; frames can be recorded, held, released, duplicated or dropped per document |
 * | Offline | `setOffline(true)` rewrites new sockets to an unreachable port and drops the live one, so the client's *real* reconnect path runs against a *real* connection refusal |
 * | Editor | `.cm-editor` mount/unmount counting via `MutationObserver` — a mount counter, not a guess (see `README.md`) |
 * | Lifecycle | live `setInterval` handles (by delay), so a leaked `y-protocols` awareness interval is visible |
 * | Storage | `indexedDB.open` calls and database names |
 *
 * It is written as a plain script (not a module) because it is injected as source
 * text. It never throws into application code: every wrapper is defensively
 * guarded.
 */
(() => {
  if (window.__qa !== undefined) return;

  const qa = {
    startedAt: Date.now(),
    sockets: [],
    frames: [],
    idbOpens: [],
    editor: { mounts: 0, unmounts: 0, live: 0 },
    intervals: { created: 0, cleared: 0, live: new Map() },
    errors: [],
    notes: [],
    /** Opt-in: retain binary frame payloads so a frame can be replayed verbatim. */
    captureBinary: false,
    /** Inbound frames dropped because the application handler had been detached. */
    droppedAfterDetach: 0,
  };

  /* ------------------------------------------------------------------ *
   * Demo identity pin + bootstrap accounting (M2 Phase 2)
   * ------------------------------------------------------------------ */

  /**
   * Which demo identity this page claims, when the harness pins one.
   *
   * `null` means "whatever the application asks for" (`demo-ada`, the app's default). A value
   * rewrites **only** the `demoUserId` field of the `POST /api/session/bootstrap` body. That is
   * the one place `docs/CONTRACTS.md` §17.0 lets a client claim an identity, and the session
   * itself is still issued by the real server in a real `HttpOnly` cookie — so a scenario that
   * needs a viewer page gets a genuine viewer session, not a simulated one. Rewriting the
   * *claim* is the only thing the harness does; nothing about the resulting session is faked.
   */
  qa.demoIdentity = typeof window.__qaIdentity === 'string' ? window.__qaIdentity : null;

  /**
   * Every bootstrap the page performed, with the identity it claimed.
   *
   * This is how the restart scenarios can assert the client did (**not**) re-bootstrap after a
   * server restart, instead of inferring it from a connection badge.
   */
  qa.bootstrapCalls = [];

  const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  if (nativeFetch !== null) {
    window.fetch = function qaFetch(input, init) {
      const target = typeof input === 'string' ? input : (input && input.url) || '';
      if (typeof target === 'string' && target.endsWith('/api/session/bootstrap')) {
        qa.bootstrapCalls.push({ t: Date.now() - qa.startedAt, claimed: qa.demoIdentity });
        if (qa.demoIdentity !== null && init !== null && typeof init === 'object') {
          if (typeof init.body === 'string') {
            try {
              const body = JSON.parse(init.body);
              body.demoUserId = qa.demoIdentity;
              init = { ...init, body: JSON.stringify(body) };
            } catch {
              /* an unexpected body shape is the application's business, not ours */
            }
          }
        }
      }
      return nativeFetch(input, init);
    };
  }

  /* ------------------------------------------------------------------ *
   * Policy state
   * ------------------------------------------------------------------ */

  // Global: every new socket is rewritten to an unreachable endpoint and the live
  // one is dropped. Scoped per page, so one tab can be "offline" while another is
  // not — which is what docs/ARCHITECTURE.md §7 of the task brief needs.
  let offline = false;
  // `documentId -> policy`. Populated lazily; unknown documents pass through.
  const policies = new Map();
  // Held inbound frames, keyed by documentId, so the switch-race scenario can
  // release an old document's traffic *after* the switch.
  const held = new Map();

  const POLICY_DEFAULTS = {
    /** Buffer inbound frames instead of delivering them. */
    holdIncoming: false,
    /** Duplicate every inbound binary frame N extra times. */
    duplicateIncoming: 0,
    /** Delay every inbound frame by N ms. */
    delayIncomingMs: 0,
    /** Drop inbound frames entirely. */
    dropIncoming: false,
    /** Defer the native close() by N ms (to widen the switch race window). */
    delayCloseMs: 0,
  };

  function policyFor(documentId) {
    let policy = policies.get(documentId);
    if (policy === undefined) {
      policy = { ...POLICY_DEFAULTS };
      policies.set(documentId, policy);
    }
    return policy;
  }

  function currentPolicy(record) {
    if (record.documentId === null) return { ...POLICY_DEFAULTS };
    return policyFor(record.documentId);
  }

  /* ------------------------------------------------------------------ *
   * Frame recording
   * ------------------------------------------------------------------ */

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
  }

  function toBase64(bytes) {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  function fromBase64(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function recordFrame(record, direction, kind, detail, bytes) {
    const entry = {
      documentId: record.documentId,
      socket: record.index,
      direction,
      kind,
      t: Date.now() - qa.startedAt,
      ...detail,
    };
    // Base64 of a binary frame is only retained on demand: the duplicate /
    // out-of-order scenario replays the *exact* bytes the server sent, and keeping
    // every frame's payload alive for a 5 000-line document would be wasteful.
    if (qa.captureBinary && direction === 'in' && kind === 'binary' && bytes !== null) {
      entry.base64 = toBase64(bytes);
    }
    qa.frames.push(entry);
    if (qa.frames.length > 20_000) qa.frames.splice(0, 5_000);
    return entry;
  }

  function describeControlFrame(text) {
    try {
      const parsed = JSON.parse(text);
      const type = parsed?.type ?? 'unknown';
      const payload = parsed?.payload ?? {};
      const detail = { messageType: type };
      // `error.code` and `room-joined.role` are the two control-plane facts the M2 Phase 2
      // scenarios assert from the **browser** (a denial is only real if the real client
      // received it; the role is only meaningful if the real client was told it). Recording
      // them here keeps the assertion on the page's own traffic instead of on a proxy socket.
      if (type === 'error' && typeof payload.code === 'string') detail.code = payload.code;
      if (type === 'room-joined') {
        detail.role = payload.role ?? null;
        detail.roomJoinedDocumentId = payload.documentId ?? null;
      }
      if (type === 'join-room') {
        detail.mode = payload.mode ?? null;
        detail.joinDocumentId = payload.documentId ?? null;
      }
      // Only recorded when the client actually claimed an identity on the wire — which is the
      // thing P2-2 needs to show it did (and that the server ignored).
      if (typeof payload.userId === 'string') detail.claimedUserId = payload.userId;
      return detail;
    } catch {
      return { messageType: 'unparseable' };
    }
  }

  function describeBinaryFrame(bytes) {
    // Frame type is a lib0 varUint; for 0/1 it is a single byte. Only used for
    // diagnostics, so an approximate read is enough and is labelled as such.
    const frameType = bytes.length > 0 && bytes[0] < 128 ? bytes[0] : 'varint';
    return { frameType, byteLength: bytes.length };
  }

  /* ------------------------------------------------------------------ *
   * WebSocket wrapper
   * ------------------------------------------------------------------ */

  const NativeWebSocket = window.WebSocket;
  const UNREACHABLE_URL = 'ws://127.0.0.1:9/ws';

  /**
   * Whether a URL is the **collaboration** endpoint.
   *
   * This matters: the page also holds Vite's HMR socket (`ws://host/?token=…`). If
   * the offline simulation closed *that* socket, Vite's client would reload the
   * page — which resets this instrumentation, silently un-does the offline state and
   * makes a browser test pass or fail for reasons that have nothing to do with the
   * application. Only `/ws` (the document room) is a collaboration socket.
   */
  function isCollaborationUrl(url) {
    try {
      return new URL(String(url)).pathname === '/ws';
    } catch {
      return String(url).includes('/ws');
    }
  }

  function makeRecord(url) {
    return {
      index: qa.sockets.length,
      url,
      documentId: null,
      openedAt: Date.now(),
      closedAt: null,
      /**
       * The WebSocket close code the server chose.
       *
       * Recorded because the persistence-failure contract is specified in terms of it:
       * an internal storage failure must close with **1011** ("internal error"), not
       * 1008 ("policy violation") — `docs/DECISIONS.md` D-054 item 4. Without this the
       * only observable would be "the socket closed", which cannot distinguish the two.
       */
      closeCode: null,
      closeReason: null,
      framesIn: 0,
      framesOut: 0,
      handlers: { open: null, message: null, error: null, close: null },
      native: null,
      pendingDeliveries: 0,
    };
  }

  class QAWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      const collaboration = isCollaborationUrl(url);
      // Only a collaboration socket is rewritten while "offline". The HMR socket
      // must keep working, or the dev server reloads the page.
      const effectiveUrl = offline && collaboration ? UNREACHABLE_URL : url;
      super(effectiveUrl, protocols);
      const record = makeRecord(url);
      record.isCollaboration = collaboration;
      record.native = this;
      qa.sockets.push(record);
      this.__qaRecord = record;

      // Own accessors shadow the prototype ones, so application handlers are
      // delivered *through* the policy layer rather than by the native stack.
      Object.defineProperty(this, 'onopen', {
        configurable: true,
        get: () => record.handlers.open,
        set: (handler) => {
          record.handlers.open = handler;
        },
      });
      Object.defineProperty(this, 'onmessage', {
        configurable: true,
        get: () => record.handlers.message,
        set: (handler) => {
          record.handlers.message = handler;
        },
      });
      Object.defineProperty(this, 'onerror', {
        configurable: true,
        get: () => record.handlers.error,
        set: (handler) => {
          record.handlers.error = handler;
        },
      });
      Object.defineProperty(this, 'onclose', {
        configurable: true,
        get: () => record.handlers.close,
        set: (handler) => {
          record.handlers.close = handler;
        },
      });

      this.addEventListener('open', (event) => {
        if (record.handlers.open !== null) record.handlers.open.call(this, event);
      });
      this.addEventListener('message', (event) => {
        qa.__deliver(record, event.data);
      });
      this.addEventListener('error', (event) => {
        if (record.handlers.error !== null) record.handlers.error.call(this, event);
      });
      this.addEventListener('close', (event) => {
        record.closedAt = Date.now();
        record.closeCode = typeof event?.code === 'number' ? event.code : null;
        record.closeReason = typeof event?.reason === 'string' ? event.reason : null;
        if (record.handlers.close !== null) record.handlers.close.call(this, event);
      });
    }

    send(data) {
      const record = this.__qaRecord;
      if (record !== undefined) {
        if (typeof data === 'string') {
          const detail = describeControlFrame(data);
          recordFrame(record, 'out', 'text', detail);
          // Tag the socket with the document it joined, so per-document policies
          // and evidence can be attributed. This is the only place the harness
          // reads protocol content, and it reads it as opaque JSON.
          if (detail.messageType === 'join-room') {
            try {
              record.documentId = JSON.parse(data).payload.documentId;
            } catch {
              /* ignored */
            }
          }
        } else {
          const bytes = toBytes(data);
          recordFrame(record, 'out', 'binary', bytes === null ? {} : describeBinaryFrame(bytes));
        }
        record.framesOut += 1;
      }
      return super.send(data);
    }

    close(code, reason) {
      const record = this.__qaRecord;
      const policy = record === undefined ? POLICY_DEFAULTS : currentPolicy(record);
      if (record !== undefined && policy.delayCloseMs > 0) {
        setTimeout(() => {
          try {
            super.close(code, reason);
          } catch {
            /* already closed */
          }
        }, policy.delayCloseMs);
        return undefined;
      }
      return super.close(code, reason);
    }
  }

  QAWebSocket.CONNECTING = 0;
  QAWebSocket.OPEN = 1;
  QAWebSocket.CLOSING = 2;
  QAWebSocket.CLOSED = 3;

  /**
   * Deliver one inbound payload through the per-document policy.
   *
   * Deliberately a method on `qa` rather than logic inside the listener, so the
   * suite can also replay/duplicate a frame it captured earlier.
   */
  qa.__deliver = function deliver(record, data) {
    const policy = currentPolicy(record);
    const bytes = toBytes(data);
    const kind = bytes === null ? 'text' : 'binary';
    const detail = bytes === null ? describeControlFrame(data) : describeBinaryFrame(bytes);
    recordFrame(record, 'in', kind, detail, bytes);
    record.framesIn += 1;

    if (policy.dropIncoming) return;
    if (policy.holdIncoming) {
      const key = record.documentId ?? `socket:${record.index}`;
      let queue = held.get(key);
      if (queue === undefined) {
        queue = [];
        held.set(key, queue);
      }
      queue.push({ record, data });
      return;
    }
    if (policy.delayIncomingMs > 0) {
      setTimeout(() => qa.__dispatch(record, data), policy.delayIncomingMs);
      return;
    }
    qa.__dispatch(record, data);
    for (let copy = 0; copy < policy.duplicateIncoming; copy += 1) {
      qa.__dispatch(record, data);
    }
  };

  /** Hand a payload to the application handler, if one is still attached. */
  qa.__dispatch = function dispatch(record, data) {
    // Handler detached (session torn down): the frame is dropped, and the drop is
    // counted so a test can prove the teardown — and not an empty queue — is what
    // kept the old document's traffic out of the new one.
    if (record.handlers.message === null) {
      qa.droppedAfterDetach = (qa.droppedAfterDetach ?? 0) + 1;
      return false;
    }
    record.pendingDeliveries += 1;
    try {
      record.handlers.message.call(record.native, { data });
    } catch (error) {
      qa.errors.push(String(error));
    } finally {
      record.pendingDeliveries -= 1;
    }
    return true;
  };

  qa.help = function help() {
    return 'see tests/browser/README.md';
  };

  /* ------------------------------------------------------------------ *
   * Public control surface
   * ------------------------------------------------------------------ */

  Object.defineProperty(qa, 'offline', {
    get: () => offline,
    set: (value) => qa.setOffline(value),
  });

  qa.setOffline = function setOffline(value) {
    offline = Boolean(value);
    if (!offline) return;
    // Drop the live collaboration sockets the way a lost network would. Vite's HMR
    // socket is deliberately left alone: closing it makes the dev server reload the
    // page, which would reset this instrumentation and un-do the offline state.
    for (const record of qa.sockets) {
      if (record.isCollaboration !== true) continue;
      const socket = record.native;
      if (socket === undefined || record.closedAt !== null) continue;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
    }
  };

  qa.policy = function policy(documentId, patch) {
    const next = { ...policyFor(documentId), ...patch };
    policies.set(documentId, next);
    return { ...next };
  };

  qa.heldCount = function heldCount(documentId) {
    return (held.get(documentId) ?? []).length;
  };

  qa.heldKeys = function heldKeys() {
    return [...held.keys()];
  };

  /**
   * Release held frames for a document.
   *
   * Returns how many were handed to an application handler and how many were
   * dropped because the handler had been detached.
   */
  qa.releaseHeld = function releaseHeld(documentId, { reverse = false } = {}) {
    const queue = held.get(documentId) ?? [];
    held.set(documentId, []);
    if (reverse) queue.reverse();
    let delivered = 0;
    let dropped = 0;
    for (const entry of queue) {
      if (qa.__dispatch(entry.record, entry.data)) delivered += 1;
      else dropped += 1;
    }
    return { released: queue.length, delivered, dropped };
  };

  /** The most recent captured inbound binary frame for a document, as base64. */
  qa.lastInboundBinary = function lastInboundBinary(documentId) {
    for (let index = qa.frames.length - 1; index >= 0; index -= 1) {
      const frame = qa.frames[index];
      if (
        frame.documentId === documentId &&
        frame.direction === 'in' &&
        frame.kind === 'binary' &&
        typeof frame.base64 === 'string'
      ) {
        return { base64: frame.base64, byteLength: frame.byteLength, frameType: frame.frameType };
      }
    }
    return null;
  };

  /** Count captured inbound binary frames for a document (evidence, not a guess). */
  qa.countInboundBinary = function countInboundBinary(documentId) {
    return qa.frames.filter(
      (frame) =>
        frame.documentId === documentId && frame.direction === 'in' && frame.kind === 'binary',
    ).length;
  };

  /** Inject a raw inbound frame (base64) into the newest socket for a document. */
  qa.injectInbound = function injectInbound(documentId, base64, { times = 1 } = {}) {
    const sockets = qa.sockets.filter((socket) => socket.documentId === documentId);
    const target = sockets[sockets.length - 1];
    if (target === undefined) return { ok: false, reason: 'no socket for that document' };
    const bytes = fromBase64(base64);
    for (let copy = 0; copy < times; copy += 1) {
      qa.__dispatch(target, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    return { ok: true, times };
  };

  qa.injectRawText = function injectRawText(documentId, text) {
    const sockets = qa.sockets.filter((socket) => socket.documentId === documentId);
    const target = sockets[sockets.length - 1];
    if (target === undefined) return { ok: false, reason: 'no socket for that document' };
    qa.__dispatch(target, text);
    return { ok: true };
  };

  /**
   * Send a raw TEXT control frame on the newest socket for a document.
   *
   * The M2 Phase 2 identity scenarios need to send a `join-room` whose payload carries a
   * `userId` the client would never send. Doing it through the page's **own** socket means the
   * frame really is produced by the browser connection the application is using, not by a
   * proxy socket — which is what makes "the payload is ignored" a browser observation.
   */
  qa.sendControl = function sendControl(documentId, text) {
    const sockets = qa.sockets.filter((socket) => socket.documentId === documentId);
    const target = sockets[sockets.length - 1];
    if (target === undefined) return { ok: false, reason: 'no socket for that document' };
    try {
      target.native.send(text);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  };

  /**
   * Send one **BINARY** frame (base64) on the newest socket for a document.
   *
   * This is the harness's "bypass the UI" instrument for the M2 Phase 2 F1 evidence
   * (`docs/DECISIONS.md` D-065 §4 point 4). The bytes are built outside the page with the frozen
   * codec, but they travel over the browser's **own authenticated socket**, so the server's
   * answer (`FORBIDDEN`) is received by the real client and recorded in `inboundControl`.
   *
   * Deliberately routed through the wrapper's own `send`, so the frame appears in `qa.frames` as
   * an outbound binary frame: a scenario can then prove that a write really did go out on the
   * wire, instead of asserting against a socket it never observed.
   */
  qa.sendBinary = function sendBinary(documentId, base64) {
    const sockets = qa.sockets.filter((socket) => socket.documentId === documentId);
    const target = sockets[sockets.length - 1];
    if (target === undefined) return { ok: false, reason: 'no socket for that document' };
    try {
      const bytes = fromBase64(base64);
      target.native.send(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      return { ok: true, byteLength: bytes.byteLength };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  };

  /**
   * TEXT control frames recorded for a document, optionally one direction.
   *
   * NOTE the one wrinkle: a socket learns `record.documentId` **from** its `join-room`, so the
   * first outbound join frame is recorded before the socket knows its document. That frame still
   * carries `joinDocumentId` (read out of the payload), which is why the filter accepts either.
   */
  qa.controlFrames = function controlFrames(documentId, direction) {
    return qa.frames
      .filter(
        (frame) =>
          frame.kind === 'text' &&
          (direction === undefined || frame.direction === direction) &&
          (documentId === undefined ||
            frame.documentId === documentId ||
            frame.joinDocumentId === documentId),
      )
      .map((frame) => ({ ...frame }));
  };

  /** Inbound TEXT frames (control plane) for a document, newest last. */
  qa.inboundControl = function inboundControl(documentId) {
    return qa.controlFrames(documentId, 'in');
  };

  /** Outbound TEXT frames (control plane) for a document, newest last. */
  qa.outboundControl = function outboundControl(documentId) {
    return qa.controlFrames(documentId, 'out');
  };

  /** The role from the most recent `room-joined`, or `null`. */
  qa.lastRoomJoinedRole = function lastRoomJoinedRole(documentId) {
    const frames = qa.inboundControl(documentId)
      .filter((frame) => frame.messageType === 'room-joined')
      .reverse();
    return frames.length === 0 ? null : frames[0].role ?? null;
  };

  /* ------------------------------------------------------------------ *
   * Counters
   * ------------------------------------------------------------------ */

  qa.liveSockets = function liveSockets() {
    return qa.sockets.filter((socket) => socket.closedAt === null).length;
  };

  qa.socketsFor = function socketsFor(documentId) {
    return qa.sockets
      .filter((socket) => socket.documentId === documentId)
      .map((socket) => ({
        index: socket.index,
        url: socket.url,
        openedAt: socket.openedAt,
        closedAt: socket.closedAt,
        closeCode: socket.closeCode,
        closeReason: socket.closeReason,
        framesIn: socket.framesIn,
        framesOut: socket.framesOut,
        handlerAttached: socket.handlers.message !== null,
      }));
  };

  /**
   * Every close code this page has observed, oldest first.
   *
   * Used by the persistence-failure scenario to assert 1011 rather than merely
   * "something closed".
   */
  qa.closeCodes = function closeCodes() {
    return qa.sockets
      .filter((socket) => socket.closedAt !== null)
      .map((socket) => ({
        index: socket.index,
        documentId: socket.documentId,
        code: socket.closeCode,
        reason: socket.closeReason,
      }));
  };

  /**
   * Live **collaboration** sockets only.
   *
   * The page also holds Vite's HMR socket; counting it as a document connection
   * would make a leak assertion pass or fail for the wrong reason.
   */
  qa.liveDocumentSockets = function liveDocumentSockets() {
    return qa.sockets.filter(
      (socket) => socket.isCollaboration === true && socket.closedAt === null,
    ).length;
  };

  qa.summary = function summary() {
    return {
      sockets: qa.sockets.length,
      liveSockets: qa.liveSockets(),
      liveDocumentSockets: qa.liveDocumentSockets(),
      documents: [...new Set(qa.sockets.map((socket) => socket.documentId).filter(Boolean))],
      frames: qa.frames.length,
      idbOpens: qa.idbOpens.length,
      idbNames: [...new Set(qa.idbOpens.map((entry) => entry.name))],
      editorMounts: qa.editor.mounts,
      editorUnmounts: qa.editor.unmounts,
      editorLive: qa.editor.live,
      liveIntervals: qa.intervals.live.size,
      liveAwarenessIntervals: [...qa.intervals.live.values()].filter(
        (delay) => delay === 3000,
      ).length,
      droppedAfterDetach: qa.droppedAfterDetach ?? 0,
      bootstrapCalls: qa.bootstrapCalls.length,
      demoIdentity: qa.demoIdentity,
      errors: qa.errors.length,
      /** Close codes seen so far, so a report can name 1011 without a second call. */
      closeCodes: qa
        .sockets.filter((socket) => socket.closedAt !== null)
        .map((socket) => socket.closeCode),
      offline,
    };
  };

  qa.reset = function reset() {
    qa.sockets.length = 0;
    qa.frames.length = 0;
    qa.idbOpens.length = 0;
    qa.editor.mounts = 0;
    qa.editor.unmounts = 0;
    qa.editor.live = 0;
    qa.droppedAfterDetach = 0;
    qa.bootstrapCalls.length = 0;
    qa.errors.length = 0;
    policies.clear();
    held.clear();
  };

  /* ------------------------------------------------------------------ *
   * Editor mount counting
   * ------------------------------------------------------------------ */

  function installEditorObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('cm-editor')) {
            qa.editor.mounts += 1;
            qa.editor.live += 1;
          }
        }
        for (const node of mutation.removedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('cm-editor')) {
            qa.editor.unmounts += 1;
            qa.editor.live -= 1;
          }
        }
      }
    });
    const start = () => {
      if (document.body !== null) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          observer.observe(document.body, { childList: true, subtree: true });
        });
      }
    };
    start();
  }

  /* ------------------------------------------------------------------ *
   * Interval counting (a leaked y-protocols awareness interval is 3000 ms)
   * ------------------------------------------------------------------ */

  function installTimerCounting() {
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);

    window.setInterval = function setInterval(handler, delay, ...rest) {
      const id = nativeSetInterval(handler, delay, ...rest);
      qa.intervals.created += 1;
      qa.intervals.live.set(id, delay);
      return id;
    };
    window.clearInterval = function clearInterval(id) {
      if (qa.intervals.live.has(id)) {
        qa.intervals.live.delete(id);
        qa.intervals.cleared += 1;
      }
      return nativeClearInterval(id);
    };
  }

  /* ------------------------------------------------------------------ *
   * Input timing (local keystroke latency, measured inside the page)
   * ------------------------------------------------------------------ */

  /**
   * Record how long the browser takes to handle a real input and to paint it.
   *
   * Timestamps come from `performance.now()` inside the real event path, so the
   * measurement excludes the DevTools round trip. `beforeinput` → `input` is the
   * synchronous editor work; the `toPaint` sample is taken on the next animation
   * frame.
   */
  function installInputTiming() {
    qa.inputEvents = [];
    let pendingAt = null;
    document.addEventListener(
      'beforeinput',
      () => {
        pendingAt = performance.now();
      },
      true,
    );
    document.addEventListener(
      'input',
      () => {
        if (pendingAt === null) return;
        const started = pendingAt;
        pendingAt = null;
        const sample = { sync: performance.now() - started, toPaint: null };
        qa.inputEvents.push(sample);
        if (qa.inputEvents.length > 2_000) qa.inputEvents.splice(0, 1_000);
        requestAnimationFrame(() => {
          sample.toPaint = performance.now() - started;
        });
      },
      true,
    );
  }

  /* ------------------------------------------------------------------ *
   * IndexedDB counting
   * ------------------------------------------------------------------ */

  function installIndexedDbCounting() {
    if (window.IDBFactory === undefined) return;
    const nativeOpen = IDBFactory.prototype.open;
    const nativeDelete = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.open = function open(name, version) {
      qa.idbOpens.push({ name: String(name), t: Date.now() - qa.startedAt });
      return version === undefined ? nativeOpen.call(this, name) : nativeOpen.call(this, name, version);
    };
    IDBFactory.prototype.deleteDatabase = function deleteDatabase(name) {
      qa.idbOpens.push({ name: String(name), deleted: true, t: Date.now() - qa.startedAt });
      return nativeDelete.call(this, name);
    };
  }

  installEditorObserver();
  installTimerCounting();
  installIndexedDbCounting();
  installInputTiming();

  window.WebSocket = QAWebSocket;
  // `window.__qa` is the harness's only handle on the page.
  Object.defineProperty(window, '__qa', { value: qa, configurable: true, writable: false });
})();
