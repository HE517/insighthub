/**
 * A minimal Chrome DevTools Protocol client (A6 test harness).
 *
 * Why this exists instead of Playwright: the repository has **no** browser
 * automation dependency, and `AGENTS.md` R3 / §2 forbid adding one without
 * Supervisor approval. Everything used here is already available:
 *
 * - Node 22 ships a global `WebSocket` (the CDP transport),
 * - `fetch` (Node 18+) reads `/json/version` from the debugging port,
 * - a browser is already installed on the machine.
 *
 * So the harness drives a **real** browser with **zero** new dependencies. It is
 * not a jsdom substitute: every assertion in `../suite` runs against a real
 * Chromium renderer, a real IndexedDB implementation and a real WebSocket stack.
 */

/** Error raised when the browser answers a command with a protocol error. */
export class CdpError extends Error {
  constructor(method, payload) {
    super(`${method} failed: ${payload?.message ?? JSON.stringify(payload)}`);
    this.name = 'CdpError';
    this.method = method;
    this.payload = payload;
  }
}

/**
 * One WebSocket to the browser's DevTools endpoint, multiplexing every attached
 * target (CDP "flatten" mode: commands carry a `sessionId`).
 */
export class CdpConnection {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#handleMessage(event.data));
    socket.addEventListener('close', () => this.#handleClose());
  }

  static connect(url, { timeoutMs = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`timed out connecting to the DevTools endpoint ${url}`));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpConnection(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`could not connect to the DevTools endpoint ${url}`));
        },
        { once: true },
      );
    });
  }

  get closed() {
    return this.#closed;
  }

  /** Send one command. Rejects on a protocol error. */
  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error('the CDP connection is closed'));
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Subscribe to a CDP event. The handler receives `{ params, sessionId }`.
   * Returns an unsubscribe function.
   */
  on(method, handler) {
    let set = this.#listeners.get(method);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Wait for the next event of `method`, optionally filtered by session. */
  waitForEvent(method, { sessionId, predicate, timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const off = this.on(method, (event) => {
        if (sessionId !== undefined && event.sessionId !== sessionId) return;
        if (predicate !== undefined && !predicate(event.params)) return;
        clearTimeout(timer);
        off();
        resolve(event.params);
      });
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket.close();
    } catch {
      /* already gone */
    }
    this.#handleClose();
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id);
      if (entry === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new CdpError(entry.method, message.error));
      else entry.resolve(message.result);
      return;
    }

    if (message.method !== undefined) {
      const set = this.#listeners.get(message.method);
      if (set === undefined) return;
      for (const handler of [...set]) {
        try {
          handler({ params: message.params, sessionId: message.sessionId });
        } catch {
          /* a broken listener must not break the transport */
        }
      }
    }
  }

  #handleClose() {
    this.#closed = true;
    for (const [, entry] of this.#pending) {
      entry.reject(new Error(`the CDP connection closed while awaiting ${entry.method}`));
    }
    this.#pending.clear();
  }
}

/** A page (or any) target attached through the browser connection. */
export class CdpPage {
  #connection;
  #sessionId;
  #consoleErrors = [];
  #pageErrors = [];
  #unsubscribers = [];

