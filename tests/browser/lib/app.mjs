/**
 * Helpers that drive the real application in a real browser.
 *
 * ## How editor state is observed
 *
 * The suite must not accept "the DOM looks right" as proof. But `EditorView` is a
 * module-scoped class, not a global, so the harness cannot simply call
 * `EditorView.findFromDOM()`.
 *
 * In Vite's dev server the browser loads `@codemirror/view` as an ES module at a
 * stable URL (`/node_modules/.vite/deps/@codemirror_view.js?v=…`). The page's
 * module registry is keyed by URL, so importing that **same URL** from an
 * evaluated expression returns the **same module instance** the application is
 * using. That gives the harness the real `EditorView` class, `findFromDOM()`, the
 * live `EditorState`, and the ability to wrap the live `dispatch` — which is what
 * makes the following checkable as facts rather than inference:
 *
 * - the editor's text really equals `Y.Text` (not just what is painted),
 * - a keystroke really does not construct a second `EditorView` (object identity),
 * - a remote single character really is applied as a 1-character transaction and
 *   not as a whole-document replacement (the dispatched `ChangeSet`).
 *
 * Nothing here is a fake: it is the application's own editor instance.
 */
import { artifactsDir } from './deps.mjs';
import { authzFixture, DEFAULT_DEMO_USER } from './authz-fixture.mjs';

/** Stable selectors the application already exposes for exactly this purpose. */
export const SELECTORS = {
  editorHost: '[data-testid="markdown-editor"]',
  editorSurface: '.cm-editor',
  editorContent: '.cm-content',
  connectionStatus: '[data-testid="connection-status"]',
  offlineNotice: '[data-testid="offline-notice"]',
  collaboratorList: '[data-testid="collaborator-list"]',
  activeDocument: '[data-testid="active-document"]',
  undoState: '[data-testid="undo-state"]',
  documentInput: 'input[aria-label="Document id"]',
  initializing: '[data-testid="session-initializing"]',
  failed: '[data-testid="session-failed"]',
  remoteCaret: '[data-insighthub-cursor="caret"]',
  remoteCursorLabel: '[data-insighthub-cursor="label"]',
  remoteSelection: '[data-insighthub-selection]',
  /** The read-only notice (`apps/web/src/features/permissions/ReadOnlyNotice.tsx`). */
  readOnlyNotice: '[data-testid="read-only-notice"]',
  sessionIdentity: '[data-testid="session-identity"]',
};

/**
 * Words that must never appear in the read-only notice
 * (`docs/CONTRACTS.md` §17.9, `docs/DECISIONS.md` D-064 §1).
 *
 * The notice may explain *why* typing does nothing. It may not imply that anything was
 * saved, and it may not claim that a role change reached the UI immediately — the client
 * only learns a role from `room-joined` (D-066 §5).
 */
export const READ_ONLY_NOTICE_BANNED_WORDS = ['saved', 'saving', 'immediately', 'instant'];

/** Load the instrumentation source once, so it can be injected on every page. */
let instrumentSource;
export async function loadInstrumentSource() {
  if (instrumentSource !== undefined) return instrumentSource;
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  instrumentSource = await readFile(
    path.join(here, '..', 'instrument', 'page-instrument.js'),
    'utf8',
  );
  return instrumentSource;
}


/** Install the instrumentation on a fresh page and open the application. */
export async function openApp(page, { url, documentId, as = DEFAULT_DEMO_USER } = {}) {
  if (as !== null) await page.addInitScript(`window.__qaIdentity = ${JSON.stringify(as)};`);
  await page.addInitScript(await loadInstrumentSource());
  page.demoUserId = as;
  await page.goto(url);
  await waitForSessionActive(page);
  if (documentId !== undefined) await setDocumentId(page, documentId);
  return page;
}

/** Wait until the workspace has an `active` session and a mounted editor. */
export async function waitForSessionActive(page, { timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const state = await page.evaluate(() => {
      const failed = document.querySelector('[data-testid="session-failed"]');
      return {
        failed: failed === null ? null : failed.textContent,
        status: document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null,
        editor: document.querySelector('.cm-editor') !== null,
        initializing: document.querySelector('[data-testid="session-initializing"]') !== null,
      };
    });
    if (state.failed !== null) throw new Error(`the session failed to open: ${state.failed}`);
    if (state.editor && state.status !== null) return state;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `the editor did not become usable within ${timeoutMs}ms ` +
          `(initializing=${state.initializing}, status=${state.status})`,
      );
    }
    await sleep(100);
  }
}

