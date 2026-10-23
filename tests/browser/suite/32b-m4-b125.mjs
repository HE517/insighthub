/**
 * M4 B12.5 batch 3 — `New document` as a **committed browser scenario**
 * (`docs/DECISIONS.md` D-084 acceptance #2, #6 and #7).
 *
 * ## Why this file exists
 *
 * B12.5 shipped three separate proofs: the server's atomic creation
 * (`apps/server/src/authz/documents-create.test.ts`), the flow's double-click semantics
 * (`apps/web/src/features/editor/newDocumentFlow.test.ts`) and the panel's markup
 * (`aiDirectory.test.ts`, via `renderToStaticMarkup`). None of them drives the product:
 * a Node test can prove the state machine's transitions, but it cannot prove that the real
 * button in the real panel, over the real HTTP endpoint, with the real cookie, switches the
 * real workspace. This suite closes that gap with three scenarios on the **default** path
 * (no environment variable — the B12.5 entry point is part of the shipped product, not a
 * mode).
 *
 * ```text
 * open AI panel (ai-directory ready)          ← server list, real session
 *   → click [data-testid="new-document"]
 *     → POST /api/documents  (real network)   ← observed at the fetch layer *and* over CDP
 *       → 201 { documentId, title }           ← server-generated UUID, never the old id
 *         → refresh directory, then switch    ← the existing documentSelected action
 *           → panel unmounts, new room joins as owner, .cm-content editable
 * ```
 *
 * ## Three questions, three scenarios
 *
 * | Scenario | Question |
 * | --- | --- |
 * | `b125/1-create-document-switches` | does one click create **one** document on the server and switch this workspace to exactly it? |
 * | `b125/2-create-failure-does-not-switch` | does an **unreachable server** keep the workspace, the list and the button usable, and can the same click succeed afterwards? |
 * | `b125/3-double-click-creates-one-document` | do **two clicks in the same task** still create one document? (D-084 #6: no double-click path) |
 *
 * ## What is observed, and how — nothing is mocked
 *
 * - The POST is a real request from the real page. Its status is read **twice**:
 *   the page instrumentation's `/api/**` log (`window.__qa.apiCalls`, which observes the
 *   status the application's own `fetch` received) and CDP `Network.responseReceived`
 *   (the browser's network stack, independent of application code). The 201 **body**
 *   (`documentId`, `title`) is read through `Network.getResponseBody`, so "the workspace
 *   switched to the id the server returned" is a comparison, not an inference.
 * - The directory is the product's own `ai-directory` (`data-state`, `aria-current`,
 *   `data-document-id`), i.e. server truth rendered by the panel.
 * - The role is read from the page's **own** `room-joined` control frame
 *   (`window.__qa.lastRoomJoinedRole`, §17.5's only role channel) and from the header chip
 *   the user sees; editability is read from the live `EditorState.readOnly` and the DOM's
 *   `contenteditable`, not from a class name.
 *
 * ## Offline is the browser's network stack, not the socket shim
 *
 * `lib/app.mjs#setOffline` simulates an unreachable **collaboration socket**; it does not
 * touch `fetch`, so it cannot make `POST /api/documents` fail. Scenario 2 therefore uses CDP
 * `Network.emulateNetworkConditions { offline: true }` — the same mechanism
 * `suite/33-m3-remote.mjs#m3r/4` uses for the directory — and asserts the typed
 * `data-create-error="network"` that the real browser produces.
 *
 * ## Why `32b` and not `40`
 *
 * `run.mjs` discovers the suite in filename order and `suite/33-m3-remote.mjs` is the group that
 * **changes the stack's configuration** (it restarts the backend with `AI_PROVIDER=stub` and
 * Vite with `VITE_AI_PROVIDER=remote`). That group must stay last, so the default-configuration
 * scenarios keep measuring the frozen defaults; `32b` sorts after `32-design-fidelity.mjs` and
 * before `33-m3-remote.mjs`, which is exactly where a default-path scenario belongs.
 *
 * ## Determinism, diagnostics, no retries
 *
 * Every wait is a condition (`waitFor`/poll) on a named selector or state; there is no fixed
 * sleep used as a wait, no retry, and no assertion weakened to keep the suite green. A
 * timeout reports the selector, the observed state and the directory entries, because
 * "timed out" alone cannot distinguish a product regression from a harness gap.
 */