  constructor(connection, sessionId, targetId) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.targetId = targetId;
  }

  get sessionId() {
    return this.#sessionId;
  }

  /** Console messages at `error` level, and uncaught exceptions. */
  get consoleErrors() {
    return [...this.#consoleErrors];
  }

  get pageErrors() {
    return [...this.#pageErrors];
  }

  clearDiagnostics() {
    this.#consoleErrors.length = 0;
    this.#pageErrors.length = 0;
  }

  send(method, params = {}) {
    return this.#connection.send(method, params, this.#sessionId);
  }

  on(method, handler) {
    const off = this.#connection.on(method, (event) => {
      if (event.sessionId !== this.#sessionId) return;
      handler(event.params);
    });
    this.#unsubscribers.push(off);
    return off;
  }

  /** Enable the domains the harness relies on and start collecting diagnostics. */
  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');

    this.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') return;
      const text = (params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type)
        .join(' ');
      this.#consoleErrors.push(text);
    });
    this.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails ?? {};
      this.#pageErrors.push(
        details.exception?.description ?? details.text ?? 'unknown uncaught exception',
      );
    });
  }

  /** Install a script that runs before any page script, on every navigation. */
  addInitScript(source) {
    return this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  /**
   * Write one cookie for this page's origin through the **browser**, not through JS.
   *
   * `HttpOnly` cookies cannot be set from page script at all, which is exactly why the harness
   * needs this: a scenario that must renew a session (`docs/CONTRACTS.md` §17.2 makes sessions
   * process-scoped) has to go through the browser's cookie store, the same store the real
   * upgrade request reads.
   */
  async setCookie({ name, value, url, httpOnly = true, sameSite = 'Lax', secure = false }) {
    const params = { name, value, url, httpOnly, sameSite, secure };
    let result;
    try {
      result = await this.send('Network.setCookie', params);
    } catch (error) {
      // The value is a credential: name the shape, never the token.
      const shape = {
        ...params,
        value: typeof value === 'string' ? `<${value.length} chars>` : value,
      };
      throw new Error(`${error.message} (params: ${JSON.stringify(shape)})`);
    }
    if (result?.success === false) {
      throw new Error(`the browser refused the cookie ${name} for ${url}`);
    }
    return result;
  }

  /**
   * Every cookie the browser holds for `urls`, **including `HttpOnly` ones**.
   *
   * This is the only way to prove both halves of P2-9 at once: the cookie really exists in the
   * browser, and page script still cannot see it (`document.cookie`).
   */
  async getCookies({ urls } = {}) {
    const result = await this.send('Network.getCookies', urls === undefined ? {} : { urls });
    return result?.cookies ?? [];
  }

  async goto(url, { timeoutMs = 30_000 } = {}) {
    const loaded = this.#connection.waitForEvent('Page.loadEventFired', {
      sessionId: this.#sessionId,
      timeoutMs,
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async reload({ timeoutMs = 30_000 } = {}) {
    const loaded = this.#connection.waitForEvent('Page.loadEventFired', {
      sessionId: this.#sessionId,
      timeoutMs,
    });
    await this.send('Page.reload', { ignoreCache: false });
    await loaded;
  }

  /**
   * Evaluate a function in the page.
   *
   * The function is serialized, so it must be self-contained: no closure over
   * harness variables. Arguments are JSON-encoded and passed positionally.
   */
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(',')})`;
    return this.#evaluateExpression(expression);
  }

  /** Evaluate a raw expression string (use when a function is awkward). */
  async evaluateExpression(expression) {
    return this.#evaluateExpression(expression);
  }

  async #evaluateExpression(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails !== undefined) {
      const details = result.exceptionDetails;
      const text = details.exception?.description ?? details.text ?? 'evaluation failed';
      throw new Error(`page evaluation failed: ${text}`);
    }
    return result.result?.value;
  }

  /**
   * Poll an in-page predicate until it returns truthy.
   *
   * `fn` is serialized like `evaluate`, so it must be self-contained. `args` are
   * passed positionally — forgetting them silently makes the predicate compare
   * against `undefined`, which is how a 30 s timeout with no useful message happens.
   */
  async waitFor(fn, { timeoutMs = 15_000, intervalMs = 100, label = 'condition', args = [] } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate(fn, ...args);
      if (value) return value;
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
      }
      await sleep(intervalMs);
    }
  }

  async waitForSelector(selector, { timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.evaluate(
        (sel) => document.querySelector(sel) !== null,
        selector,
      );
      if (found) return;
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for selector ${selector}`);
      }
      await sleep(100);
    }
  }

  /** Centre point of an element, in CSS pixels, for real mouse input. */
  async centreOf(selector) {
    const box = await this.evaluate((sel) => {
      const element = document.querySelector(sel);
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, selector);
    if (box === null) throw new Error(`no element matches ${selector}`);
    return box;
  }

  /** A real mouse click at the centre of `selector`. */
  async click(selector, { clickCount = 1 } = {}) {
    const { x, y } = await this.centreOf(selector);
    await this.clickAt(x, y, { clickCount });
  }

  async clickAt(x, y, { clickCount = 1 } = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      clickCount: 0,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount,
    });
  }

  /**
   * Real text input into whatever currently has focus.
   *
   * `Input.insertText` produces the same `beforeinput`/`input` sequence a real
   * IME or paste would, which is what CodeMirror listens to. This is deliberately
   * *not* a synthesized `document.execCommand` or a direct state mutation.
   */
  async insertText(text) {
    await this.send('Input.insertText', { text });
  }

  /** One real key press. `key` is a DOM key name, e.g. `Enter`, `z`, `ArrowRight`. */
  async pressKey(key, { modifiers = 0, code, windowsVirtualKeyCode } = {}) {
    const resolvedCode = code ?? keyCodeFor(key);
    const resolvedVirtual = windowsVirtualKeyCode ?? virtualKeyCodeFor(key);
    const base = {
      key,
      code: resolvedCode,
      windowsVirtualKeyCode: resolvedVirtual,
      nativeVirtualKeyCode: resolvedVirtual,
      modifiers,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    // A character event must only be produced for an unmodified (or Shift-modified)
    // printable key. Emitting one for Ctrl+A turns the browser's select-all into the
    // literal text "a" — which silently corrupts any test that replaces a field.
    const ACCEPTED = 8; // Shift is fine; Ctrl/Alt/Meta are shortcuts, not text.
    const hasShortcutModifier = (modifiers & ~ACCEPTED) !== 0;
    if (key.length === 1 && !hasShortcutModifier) {
      await this.send('Input.dispatchKeyEvent', { type: 'char', text: key, ...base });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  /** Capture a PNG screenshot to disk (evidence for the report). */
  async screenshot(filePath) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(result.data, 'base64'));
    return filePath;
  }

  async close() {
    for (const off of this.#unsubscribers) off();
    this.#unsubscribers.length = 0;
    try {
      await this.send('Page.close');
    } catch {
      /* the page may already be gone */
    }
  }
}

/** Create a new page target and attach to it. */
export async function newPage(connection) {
  const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await connection.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const page = new CdpPage(connection, sessionId, targetId);
  await page.init();
  return page;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** DOM `KeyboardEvent.code` for the keys the suite presses. */
function keyCodeFor(key) {
  switch (key) {
    case 'Enter':
      return 'Enter';
    case 'Backspace':
      return 'Backspace';
    case 'Delete':
      return 'Delete';
    case 'Home':
      return 'Home';
    case 'End':
      return 'End';
    case 'ArrowRight':
      return 'ArrowRight';
    case 'ArrowLeft':
      return 'ArrowLeft';
    case 'ArrowUp':
      return 'ArrowUp';
    case 'ArrowDown':
      return 'ArrowDown';
    case 'Shift':
      return 'ShiftLeft';
    case 'z':
      return 'KeyZ';
    case 'y':
      return 'KeyY';
    case 'a':
      return 'KeyA';
    default:
      return key.length === 1 ? `Key${key.toUpperCase()}` : key;
  }
}

/** Windows virtual key code for the keys the suite presses. */
function virtualKeyCodeFor(key) {
  switch (key) {
    case 'Enter':
      return 13;
    case 'Backspace':
      return 8;
    case 'Delete':
      return 46;
    case 'Home':
      return 36;
    case 'End':
      return 35;
    case 'ArrowRight':
      return 39;
    case 'ArrowLeft':
      return 37;
    case 'ArrowUp':
      return 38;
    case 'ArrowDown':
      return 40;
    case 'Shift':
      return 16;
    default:
      return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
  }
}