/**
 * Switch the workspace to another document, the way a user does it: focus the
 * document field, replace its contents, press Enter.
 *
 * ## Why this *may* write a membership row
 *
 * Since `docs/CONTRACTS.md` §17.5 a `join-room` requires a membership row, and every scenario's
 * document id is its own (`a6-*`) so scenarios stay isolated. A switch to a document with no
 * membership would be denied with `ROOM_NOT_FOUND` — the same answer as "this document does not
 * exist" — which would look like a product failure. The harness therefore *arranges access* for
 * the page's own identity before switching, with the `ifAbsent` rule: a seeded or
 * scenario-chosen role is never overwritten by the harness.
 *
 * ## Why the write is optional (`arrangeAccess: false`)
 *
 * `docs/DECISIONS.md` D-065 §5 (the F3 evidence condition) makes an implicit membership write a
 * **false-success hazard**: a fixture that quietly gives itself `owner` can turn a denial
 * scenario green, and it can make a `getRole() === null` window look like a permission decision.
 * A scenario that must observe "this identity has no role at all" therefore passes
 * `arrangeAccess: false`, and *nothing* on the page-opening path touches `authz.db`. The default
 * stays `true` so legacy scenarios keep working unchanged.
 */
export async function setDocumentId(page, documentId, { arrangeAccess = true } = {}) {
  const identity = page.demoUserId ?? DEFAULT_DEMO_USER;
  if (arrangeAccess) {
    await authzFixture().grant(documentId, identity, 'owner', { ifAbsent: true });
  }
  await page.click(SELECTORS.documentInput);
  await page.pressKey('a', { modifiers: 2 }); // Ctrl+A selects the field contents.
  await page.insertText(documentId);

  const fieldValue = await page.evaluate(
    (selector) => document.querySelector(selector)?.value ?? null,
    SELECTORS.documentInput,
  );
  if (fieldValue !== documentId) {
    throw new Error(
      `could not set the document field: expected ${JSON.stringify(documentId)}, ` +
        `field holds ${JSON.stringify(fieldValue)}`,
    );
  }

  await page.pressKey('Enter');
  // The workspace is keyed by documentId, so the new session initialises, syncs
  // and remounts the editor. Wait for the id to be reflected and the editor back.
  await page.waitFor(
    (expected) =>
      document.querySelector('[data-testid="active-document"]')?.textContent?.trim() === expected &&
      document.querySelector('.cm-editor') !== null,
    { timeoutMs: 30_000, label: `document ${documentId}`, args: [documentId] },
  );
  await installEditorProbe(page);
  await clearEditorTransactions(page);
}

/** The document the workspace currently points at. */
export async function activeDocumentId(page) {
  return page.evaluate(
    () => document.querySelector('[data-testid="active-document"]')?.textContent?.trim() ?? null,
  );
}

/**
 * Reload the page and re-attach the editor probe.
 *
 * The device-side instrumentation is injected per document (`Page.
 * addScriptToEvaluateOnNewDocument`), but the probe lives in page memory, so a
 * reload genuinely removes it. Re-installing it is required, not optional.
 */
export async function reloadApp(page, { timeoutMs = 30_000 } = {}) {
  await page.reload();
  await page.waitForSelector('.cm-editor', { timeoutMs });
  await installEditorProbe(page);
  await clearEditorTransactions(page);
}

/* -------------------------------------------------------------------- *
 * Editor probe (real EditorView)
 * -------------------------------------------------------------------- */

/**
 * Attach the EditorView probe: resolve the real `EditorView` class from the page's
 * own module registry, keep a handle on the live view, and wrap `dispatch` so the
 * transactions the editor really performs are recorded.
 */