import {
  activeDocumentId,
  readApiCalls,
  readEditorGate,
  sleep,
  waitForConnectionStatus,
} from '../lib/app.mjs';
import { assert, assertDeepEqual, assertEqual, assertIncludes } from '../lib/harness.mjs';

/* ---------------------------------------------------------------------- *
 * The published test ids this file drives (no test id was added by A6)
 * ---------------------------------------------------------------------- */

const AI = {
  open: '[data-testid="ai-open"]',
  panel: '[data-testid="ai-panel"]',
  directory: '[data-testid="ai-directory"]',
  item: '[data-testid="ai-directory-item"]',
  newDocument: '[data-testid="new-document"]',
  newDocumentError: '[data-testid="new-document-error"]',
};

/** The control's idle label (`newDocumentCopy.ts#NEW_DOCUMENT_LABEL`). */
const NEW_DOCUMENT_LABEL = 'New document';

/** The server's default title (`apps/server/src/persistence/document-creation.ts`). */
const UNTITLED_DOCUMENT = 'Untitled document';

/** The server generates the id (`D-084 #2`): a UUID, never the document the page opened on. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A per-run marker, so a document from an earlier run can never satisfy an assertion. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---------------------------------------------------------------------- *
 * Reading the panel and the directory
 * ---------------------------------------------------------------------- */

/**
 * Every fact these scenarios assert, in one round trip.
 *
 * The directory is read through `data-testid="ai-directory-item"` and `aria-current` /
 * `data-document-id`, i.e. the machine-readable contract `AiDirectory.tsx` publishes; the
 * title is read from the row's own title element so it is compared as a title, not as a
 * concatenated row string. `visible` is a real `getBoundingClientRect`, so a failure block
 * that exists but is `display: none` can never be reported as "shown to the user".
 */
async function readPanel(page) {
  return page.evaluate((selectors) => {
    const one = (selector) => document.querySelector(selector);
    const textOf = (element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    const panel = one(selectors.panel);
    const directory = one(selectors.directory);
    const error = one(selectors.newDocumentError);
    const errorRect = error === null ? null : error.getBoundingClientRect();
    const errorStyle = error === null ? null : getComputedStyle(error);
    const button = one(selectors.newDocument);
    const items = [...document.querySelectorAll(selectors.item)].map((item) => ({
      id: item.getAttribute('data-document-id'),
      current: item.getAttribute('aria-current'),
      title: (item.querySelector('.ai-directory__doc-title')?.textContent ?? '').trim(),
      text: textOf(item),
    }));
    return {
      open: panel !== null,
      phase: panel === null ? null : panel.getAttribute('data-phase'),
      directory: {
        present: directory !== null,
        state: directory === null ? null : directory.getAttribute('data-state'),
        items,
        itemCount: items.length,
        ids: items.map((item) => item.id),
        currentIds: items.filter((item) => item.current === 'true').map((item) => item.id),
        errorPresent: one('[data-testid="ai-directory-error"]') !== null,
      },
      createError: {
        present: error !== null,
        kind: error === null ? null : error.getAttribute('data-create-error'),
        text: error === null ? null : textOf(error),
        visible:
          error !== null &&
          errorRect !== null &&
          errorRect.width > 0 &&
          errorRect.height > 0 &&
          errorStyle !== null &&
          errorStyle.display !== 'none' &&
          errorStyle.visibility !== 'hidden',
      },
      newDocument: {
        present: button !== null,
        disabled: button === null ? null : button.disabled === true,
        label: button === null ? null : textOf(button),
      },
    };
  }, AI);
}

/** Poll the whole panel until `predicate` holds; a timeout reports the last observed state. */
async function waitForPanel(
  page,
  predicate,
  { timeoutMs = 30_000, label = 'the AI panel state' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await readPanel(page);
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label}; ` +
          `last panel state: ${JSON.stringify(last)}`,
      );
    }
    await sleep(100);
  }
}

/** Poll only the directory; used where opening the panel is not what is being measured. */
async function waitForDirectory(
  page,
  predicate,
  { timeoutMs = 30_000, label = 'the AI directory' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = (await readPanel(page)).directory;
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label}; ` +
          `last directory state: ${JSON.stringify(last)}`,
      );
    }
    await sleep(100);
  }
}

