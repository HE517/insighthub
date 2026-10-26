/**
 * Test-only page instrumentation for the Performance Evidence Gate.
 *
 * This script is installed with `Page.addScriptToEvaluateOnNewDocument`, so it
 * runs before any application script. It **is test instrumentation, not
 * production telemetry**: nothing in `apps/**` or `packages/**` observes or
 * ships this data.
 *
 * It provides four things on `window.__perf`:
 *
 * - `longTasks`: a `PerformanceObserver({ type: 'longtask', buffered: true })`
 *   buffer (count / duration / max are aggregated by the harness);
 * - `input`: one sample per real `beforeinput` → `input` cycle, timed to the
 *   `.cm-content` input handler (which runs after CodeMirror's own handler) and
 *   to the next animation frame;
 * - `connection`: every observed `data-status` transition of the real
 *   `[data-testid="connection-status"]` badge;
 * - `setOffline(true|false)`: closes the live collaboration socket and rewrites
 *   new `/ws` connections to an unreachable port, so the client's real reconnect
 *   path runs. Vite's HMR socket is deliberately left alone.
 */
export const PERF_INIT_SCRIPT = String.raw`
(() => {
  if (window.__perf !== undefined) return;

  const perf = {
    startedAt: Date.now(),
    timeOrigin: performance.timeOrigin,
    longTasks: [],
    longTaskSupported: false,
    longTaskError: null,
    input: [],
    connection: [],
    offline: false,
    offlineAt: null,
    onlineAt: null,
    sockets: [],
    websocketOfflineRewrites: 0,
  };
  window.__perf = perf;

  /*
   * Dynamic Redux check (test instrumentation only): find the Provider store through the React
   * fiber tree and prove the document body is NOT mirrored into it — the behavioural counterpart
   * of "content lives only in Y.Text" (AGENTS.md R11).
   */
  perf.reduxSnapshot = () => {
    const findStore = () => {
      const root = document.querySelector('#root');
      if (root === null) return null;
      const containerKey = Object.keys(root).find((key) => key.startsWith('__reactContainer$'));
      if (containerKey === undefined) return null;
      const seen = new Set();
      const queue = [root[containerKey]];
      while (queue.length > 0 && seen.size < 20000) {
        const fiber = queue.shift();
        if (fiber === null || typeof fiber !== 'object' || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        if (
          props !== null &&
          typeof props === 'object' &&
          props.store !== undefined &&
          typeof props.store.getState === 'function'
        ) {
          return props.store;
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      return null;
    };

    const store = findStore();
    if (store === null) return { available: false, reason: 'no Redux store in the fiber tree' };
    let json;
    try {
      json = JSON.stringify(store.getState());
    } catch {
      return { available: false, reason: 'state not serialisable' };
    }
    return {
      available: true,
      bytes: json.length,
      keys: Object.keys(store.getState()),
      containsFixtureMarker: json.includes('The quick brown fox jumps over the lazy dog 0123456789.'),
      containsLine99999: json.includes('line-99999:'),
    };
  };

  /* ------------------------------------------------------------------ *
   * Long Tasks (test instrumentation only)
   * ------------------------------------------------------------------ */
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (perf.longTasks.length >= 5000) break;
        perf.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
          name: entry.name,
          entryType: entry.entryType,
          at: Math.round(perf.timeOrigin + entry.startTime),
        });
      }
    });
    try {
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      observer.observe({ entryTypes: ['longtask'] });
    }
    perf.longTaskSupported = true;
  } catch (error) {
    perf.longTaskSupported = false;
    perf.longTaskError = String(error);
  }

  /* ------------------------------------------------------------------ *
   * Connection status transitions (the real badge, not a copy)
   * ------------------------------------------------------------------ */
  let lastStatus = null;
  const recordStatus = () => {
    const element = document.querySelector('[data-testid="connection-status"]');
    const status = element === null ? null : element.getAttribute('data-status');
    if (status === null || status === lastStatus) return;
    lastStatus = status;
    if (perf.connection.length < 2000) {
      perf.connection.push({ status, at: Date.now() });
    }
  };
  new MutationObserver(recordStatus).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-status'],
  });
  recordStatus();

  /* ------------------------------------------------------------------ *
   * Input latency: beforeinput -> input on .cm-content -> next frame
   * ------------------------------------------------------------------ */
  let pendingInput = null;
  const timedInputs = new WeakSet();

  const onInput = () => {
    if (pendingInput === null) return;
    const started = pendingInput;
    pendingInput = null;
    const sample = {
      at: Date.now(),
      inputType: started.inputType,
      dataLength: started.dataLength,
      inputToModelMs: Math.round((performance.now() - started.at) * 100) / 100,
      inputToNextFrameMs: null,
    };
    if (perf.input.length < 5000) perf.input.push(sample);
    requestAnimationFrame(() => {
      sample.inputToNextFrameMs = Math.round((performance.now() - started.at) * 100) / 100;
    });
  };

  const attachToContent = (element) => {
    if (element === null || timedInputs.has(element)) return;
    timedInputs.add(element);
    // The listener is deliberately attached *after* CodeMirror has mounted its
    // own handler, so this timestamp is after the editor transaction applied.
    element.addEventListener('input', onInput, false);
  };

  const attachAll = () => {
    for (const element of document.querySelectorAll('.cm-content')) attachToContent(element);
  };

  document.addEventListener(
    'beforeinput',
    (event) => {
      pendingInput = {
        at: performance.now(),
        inputType: event.inputType,
        dataLength: typeof event.data === 'string' ? event.data.length : null,
      };
    },
    true,
  );

  new MutationObserver(attachAll).observe(document, { subtree: true, childList: true });
  attachAll();

  /* ------------------------------------------------------------------ *
   * Offline control: wrap WebSocket before the application can open one
   * ------------------------------------------------------------------ */
  const NativeWebSocket = window.WebSocket;
  const UNREACHABLE_URL = 'ws://127.0.0.1:9/ws';

  function isCollaborationUrl(url, protocols) {
    try {
      if (Array.isArray(protocols) && protocols.includes('vite-hmr')) return false;
      return new URL(String(url), location.href).pathname === '/ws';
    } catch {
      return String(url).includes('/ws');
    }
  }

  class PerfWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      const collaboration = isCollaborationUrl(url, protocols);
      const effectiveUrl = perf.offline && collaboration ? UNREACHABLE_URL : url;
      if (protocols === undefined) super(effectiveUrl);
      else super(effectiveUrl, protocols);

      if (!collaboration) return;
      if (perf.offline) perf.websocketOfflineRewrites += 1;
      const record = {
        url: String(url),
        openedAt: null,
        closedAt: null,
        closeCode: null,
        socket: this,
      };
      perf.sockets.push(record);
      this.addEventListener('open', () => {
        record.openedAt = Date.now();
      });
      this.addEventListener('close', (event) => {
        record.closedAt = Date.now();
        record.closeCode = typeof event.code === 'number' ? event.code : null;
      });
    }
  }

  PerfWebSocket.CONNECTING = 0;
  PerfWebSocket.OPEN = 1;
  PerfWebSocket.CLOSING = 2;
  PerfWebSocket.CLOSED = 3;
  window.WebSocket = PerfWebSocket;

  perf.setOffline = (value) => {
    const next = Boolean(value);
    perf.offline = next;
    if (next) {
      perf.offlineAt = Date.now();
      for (const record of perf.sockets) {
        if (record.closedAt !== null) continue;
        try {
          record.socket.close();
        } catch {
          /* already gone */
        }
      }
    } else {
      perf.onlineAt = Date.now();
    }
  };

  perf.memorySnapshot = () => {
    const memory = performance.memory;
    if (memory === undefined || memory === null) return null;
    return {
      at: Date.now(),
      usedJSHeapSize: Number(memory.usedJSHeapSize),
      totalJSHeapSize: Number(memory.totalJSHeapSize),
      jsHeapSizeLimit: Number(memory.jsHeapSizeLimit),
    };
  };
})();
`;