export async function installEditorProbe(page) {
  const result = await page.evaluate(async () => {
    const qa = window.__qa;
    if (qa === undefined) return { ok: false, reason: 'instrumentation is not installed' };

    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    const moduleUrl =
      resources.find((name) => name.includes('@codemirror_view')) ??
      resources.find((name) => name.includes('codemirror_state'));
    if (moduleUrl === undefined) {
      return { ok: false, reason: 'no @codemirror/view module URL in resource timing' };
    }

    const module = await import(moduleUrl);
    const EditorView = module.EditorView;
    if (typeof EditorView?.findFromDOM !== 'function') {
      return { ok: false, reason: 'findFromDOM is not available on the resolved module' };
    }

    qa.probe = qa.probe ?? {
      transactions: [],
      viewIds: new WeakMap(),
      nextViewId: 1,
      view: null,
      moduleUrl,
      prototypePatched: false,
    };
    const probe = qa.probe;

    const idOf = (view) => {
      let id = probe.viewIds.get(view);
      if (id === undefined) {
        id = probe.nextViewId;
        probe.nextViewId += 1;
        probe.viewIds.set(view, id);
      }
      return id;
    };

    // Patch the *prototype* once, not each instance. A per-instance patch only
    // covers views that already existed when the probe attached, so a view created
    // by a document switch or a remount would silently record nothing — which is
    // exactly the kind of gap that makes an assertion pass for the wrong reason.
    if (!probe.prototypePatched) {
      probe.prototypePatched = true;
      const originalDispatch = EditorView.prototype.dispatch;
      EditorView.prototype.dispatch = function patchedDispatch(...args) {
        const docBefore = this.state.doc.length;
        let recorded = null;
        try {
          const spec = args[0];
          const changes = spec !== null && typeof spec === 'object' ? spec.changes : undefined;
          if (changes !== undefined && changes !== null) {
            let count = 0;
            let inserted = 0;
            let deleted = 0;
            if (typeof changes.iterChanges === 'function') {
              // A ChangeSet (what the binding uses for a wholesale resync).
              changes.iterChanges((fromA, toA, fromB, toB, text) => {
                count += 1;
                deleted += toA - fromA;
                inserted += text.length;
              });
            } else if (Array.isArray(changes)) {
              // An array of ChangeSpec — what `applyDelta` passes for a remote edit.
              // Treating only ChangeSet as valid hid every remote update from this
              // recorder, which made a "no transaction" assertion look like a product
              // bug. Both shapes are legal CodeMirror input.
              for (const change of changes) {
                const from = typeof change?.from === 'number' ? change.from : 0;
                const to = typeof change?.to === 'number' ? change.to : from;
                count += 1;
                deleted += to - from;
                inserted += typeof change?.insert === 'string' ? change.insert.length : 0;
              }
            } else {
              count = -1;
            }
            recorded = { count, inserted, deleted };
          }
        } catch {
          /* recording must never break the editor */
        }
        const result = originalDispatch.apply(this, args);
        if (recorded !== null) {
          try {
            probe.transactions.push({
              t: Date.now() - qa.startedAt,
              viewId: idOf(this),
              docBefore,
              // Read from the live state after the update: `spec.changes.length` is the
              // array length for the ChangeSpec form, not the document length.
              docAfter: this.state.doc.length,
              count: recorded.count,
              inserted: recorded.inserted,
              deleted: recorded.deleted,
            });
          } catch {
            /* ignore */
          }
        }
        return result;
      };
    }

    probe.refresh = function refresh() {
      const host = document.querySelector('[data-testid="markdown-editor"]');
      const view = host === null ? null : EditorView.findFromDOM(host);
      probe.view = view;
      if (view !== null) idOf(view);
      return view;
    };

    probe.state = function state() {
      const view = probe.refresh();
      if (view === null) return null;
      const main = view.state.selection.main;
      return {
        text: view.state.doc.toString(),
        length: view.state.doc.length,
        viewId: probe.viewIds.get(view) ?? 0,
        anchor: main.anchor,
        head: main.head,
        /**
         * The two read-only facts, read from the live `EditorState`/`EditorView` rather than
         * from a DOM attribute alone: `EditorState.readOnly` is what CodeMirror's commands and
         * input handlers consult, and the content element's `contenteditable` attribute is what
         * `EditorView.editable` makes the browser enforce. A gate that set only one of them
         * would look correct in whichever one a test happened to check.
         */
        readOnly: view.state.readOnly === true,
        contentEditable: view.contentDOM?.getAttribute('contenteditable') ?? null,
      };
    };

    probe.clear = function clear() {
      probe.transactions.length = 0;
    };

    const view = probe.refresh();
    return {
      ok: true,
      moduleUrl,
      hasView: view !== null,
      viewId: view === null ? null : (probe.viewIds.get(view) ?? 0),
    };
  });

  if (!result.ok) throw new Error(`the editor probe could not attach: ${result.reason}`);
  return result;
}

/**
 * The live editor state: `{ text, length, viewId, anchor, head }`.
 *
 * The probe lives in page memory, so a page reload removes it. Rather than making
 * every caller remember to re-attach, this re-attaches once on demand — a reloaded
 * page still has a real `EditorView`, and failing here would report a harness gap as
 * a product failure.
 */