/** Scroll an element into view, settle the layout on the next frame, then click it for real. */
async function clickVisible(page, selector) {
  const found = await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (element === null) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  }, selector);
  assert(found, `the control ${selector} must exist before it can be clicked`);
  // Two animation frames: `scrollIntoView` changes the layout the click coordinates come from.
  // This is a layout settle, not a timeout, so no fixed sleep is involved.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
      }),
  );
  await page.click(selector);
}

/** Open the panel with the real "Ask AI" trigger and wait for its idle state. */
async function openPanel(page) {
  await clickVisible(page, AI.open);
  return waitForPanel(page, (state) => state.open && state.phase === 'idle', {
    label: 'the AI panel to open',
  });
}

/* ---------------------------------------------------------------------- *
 * Server preconditions and the workspace switch
 * ---------------------------------------------------------------------- */

/**
 * Wait until the server lists every expected id for this session.
 *
 * A document is listable once its metadata row exists; the join that records it does not
 * await the write (`registry.ts`), so a freshly opened document can briefly be absent from
 * `GET /api/documents`. This waits on the **server** (a real request from the page), so the
 * directory assertion below still reads the product's own list — the harness never asserts
 * against its own fetch.
 */
async function waitForDocumentList(page, expectedIds, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await page.evaluate(async () => {
      const response = await fetch('/api/documents', { credentials: 'same-origin' });
      if (!response.ok) return { status: response.status, ids: [] };
      const body = await response.json();
      const documents = Array.isArray(body?.documents) ? body.documents : [];
      return { status: response.status, ids: documents.map((document) => document.id) };
    });
    if (expectedIds.every((id) => last.ids.includes(id))) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${expectedIds.join(', ')} to be listed; ` +
          `last server list: ${JSON.stringify(last)}`,
      );
    }
    await sleep(150);
  }
}

/** Poll `active-document` until it names `documentId`. */
async function waitForActiveDocument(page, documentId, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await activeDocumentId(page);
    if (last === documentId) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for the workspace to switch to ` +
          `${JSON.stringify(documentId)}; last active document: ${JSON.stringify(last)}`,
      );
    }
    await sleep(100);
  }
}

/** Wait until `active-document` is a UUID different from `previous`. */
async function waitForDifferentActiveDocument(page, previous, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await activeDocumentId(page);
    if (last !== null && last !== previous && UUID_PATTERN.test(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for a new UUID active document ` +
          `(previous ${JSON.stringify(previous)}); last active document: ${JSON.stringify(last)}`,
      );
    }
    await sleep(100);
  }
}

/* ---------------------------------------------------------------------- *
 * The role and the editor gate, as the browser renders them
 * ---------------------------------------------------------------------- */

/**
 * Wait until the header shows `role: <expected>` **and** the editor is editable.
 *
 * `session.getRole()` is only populated from `room-joined` (§17.9 rule 1), so the chip can
 * lag the switch; waiting for it is waiting for the real role channel, not for a cosmetic
 * delay. `readEditorGate` reads `EditorState.readOnly` and the live `.cm-content`
 * `contenteditable`, so "editable" is the browser's gate and CodeMirror's gate agreeing.
 */
async function waitForRoleAndEditable(page, expectedRole, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await readEditorGate(page);
    if (
      last.editorPresent &&
      last.roleTag === `role: ${expectedRole}` &&
      last.viewReadOnly === false &&
      last.contentEditable === 'true'
    ) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for role: ${expectedRole} and an editable ` +
          `editor; last gate: ${JSON.stringify(last)}`,
      );
    }
    await sleep(100);
  }
}

/** Wait until the page's most recent `room-joined` reports `expected` for `documentId`. */
async function waitForRoomJoinedRole(
  page,
  documentId,
  expected,
  { timeoutMs = 30_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await page.evaluate((id) => window.__qa.lastRoomJoinedRole(id), documentId);
    if (last === expected) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for a room-joined role of ${expected} on ` +
          `${documentId}; last role: ${JSON.stringify(last)}`,
      );
    }
    await sleep(100);
  }
}

/* ---------------------------------------------------------------------- *
 * Real network observation
 * ---------------------------------------------------------------------- */

/**
 * `POST /api/documents` calls the page made, from the page's own instrumentation.
 *
 * Snapshot the length before an action and slice afterwards: without that, an earlier
 * successful call would satisfy "a 201 happened" and an earlier failure would satisfy "the
 * offline attempt failed" — a false-success path this suite exists to exclude.
 */
async function postDocumentCalls(page) {
  return (await readApiCalls(page)).filter(
    (call) => call.method === 'POST' && call.path === '/api/documents',
  );
}

/** Is this CDP request the creation endpoint (and not `GET /api/documents/:id`)? */
function isDocumentCreationRequest(request) {
  if (request === null || request === undefined) return false;
  if (request.method !== 'POST') return false;
  try {
    return new URL(request.url).pathname === '/api/documents';
  } catch {
    return false;
  }
}

/**
 * Watch `POST /api/documents` at the **browser's** network layer.
 *
 * This is independent of the application's `fetch`: even if the client's code did something
 * unusual with the response, CDP would still show the request the browser sent and the
 * status the server answered. `Network.getResponseBody` then yields the frozen 201 body.
 */
async function watchDocumentCreation(page) {
  await page.send('Network.enable');
  const requests = new Map();
  const creations = [];

  page.on('Network.requestWillBeSent', (params) => {
    const request = params.request ?? {};
    requests.set(params.requestId, {
      method: String(request.method ?? '').toUpperCase(),
      url: String(request.url ?? ''),
    });
  });
  page.on('Network.responseReceived', (params) => {
    const request = requests.get(params.requestId);
    if (!isDocumentCreationRequest(request)) return;
    const response = params.response ?? {};
    creations.push({
      requestId: params.requestId,
      url: request.url,
      status: typeof response.status === 'number' ? response.status : null,
      mimeType: response.mimeType ?? null,
      finishedAt: null,
    });
  });
  page.on('Network.loadingFinished', (params) => {
    const entry = creations.find((creation) => creation.requestId === params.requestId);
    if (entry !== undefined) entry.finishedAt = Date.now();
  });

  return { creations };
}

/** Poll the CDP watcher until the browser has an answer for the POST. */
async function waitForCreationResponse(page, watcher, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = watcher.creations.filter((creation) => creation.status !== null);
    if (last.length > 0) return last[0];
    if (Date.now() >= deadline) {
      const panel = await readPanel(page).catch((error) => ({ error: String(error) }));
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for the browser to see a response to ` +
          `POST /api/documents; observed creations: ${JSON.stringify(watcher.creations)}; ` +
          `panel: ${JSON.stringify(panel)}`,
      );
    }
    await sleep(50);
  }
}

/**
 * Read the 201 body through CDP — the authoritative `{ documentId, title }`.
 *
 * Retried on the CDP "no resource with this identifier" window between the response headers
 * and the finished resource; the retry waits for a condition, it does not swallow a failure
 * (an unreadable body still fails the scenario, with the CDP error).
 */