export async function editorState(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const diagnostics = await page.evaluate(() => {
      const state = window.__qa?.probe?.state?.() ?? null;
      if (state !== null) return { state };
      return {
        state: null,
        probeInstalled: window.__qa?.probe !== undefined,
        probeModule: window.__qa?.probe?.moduleUrl ?? null,
        hostPresent: document.querySelector('[data-testid="markdown-editor"]') !== null,
        cmEditorCount: document.querySelectorAll('.cm-editor').length,
        cmContentCount: document.querySelectorAll('.cm-content').length,
        url: location.href,
        failedBanner:
          document.querySelector('[data-testid="session-failed"]')?.textContent ?? null,
        initializing: document.querySelector('[data-testid="session-initializing"]') !== null,
      };
    });
    if (diagnostics.state !== null) return diagnostics.state;

    if (attempt === 0 && diagnostics.hostPresent) {
      // Try to re-attach a lost probe before reporting a failure.
      try {
        await installEditorProbe(page);
        continue;
      } catch (error) {
        throw new Error(
          `the editor probe could not be re-attached: ${error.message} ` +
            `(diagnostics: ${JSON.stringify(diagnostics)})`,
        );
      }
    }

    throw new Error(
      'the editor probe is not attached (no live EditorView): ' + JSON.stringify(diagnostics),
    );
  }
  throw new Error('the editor probe could not be attached');
}

/** Transactions the editor has performed since the last `clearEditorTransactions`. */
export async function editorTransactions(page) {
  return page.evaluate(() => window.__qa?.probe?.transactions ?? []);
}

export async function clearEditorTransactions(page) {
  await page.evaluate(() => {
    window.__qa?.probe?.clear?.();
  });
}

/** Text painted in the DOM. CodeMirror virtualises, so this is the *visible* text. */
export async function renderedText(page) {
  return page.evaluate(
    () => document.querySelector('.cm-content')?.innerText ?? null,
  );
}