async function readCreationBody(page, entry, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const result = await page.send('Network.getResponseBody', { requestId: entry.requestId });
      const text = result.base64Encoded
        ? Buffer.from(String(result.body), 'base64').toString('utf8')
        : String(result.body);
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { text, json };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the browser could not return the POST /api/documents body over CDP ` +
          `(request ${entry.requestId}, status ${entry.status}): ` +
          `${lastError?.message ?? String(lastError)}`,
      );
    }
    await sleep(50);
  }
}

/** Emulate the browser's own network stack being offline (or back online). */
async function setBrowserNetworkOffline(page, offline) {
  await page.send('Network.enable');
  await page.send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
    connectionType: offline ? 'none' : 'wifi',
  });
}

/* ---------------------------------------------------------------------- *
 * Registration
 * ---------------------------------------------------------------------- */

export function register(runner) {
  /* ================================================================== *
   * 1 — one click creates one document on the server and switches to it
   * ================================================================== */
  runner.scenario(
    'b125/1-create-document-switches',
    'clicking New document in a real browser POSTs /api/documents (201), switches active-document to the server-generated UUID, closes the panel, joins the new room as owner with an editable editor, and the reopened directory marks that one row current as Untitled document',
    async (ctx) => {
      const originalId = `a6-b125-create-${marker('doc')}`;
      const page = await ctx.newAppPage({ documentId: originalId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      // The directory is server truth: wait for the join's metadata write before measuring it.
      await waitForDocumentList(page, [originalId]);

      await openPanel(page);
      const before = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory to reach data-state=ready',
      });
      ctx.note('directory before creating', {
        documentId: originalId,
        state: before.state,
        itemCount: before.itemCount,
        currentIds: before.currentIds,
      });
      assert(
        before.itemCount >= 1,
        `the directory must list at least the active document (got ${before.itemCount}: ${JSON.stringify(before.ids)})`,
      );
      assertEqual(
        before.currentIds.length,
        1,
        'before creating, exactly one row must be aria-current (the active document)',
      );
      assertEqual(before.currentIds[0], originalId, 'the current row must be the active document');

      /* ---------- the click, with the browser's own network observation ---------- */
      const watcher = await watchDocumentCreation(page);
      const callsBefore = (await postDocumentCalls(page)).length;
      await clickVisible(page, AI.newDocument);

      const creation = await waitForCreationResponse(page, watcher);
      const body = await readCreationBody(page, creation);
      ctx.note('POST /api/documents as the browser saw it', {
        url: creation.url,
        status: creation.status,
        mimeType: creation.mimeType,
        body: body.text,
      });
      assertEqual(
        creation.status,
        201,
        'the browser must observe a real 201 from POST /api/documents (CDP Network domain)',
      );
      assert(body.json !== null, `the 201 body must be JSON, got ${JSON.stringify(body.text)}`);
      const created = body.json;
      assert(
        typeof created.documentId === 'string' && UUID_PATTERN.test(created.documentId),
        `the created document id must be the server-generated UUID (got ${JSON.stringify(created.documentId)})`,
      );
      assert(
        created.documentId !== originalId,
        'the created document must be a different document from the one the page opened',
      );
      assertEqual(
        created.title,
        UNTITLED_DOCUMENT,
        'an empty POST body must produce the server default title',
      );

      /* ---------- the same request, as the page's own fetch observed it ---------- */
      const calls = await postDocumentCalls(page);
      const createdCalls = calls.slice(callsBefore);
      ctx.note(
        'POST /api/documents calls (page instrumentation)',
        createdCalls.map((call) => ({ status: call.status, error: call.error, t: call.t })),
      );
      assertEqual(createdCalls.length, 1, 'one click must issue exactly one POST');
      assertEqual(
        createdCalls[0].status,
        201,
        'the application must have received the 201 itself (not only CDP)',
      );

      /* ---------- the workspace switched to exactly that document ---------- */
      const switchedTo = await waitForActiveDocument(page, created.documentId);
      ctx.note('workspace after creating', {
        activeDocument: switchedTo,
        previousDocument: originalId,
        createdDocumentId: created.documentId,
      });
      assertEqual(
        switchedTo,
        created.documentId,
        'active-document must become the id the server returned',
      );

      /* ---------- the panel closed (the workspace remounted for the new id) ---------- */
      const closed = await waitForPanel(page, (state) => state.open === false, {
        label: 'the AI panel to unmount when the workspace switches to the new document',
      });
      assertEqual(closed.open, false, 'switching documents must close the AI panel');

      /* ---------- the new document is owned by this identity and is editable ---------- */
      const role = await waitForRoomJoinedRole(page, created.documentId, 'owner');
      const gate = await waitForRoleAndEditable(page, 'owner');
      const editorText = await page.evaluate(
        () => document.querySelector('.cm-content')?.innerText ?? null,
      );
      ctx.note('new document', {
        documentId: created.documentId,
        roomJoinedRole: role,
        roleTag: gate.roleTag,
        contentEditable: gate.contentEditable,
        stateReadOnly: gate.viewReadOnly,
        editorTextLength: editorText === null ? null : editorText.length,
      });
      assertEqual(
        role,
        'owner',
        'the creator must join its new document with role owner (D-084 #5)',
      );
      assertEqual(gate.contentEditable, 'true', 'the new document editor must be editable');
      assertEqual(gate.viewReadOnly, false, 'the live EditorState must not be read-only');

      /* ---------- reopening the panel marks the new document, and only it ---------- */
      await openPanel(page);
      const after = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory after reopening on the created document',
      });
      ctx.note('directory after creating', {
        state: after.state,
        itemCount: after.itemCount,
        currentIds: after.currentIds,
        items: after.items,
      });
      assertEqual(
        after.currentIds.length,
        1,
        'exactly one row must be aria-current after reopening on the created document',
      );
      assertEqual(
        after.currentIds[0],
        created.documentId,
        'the current row must be the created document, not the previous one',
      );
      const row = after.items.find((item) => item.id === created.documentId) ?? null;
      assert(row !== null, 'the created document must be listed in the directory');
      assertIncludes(
        row.title,
        UNTITLED_DOCUMENT,
        'the created row must render the server title "Untitled document"',
      );
      assertEqual(
        after.items.filter((item) => item.id === created.documentId).length,
        1,
        'the created document must appear exactly once in the directory',
      );
      assertEqual(
        after.errorPresent,
        false,
        'a successful creation must not leave a directory error behind',
      );
    },
  );

  /* ================================================================== *
   * 2 — a failed creation changes nothing and can be retried
   * ================================================================== */
  runner.scenario(
    'b125/2-create-failure-does-not-switch',
    'with the browser network offline, clicking New document shows new-document-error[data-create-error=network], leaves active-document and the directory entries unchanged and re-enables the button; restoring the network and clicking again switches to the created document',
    async (ctx) => {
      const documentId = `a6-b125-failure-${marker('doc')}`;
      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await waitForDocumentList(page, [documentId]);

      await openPanel(page);
      const before = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory to reach data-state=ready',
      });
      ctx.note('directory before the failed attempt', {
        documentId,
        state: before.state,
        itemCount: before.itemCount,
        ids: before.ids,
      });
      assert(before.itemCount >= 1, 'the directory must have rows before the offline probe');
      const activeBefore = await activeDocumentId(page);
      assertEqual(activeBefore, documentId, 'the workspace starts on this scenario document');

      const callsBefore = (await postDocumentCalls(page)).length;

      /* ---------- real offline: the browser's network stack, not the socket shim ---------- */
      await setBrowserNetworkOffline(page, true);
      let offlineCalls = [];
      try {
        await clickVisible(page, AI.newDocument);
        const failed = await waitForPanel(
          page,
          (state) => state.createError.present === true,
          { label: 'the new-document-error block to be rendered' },
        );
        ctx.note('failed creation while offline', {
          createError: failed.createError,
          newDocument: failed.newDocument,
          directory: { state: failed.directory.state, itemCount: failed.directory.itemCount },
        });
        assertEqual(
          failed.createError.kind,
          'network',
          'an unreachable server must surface as the typed network failure',
        );
        assertEqual(
          failed.createError.visible,
          true,
          'the failure must be visible to the user, not merely present in the DOM',
        );
        assertIncludes(
          failed.createError.text,
          'The request did not complete.',
          'the visible copy must say the request did not complete',
        );

        offlineCalls = (await postDocumentCalls(page)).slice(callsBefore);
        ctx.note(
          'POST /api/documents attempts while offline',
          offlineCalls.map((call) => ({ status: call.status, error: call.error, t: call.t })),
        );
        assertEqual(offlineCalls.length, 1, 'the failed click must have attempted exactly one POST');
        assertEqual(
          offlineCalls[0].status,
          null,
          'the offline POST must not have received an HTTP answer',
        );
        assert(
          offlineCalls[0].error !== null,
          'the offline POST must be recorded as a failed network call',
        );

        /* ---------- nothing changed: no switch, no row, button usable again ---------- */
        const activeAfter = await activeDocumentId(page);
        ctx.note('workspace after the failed attempt', {
          activeDocument: activeAfter,
          expected: documentId,
          panelOpen: failed.open,
        });
        assertEqual(
          activeAfter,
          documentId,
          'a failed creation must not switch the workspace (D-084 #7)',
        );
        assertEqual(failed.open, true, 'the AI panel must stay open after a failure');
        assertEqual(
          failed.directory.itemCount,
          before.itemCount,
          'a failed creation must not change the number of directory entries',
        );
        assertDeepEqual(
          failed.directory.ids,
          before.ids,
          'a failed creation must not add, remove or reorder directory entries',
        );
        assertDeepEqual(
          failed.directory.currentIds,
          before.currentIds,
          'a failed creation must not move the aria-current marker',
        );
        assertEqual(
          failed.newDocument.disabled,
          false,
          'the New document button must be usable again after the failure',
        );
        assertEqual(
          failed.newDocument.label,
          NEW_DOCUMENT_LABEL,
          'the button must return to its idle label (the pending state must be cleared)',
        );
      } finally {
        await setBrowserNetworkOffline(page, false);
      }

      /* ---------- recovery: the same control, a real 201 and a real switch ---------- */
      const watcher = await watchDocumentCreation(page);
      const retryBefore = (await postDocumentCalls(page)).length;
      await clickVisible(page, AI.newDocument);
      const creation = await waitForCreationResponse(page, watcher);
      const body = await readCreationBody(page, creation);
      const created = body.json;
      ctx.note('POST /api/documents after the network returned', {
        status: creation.status,
        body: body.text,
      });
      assertEqual(creation.status, 201, 'the retry after recovery must be a real 201');
      assert(
        typeof created?.documentId === 'string' && UUID_PATTERN.test(created.documentId),
        `the retry must return a server-generated UUID (got ${JSON.stringify(created?.documentId)})`,
      );

      const switchedTo = await waitForActiveDocument(page, created.documentId);
      ctx.note('workspace after the retry', {
        activeDocument: switchedTo,
        documentId: created.documentId,
      });
      assertEqual(
        switchedTo,
        created.documentId,
        'the retry must switch the workspace to the created document',
      );

      const retryCalls = (await postDocumentCalls(page)).slice(retryBefore);
      ctx.note(
        'POST /api/documents attempts after recovery',
        retryCalls.map((call) => ({ status: call.status, error: call.error, t: call.t })),
      );
      assertEqual(retryCalls.length, 1, 'the retry must issue exactly one POST');
      assertEqual(retryCalls[0].status, 201, 'the retry POST must be a real 201');

      /* ---------- the recovered document is listed exactly once and is current ---------- */
      await openPanel(page);
      const after = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory after the successful retry',
      });
      ctx.note('directory after the successful retry', {
        state: after.state,
        itemCount: after.itemCount,
        currentIds: after.currentIds,
        items: after.items,
      });
      assertEqual(
        after.itemCount,
        before.itemCount + 1,
        'the successful retry must add exactly one directory entry (the failed attempt added none)',
      );
      assertDeepEqual(
        after.currentIds,
        [created.documentId],
        'only the created document may be aria-current after the retry',
      );
      assertEqual(
        after.items.filter((item) => item.id === created.documentId).length,
        1,
        'the recovered document must be listed exactly once',
      );
    },
  );

  /* ================================================================== *
   * 3 — two clicks in the same task still create one document
   * ================================================================== */
  runner.scenario(
    'b125/3-double-click-creates-one-document',
    'two real click events dispatched in the same task create exactly one document: the page sends one POST /api/documents, the server list grows by one row (not two), and the workspace switches to that one document',
    async (ctx) => {
      const documentId = `a6-b125-double-${marker('doc')}`;
      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await waitForDocumentList(page, [documentId]);

      await openPanel(page);
      const before = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory to reach data-state=ready',
      });
      ctx.note('directory before the double click', {
        documentId,
        state: before.state,
        itemCount: before.itemCount,
        ids: before.ids,
      });
      assert(before.itemCount >= 1, 'the directory must have rows before the double click');
      const activeBefore = await activeDocumentId(page);
      assertEqual(activeBefore, documentId, 'the workspace starts on this scenario document');

      const watcher = await watchDocumentCreation(page);
      const callsBefore = (await postDocumentCalls(page)).length;

      /*
       * Two clicks in **one** task, on the real button.
       *
       * This is the window `newDocumentFlow.ts` exists for: React has not re-rendered the
       * button as `disabled` yet, so the attribute cannot be what stops the second click — the
       * flow's synchronous in-flight guard has to. A capture listener counts the events that
       * actually reached the control, so "two clicks were dispatched" is evidence rather than
       * an assumption about `.click()`.
       */
      const clicks = await page.evaluate(() => {
        const button = document.querySelector('[data-testid="new-document"]');
        if (button === null) return { ok: false, reason: 'no [data-testid="new-document"]' };
        const seen = [];
        button.addEventListener(
          'click',
          (event) => {
            seen.push(event.timeStamp);
          },
          true,
        );
        button.click();
        button.click();
        return { ok: true, seen };
      });
      ctx.note('clicks dispatched in one task', clicks);
      assert(clicks.ok === true, `the real button must exist; got ${JSON.stringify(clicks)}`);
      assertEqual(clicks.seen.length, 2, 'two click events must have reached the control');

      const creation = await waitForCreationResponse(page, watcher);
      const body = await readCreationBody(page, creation);
      const created = body.json;
      ctx.note('POST /api/documents after the double click', {
        status: creation.status,
        body: body.text,
        requestsSeenByCdp: watcher.creations.length,
      });
      assertEqual(creation.status, 201, 'the double click must create the document with a real 201');
      assert(
        typeof created?.documentId === 'string' && UUID_PATTERN.test(created.documentId),
        `the created document id must be a server-generated UUID (got ${JSON.stringify(created?.documentId)})`,
      );

      /* ---------- exactly one request, from both observers ---------- */
      const calls = (await postDocumentCalls(page)).slice(callsBefore);
      ctx.note(
        'POST /api/documents calls after the double click',
        calls.map((call) => ({ status: call.status, error: call.error, t: call.t })),
      );
      assertEqual(
        calls.length,
        1,
        'two clicks must produce exactly one POST /api/documents (the in-flight guard)',
      );
      assertEqual(calls[0].status, 201, 'the single POST must be a real 201');
      assertEqual(
        watcher.creations.length,
        1,
        'the browser network stack must have seen exactly one creation request',
      );

      const switchedTo = await waitForActiveDocument(page, created.documentId);
      ctx.note('workspace after the double click', {
        activeDocument: switchedTo,
        createdDocumentId: created.documentId,
      });
      assertEqual(
        switchedTo,
        created.documentId,
        'the double click must switch the workspace to the one document it created',
      );
      await waitForPanel(page, (state) => state.open === false, {
        label: 'the AI panel to close after the switch',
      });

      /* ---------- the server list grew by one row, not two ---------- */
      await openPanel(page);
      const after = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory after the double click',
      });
      ctx.note('directory after the double click', {
        state: after.state,
        itemCount: after.itemCount,
        currentIds: after.currentIds,
        items: after.items,
      });
      assertEqual(
        after.itemCount,
        before.itemCount + 1,
        'a double click must add exactly one directory entry, not two',
      );
      assertDeepEqual(
        after.currentIds,
        [created.documentId],
        'the created document must be the only aria-current row',
      );
      assertEqual(
        after.items.filter((item) => item.id === created.documentId).length,
        1,
        'the created document must appear exactly once',
      );
      for (const id of before.ids) {
        assert(
          after.ids.includes(id),
          `the pre-existing entry ${id} must still be listed (the list must not be replaced)`,
        );
      }
    },
  );
}