/** Wait until the editor's text satisfies `predicate`, returning the final state. */
export async function waitForEditorText(page, predicate, { timeoutMs = 25_000, label = 'text' } = {}) {
  const started = Date.now();
  let last = { text: '', length: 0, viewId: 0 };
  for (;;) {
    last = await editorState(page);
    if (predicate(last.text, last)) return last;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for ${label}: the editor holds ${last.text.length} chars ` +
          `(${JSON.stringify(last.text.slice(0, 120))})`,
      );
    }
    await sleep(100);
  }
}

/* -------------------------------------------------------------------- *
 * Presence / status
 * -------------------------------------------------------------------- */

/** Collaborator names rendered by `CollaboratorList`, plus their client ids. */
export async function readCollaborators(page) {
  return page.evaluate(() => {
    const avatars = [...document.querySelectorAll('[data-client-id]')];
    const rows = avatars.map((avatar) => {
      const row = avatar.parentElement?.parentElement ?? avatar.parentElement;
      return {
        clientId: Number(avatar.getAttribute('data-client-id')),
        text: (row?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      };
    });
    const list = document.querySelector('[data-testid="collaborator-list"]');
    return {
      count: rows.length,
      listPresent: list !== null,
      rows,
      emptyState: document.body.innerText.includes('Only you are here'),
    };
  });
}

export async function readConnectionStatus(page) {
  return page.evaluate(
    () => document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null,
  );
}

/** Wait until the badge reports `expected` (or any of the expected values). */
export async function waitForConnectionStatus(page, expected, { timeoutMs = 20_000 } = {}) {
  const wanted = Array.isArray(expected) ? expected : [expected];
  const deadline = Date.now() + timeoutMs;
  let observed = null;
  while (Date.now() < deadline) {
    observed = await readConnectionStatus(page);
    if (wanted.includes(observed)) return observed;
    await sleep(100);
  }
  throw new Error(
    `connection badge never reached ${wanted.join(' or ')}, last observed ${observed}`,
  );
}

export async function readUndoState(page) {
  return page.evaluate(
    () => document.querySelector('[data-testid="undo-state"]')?.textContent?.trim() ?? null,
  );
}

/* -------------------------------------------------------------------- *
 * The role gate as the browser actually renders it (M2 Phase 2 / A7 F1)
 * -------------------------------------------------------------------- */

/**
 * Everything the browser shows about the role gate, read from the **live DOM and the real
 * `EditorView`** — not from a prop and not from the source.
 *
 * Three independent observations are folded into one call on purpose, because §17.9's
 * consequence ("a known non-editing role makes the editor read-only and says so; an unknown
 * role must never lock the editor") is only proven when all three agree:
 *
 * | Field | Read from | What it proves |
 * | --- | --- | --- |
 * | `contentEditable` | the real `.cm-content` attribute | the browser refuses the keystroke (`EditorView.editable`) |
 * | `viewReadOnly` | `EditorView.state.readOnly` of the live view | CodeMirror's own gate (`EditorState.readOnly`) |
 * | `notice` | `[data-testid="read-only-notice"]` + `getBoundingClientRect` | the explanation is **visible**, not merely present |
 * | `roleTag` | the `role: …` chip in the card title | `session.getRole()`'s value as the UI renders it (`null` = no chip) |
 */
export async function readEditorGate(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('.cm-editor');
    const content = document.querySelector('.cm-content');
    const notice = document.querySelector('[data-testid="read-only-notice"]');
    const rect = notice === null ? null : notice.getBoundingClientRect();
    const style = notice === null ? null : getComputedStyle(notice);
    // The header chip is the only element whose trimmed text is exactly `role: <something>`.
    const chip = [...document.querySelectorAll('span')].find((node) =>
      /^role:\s*\S+$/.test((node.textContent ?? '').trim()),
    );
    const probe = window.__qa?.probe;
    const state = typeof probe?.state === 'function' ? probe.state() : null;
    return {
      editorPresent: editor !== null,
      contentEditable: content === null ? null : content.getAttribute('contenteditable'),
      viewId: state?.viewId ?? null,
      viewReadOnly: state === null ? null : state.readOnly === true,
      viewText: state?.text ?? null,
      notice: {
        present: notice !== null,
        text: notice === null ? null : (notice.textContent ?? '').replace(/\s+/g, ' ').trim(),
        title: notice?.querySelector('.read-only-notice__title')?.textContent?.trim() ?? null,
        detail: notice?.querySelector('.read-only-notice__detail')?.textContent?.trim() ?? null,
        testId: notice === null ? null : notice.getAttribute('data-testid'),
        visible:
          notice !== null &&
          rect !== null &&
          rect.width > 0 &&
          rect.height > 0 &&
          style !== null &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0',
        width: rect === null ? null : Math.round(rect.width),
        height: rect === null ? null : Math.round(rect.height),
      },
      roleTag: chip === undefined ? null : (chip.textContent ?? '').trim(),
      undoState: document.querySelector('[data-testid="undo-state"]')?.textContent?.trim() ?? null,
    };
  });
}

/**
 * Stamp a token on the live `.cm-editor` element.
 *
 * `EditorView.findFromDOM()` returns an object, but two evaluations cannot compare object
 * identity across the CDP boundary. A property on the DOM node can be read back later, so
 * "the same element, not a rebuilt one" becomes an assertion instead of an inference — which is
 * what `docs/DECISIONS.md` D-067 §7 asks A6 to prove (A2 only measured the `reconfigure`).
 *
 * The mount/unmount counters come from the page's own `MutationObserver`
 * (`instrument/page-instrument.js`), so they answer the same question a second way.
 */
export async function markEditorDom(page, token) {
  return page.evaluate((value) => {
    const editor = document.querySelector('.cm-editor');
    if (editor === null) return { ok: false, reason: 'no .cm-editor in the DOM' };
    editor.__qaIdentityMarker = value;
    return {
      ok: true,
      mounts: window.__qa.editor.mounts,
      unmounts: window.__qa.editor.unmounts,
      live: window.__qa.editor.live,
    };
  }, token);
}

/** Read the marker back, together with the mount counters. */
export async function readEditorDomMarker(page) {
  return page.evaluate(() => {
    const editor = document.querySelector('.cm-editor');
    return {
      present: editor !== null,
      marker: editor === null ? null : (editor.__qaIdentityMarker ?? null),
      mounts: window.__qa.editor.mounts,
      unmounts: window.__qa.editor.unmounts,
      live: window.__qa.editor.live,
    };
  });
}

/**
 * Outbound **SYNC** frames (frame type `0`) the page sent for one document.
 *
 * Awareness frames (frame type `1`) are excluded deliberately: a read-only viewer still
 * publishes its cursor (`§17.5`: AWARENESS requires `canRead` only), so counting all binary
 * frames would make "no write frame was emitted" false for a reason that has nothing to do with
 * writing text.
 */
export async function countOutboundSyncFrames(page, documentId) {
  return page.evaluate((id) => {
    return window.__qa.frames.filter(
      (frame) =>
        frame.direction === 'out' &&
        frame.kind === 'binary' &&
        frame.frameType === 0 &&
        (frame.documentId === id || frame.documentId === null || frame.documentId === undefined),
    ).length;
  }, documentId);
}

/**
 * Send one **SYNC update** frame on the page's own socket, bypassing the editor entirely.
 *
 * This is the "UI is not a security boundary" instrument (`docs/DECISIONS.md` D-065 §4 point 4):
 * the frame travels over the browser's own authenticated connection, so the server's answer is
 * observed by the real client — but no UI control, no role gate and no keyboard produced it.
 *
 * The bytes are built by the harness with the frozen codec (`packages/shared`), because the
 * page's own `Y.Doc` is module-scoped and not reachable from an injected script. What the frame
 * *carries* is therefore harness-authored; *who sends it* is the real page.
 */
export async function sendSyncUpdateFromPage(page, documentId, base64) {
  return page.evaluate(
    (id, encoded) => {
      const result = window.__qa.sendBinary(id, encoded);
      return { ...result, frame: window.__qa.frames.at(-1) ?? null };
    },
    documentId,
    base64,
  );
}

/**
 * Deliver one **server** control frame to the page's own message handler.
 *
 * Used for the one thing the browser cannot otherwise be made to do: believe a role it was not
 * given. The envelope is built with `packages/shared`'s own constructor, so the client accepts
 * it exactly as it accepts a real `room-joined`; the server is not involved and is not
 * simulated afterwards — what it answers to the resulting write is observed for real.
 */
export async function deliverServerFrame(page, documentId, envelopeJson) {
  return page.evaluate(
    (id, text) => window.__qa.injectRawText(id, text),
    documentId,
    envelopeJson,
  );
}

/** Remote cursor / selection DOM as the user sees it. */
export async function readRemoteCursorDom(page) {
  return page.evaluate(() => {
    const carets = [...document.querySelectorAll('[data-insighthub-cursor="caret"]')];
    const labels = [...document.querySelectorAll('[data-insighthub-cursor="label"]')];
    const selections = [...document.querySelectorAll('[data-insighthub-selection]')];
    return {
      caretCount: carets.length,
      labelCount: labels.length,
      selectionCount: selections.length,
      labels: labels.map((label) => label.textContent ?? ''),
      selectionClientIds: selections.map((node) => node.getAttribute('data-insighthub-selection')),
      caretColors: carets.map((caret) => getComputedStyle(caret).borderLeftColor),
    };
  });
}

/** Console errors and uncaught exceptions the page produced. */
export async function readPageDiagnostics(page) {
  return {
    consoleErrors: page.consoleErrors.slice(-6),
    pageErrors: page.pageErrors.slice(-6),
  };
}

/* -------------------------------------------------------------------- *
 * Control plane as the browser saw it (M2 Phase 2)
 * -------------------------------------------------------------------- */

/**
 * Inbound TEXT control frames the page received for a document.
 *
 * Read from the instrumentation, i.e. from the frames the **real client** received — not from
 * a proxy socket. Each entry carries `messageType`, and for the two phase-2 messages also
 * `code` (`error`) or `role` (`room-joined`).
 */
export async function inboundControl(page, documentId) {
  return page.evaluate((id) => window.__qa.inboundControl(id), documentId);
}

/**
 * Outbound TEXT control frames the page sent for a document.
 *
 * This is where a claim the client itself made is observable — e.g. the `mode: 'readwrite'`
 * that every join carries, or a `userId` a scenario injected into the payload.
 */
export async function outboundControl(page, documentId) {
  return page.evaluate((id) => window.__qa.outboundControl(id), documentId);
}

/** The role from the page's most recent `room-joined` (§17.5's only role channel). */
export async function lastRoomJoinedRole(page, documentId) {
  return page.evaluate((id) => window.__qa.lastRoomJoinedRole(id), documentId);
}

/**
 * Wait until the page has received a server `error` frame with `code`.
 *
 * A denial is only evidence if the real client received it, so this reads the page's own
 * traffic. The failure message lists what the page *did* receive, because "timed out" alone
 * cannot distinguish a missing denial from a broken socket.
 */
export async function waitForServerErrorCode(page, code, { timeoutMs = 20_000, documentId } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = await inboundControl(page, documentId);
    const found = frames.find((frame) => frame.messageType === 'error' && frame.code === code);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) {
      const seen = frames.map((frame) => `${frame.messageType}${frame.code === undefined ? '' : `(${frame.code})`}`);
      throw new Error(
        `the page never received a ${code} error frame (saw: ${seen.join(', ') || 'nothing'})`,
      );
    }
    await sleep(100);
  }
}

/** Every close code the page has observed, with its document and reason. */
export async function pageCloseCodes(page) {
  return page.evaluate(() => window.__qa.closeCodes());
}

/** How many `error` frames with `code` the page has received for a document. */
export async function countServerErrorCode(page, code, documentId) {
  const frames = await inboundControl(page, documentId);
  return frames.filter((frame) => frame.messageType === 'error' && frame.code === code).length;
}

/**
 * Wait until the page receives a **new** `error` frame with `code` — i.e. one beyond
 * `afterCount`.
 *
 * `waitForServerErrorCode` answers "has this code ever arrived". That is too weak for a
 * scenario that provokes the code itself: any earlier frame of the same code would satisfy it,
 * and the scenario would pass without having tested what it claims. Since M2 Phase 2 those
 * scenarios send their write **themselves** (a SYNC frame on the page's own socket), so "the
 * denial must be newer than my attempt" is the honest question.
 */
export async function waitForNewServerErrorCode(
  page,
  code,
  { documentId, afterCount = 0, timeoutMs = 20_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frames = await inboundControl(page, documentId);
    const matches = frames.filter((frame) => frame.messageType === 'error' && frame.code === code);
    if (matches.length > afterCount) return { frame: matches[afterCount], count: matches.length };
    if (Date.now() >= deadline) {
      const seen = frames.map(
        (frame) => `${frame.messageType}${frame.code === undefined ? '' : `(${frame.code})`}`,
      );
      throw new Error(
        `the page never received a new ${code} error frame beyond ${afterCount} ` +
          `(saw ${matches.length}: ${seen.join(', ') || 'nothing'})`,
      );
    }
    await sleep(100);
  }
}

/* -------------------------------------------------------------------- *
 * Input
 * -------------------------------------------------------------------- */

/**
 * Click into the editor and type `text` for real.
 *
 * `atEnd` moves the caret to the end of the document first (Ctrl+End, CodeMirror's
 * own binding), so a scenario never depends on where a click happened to land.
 */
export async function typeInEditor(page, text, { atEnd = true } = {}) {
  await page.click(SELECTORS.editorContent);
  if (atEnd) await page.pressKey('End', { modifiers: 2 });
  await page.insertText(text);
}

/** Click the editor, then press `key` (`count` times), with optional modifiers. */
export async function pressInEditor(page, key, { count = 1, modifiers = 0 } = {}) {
  await page.click(SELECTORS.editorContent);
  for (let index = 0; index < count; index += 1) {
    await page.pressKey(key, { modifiers });
  }
}

/** Select `count` characters to the right of the caret with Shift+ArrowRight. */
export async function selectRight(page, count, { modifiers = 0 } = {}) {
  for (let index = 0; index < count; index += 1) {
    // CDP modifier bit 8 is Shift.
    await page.pressKey('ArrowRight', { modifiers: modifiers | 8 });
  }
}

/* -------------------------------------------------------------------- *
 * IndexedDB — inspected for real, not inferred from the UI
 * -------------------------------------------------------------------- */

/**
 * Read the browser's real IndexedDB state.
 *
 * Returns every database name the origin holds, and for each store the record
 * count plus a structural sample, so a test can prove the replica holds **encoded
 * Yjs updates** and not a parallel Markdown string (`docs/ARCHITECTURE.md` §0).
 */
export async function readIndexedDb(page, { includeSample = true } = {}) {
  return page.evaluate(async (withSample) => {
    const listDatabases = async () => {
      if (typeof indexedDB.databases !== 'function') return [];
      const databases = await indexedDB.databases();
      return databases.map((entry) => ({ name: entry.name ?? '', version: entry.version ?? 0 }));
    };

    const openDatabase = (name) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error ?? new Error('open failed'));
        request.onsuccess = () => resolve(request.result);
        // Never upgrade: this must observe the database as the app left it.
        request.onupgradeneeded = () => {
          // The app-owned schema is created by the app; creating it here would hide
          // the very thing under test, so abort.
          request.transaction?.abort();
          reject(new Error(`database ${name} does not exist (it would have been created)`));
        };
      });

    const databases = await listDatabases();
    const report = [];

    for (const database of databases) {
      let db;
      try {
        db = await openDatabase(database.name);
      } catch (error) {
        report.push({ ...database, error: String(error), stores: [] });
        continue;
      }

      const stores = [];
      for (const storeName of [...db.objectStoreNames]) {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const count = await new Promise((resolve, reject) => {
          const request = store.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        let sample = null;
        if (withSample) {
          const records = await new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const first = records[0];
          sample = {
            // The decisive check: is this encoded binary, or a parallel string?
            firstRecordType:
              first === undefined
                ? 'none'
                : typeof first === 'string'
                  ? 'string'
                  : ArrayBuffer.isView(first) || first instanceof ArrayBuffer
                    ? 'binary'
                    : typeof first,
            firstRecordByteLength:
              first === undefined
                ? 0
                : typeof first === 'string'
                  ? first.length
                  : (first.byteLength ?? 0),
            keys: records.length === 0 ? [] : Object.keys(Object(records[0])),
            totalBytes: records.reduce((sum, record) => sum + (record?.byteLength ?? 0), 0),
          };
        }
        stores.push({ name: storeName, count, sample });
      }
      db.close();
      report.push({ ...database, stores });
    }

    return { databases: report };
  }, includeSample);
}

/** Delete every database for this origin (test isolation). */
export async function clearIndexedDb(page) {
  return page.evaluate(async () => {
    if (typeof indexedDB.databases !== 'function') return [];
    const databases = await indexedDB.databases();
    const deleted = [];
    for (const entry of databases) {
      if (entry.name === undefined) continue;
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(entry.name);
        request.onsuccess = () => resolve(undefined);
        request.onerror = () => resolve(undefined);
        request.onblocked = () => resolve(undefined);
      });
      deleted.push(entry.name);
    }
    return deleted;
  });
}

/** The local replica's database name for a document (`y-indexeddb` naming). */
export function documentDatabaseName(documentId) {
  return `insighthub-doc:${documentId}`;
}

/** The replica entry for one document out of a `readIndexedDb` report. */
export function documentReplica(report, documentId) {
  const name = documentDatabaseName(documentId);
  return report.databases.find((database) => database.name === name) ?? null;
}

/**
 * Wait until the local replica has actually been written.
 *
 * `y-indexeddb` batches through a 1 s `_storeTimeout`, so "the text is on screen"
 * is not evidence that it is durable. This waits for the `updates` store to hold
 * records and for the count to stop growing over a quiet window — a real read of the
 * real database, not a sleep.
 */
export async function waitForPersisted(
  page,
  { documentId, minRecords = 1, timeoutMs = 25_000, quietMs = 1_500 } = {},
) {
  const started = Date.now();
  let previousCount = -1;
  let stableSince = Date.now();
  let lastReport = null;

  for (;;) {
    lastReport = await readIndexedDb(page, { includeSample: false });
    const replica = documentId === undefined ? null : documentReplica(lastReport, documentId);
    const updatesStore =
      replica?.stores.find((store) => store.name === 'updates') ?? null;
    const count = updatesStore?.count ?? 0;

    if (count >= minRecords) {
      if (count === previousCount) {
        if (Date.now() - stableSince >= quietMs) return { count, report: lastReport };
      } else {
        previousCount = count;
        stableSince = Date.now();
      }
    } else {
      previousCount = count;
      stableSince = Date.now();
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `the local replica for ${documentId ?? '(any document)'} did not reach ` +
          `${minRecords} stored update(s) within ${timeoutMs}ms ` +
          `(databases: ${lastReport.databases.map((database) => database.name).join(', ') || 'none'})`,
      );
    }
    await sleep(250);
  }
}

/** A compact, reportable view of an IndexedDB report. */
export function describeIndexedDb(report) {
  return report.databases.map((database) => ({
    name: database.name,
    version: database.version,
    stores: database.stores.map((store) => ({
      name: store.name,
      count: store.count,
      firstRecordType: store.sample?.firstRecordType ?? null,
      firstRecordByteLength: store.sample?.firstRecordByteLength ?? null,
      totalBytes: store.sample?.totalBytes ?? null,
    })),
    ...(database.error === undefined ? {} : { error: database.error }),
  }));
}

/* -------------------------------------------------------------------- *
 * Chaos controls
 * -------------------------------------------------------------------- */

export async function setOffline(page, value) {
  await page.evaluate((next) => {
    window.__qa.setOffline(next);
  }, value);
}

export async function setPolicy(page, documentId, patch) {
  return page.evaluate(
    (id, next) => window.__qa.policy(id, next),
    documentId,
    patch,
  );
}

export async function qaSummary(page) {
  return page.evaluate(() => window.__qa.summary());
}

export async function holdCount(page, documentId) {
  return page.evaluate((id) => window.__qa.heldCount(id), documentId);
}

export async function releaseHeld(page, documentId, options = {}) {
  return page.evaluate(
    (id, opts) => window.__qa.releaseHeld(id, opts),
    documentId,
    options,
  );
}

export async function captureBinaryFrames(page, value) {
  await page.evaluate((next) => {
    window.__qa.captureBinary = next;
  }, value);
}

export async function lastInboundBinary(page, documentId) {
  return page.evaluate((id) => window.__qa.lastInboundBinary(id), documentId);
}

export async function injectInbound(page, documentId, base64, times = 1) {
  return page.evaluate(
    (id, encoded, count) => window.__qa.injectInbound(id, encoded, { times: count }),
    documentId,
    base64,
    times,
  );
}

export async function injectRawText(page, documentId, text) {
  return page.evaluate(
    (id, payload) => window.__qa.injectRawText(id, payload),
    documentId,
    text,
  );
}

export async function countInboundBinary(page, documentId) {
  return page.evaluate((id) => window.__qa.countInboundBinary(id), documentId);
}

/* -------------------------------------------------------------------- *
 * Misc
 * -------------------------------------------------------------------- */

export async function screenshot(page, name) {
  const path = await import('node:path');
  return page.screenshot(path.join(artifactsDir, `${name}.png`));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `fn` until it returns truthy or the timeout expires. */
export async function waitUntil(fn, { timeoutMs = 20_000, intervalMs = 100, label = 'condition' }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}
