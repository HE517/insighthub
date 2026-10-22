/**
 * M3 Round 2 — the **remote** AI chain in a real browser, plus the read-only AI directory.
 *
 * ```text
 * browser ──real fetch──► POST /api/ai/suggest ──► server provider ──► draft
 *    └── client mints Yjs anchors ──► Diff Preview ──► Accept (Yjs transaction) ──► durable store
 * ```
 *
 * ## Why this file exists
 *
 * Round 1 proved the local provider loop (`suite/31-m3-ai.mjs`). The remote path shipped with
 * Node-level tests for every piece (`apps/web/src/features/ai/remoteProvider.test.ts`,
 * `apps/server/src/ai/route.test.ts`, `stub.test.ts`), but **no browser ever drove it**: no test
 * could say that the real panel, over the real HTTP endpoint, against a real provider, produced
 * a proposal that the real editor accepted. A Node test can prove the mapping functions; it
 * cannot prove the wiring. These five scenarios close that gap.
 *
 * ## The mode switch is deliberate, and it is why the default run is untouched
 *
 * `INSIGHTHUB_E2E_AI_MODE=remote` is the only thing that registers this file. Without it the
 * suite is exactly the previous 68 scenarios. **With** it, the same run must also keep those 68
 * green, and they are the measurements of the **default** configuration (`AI_PROVIDER` unset →
 * `503`, `VITE_AI_PROVIDER` unset → local provider; `suite/31-m3-ai.mjs` asserts the local intent
 * chips and local copy). A globally remote Vite would make those scenarios measure a different
 * product, so the switch happens here, at this group's boundary: the first `m3r/*` scenario stops
 * Vite, restarts the backend on a **fresh durable store** with `AI_PROVIDER=stub`, and starts Vite
 * with `VITE_AI_PROVIDER=remote`. The 68 have already run by then (this file sorts last), and
 * each of the five scenarios calls {@link ensureRemoteAiStack} so a filtered run
 * (`--filter m3r/3`) switches too.
 *
 * The environment mechanism is `lib/stack.mjs` (`serverEnv` / `webEnv` injection,
 * `setServerEnv` / `setWebEnv` + restart). The defaults are unchanged: with no mode env the two
 * children receive exactly the variables they always did.
 *
 * ## What "remote" is proven by, not assumed from
 *
 * | Claim | Evidence |
 * | --- | --- |
 * | the client is remote | `ai-intent` count is **0**, the idle empty copy is the remote copy, the panel note is the remote note |
 * | the browser really called the endpoint | the page instrumentation logs `POST /api/ai/suggest` with the **status the server answered** (200 / 503) |
 * | the draft came from the **server** stub | `ai-summary` is the stub's fixed sentence and the applied text is `String.prototype.toUpperCase()` of the reviewed snapshot — neither string exists in the browser bundle |
 * | Accept is the only writer | editor **and** durable text are unchanged after Generate; they change only after the click, through the revision tracker's Yjs transaction |
 *
 * ## Scenario 4 is a real network failure
 *
 * `lib/app.mjs#setOffline` simulates an unreachable **collaboration socket**; it does not touch
 * `fetch`, so it cannot exercise a failed `GET /api/documents`. The directory scenario therefore
 * uses CDP `Network.emulateNetworkConditions { offline: true }` — the browser's own network stack —
 * and asserts the typed `network` failure, the absence of any cached row in the error state, and
 * a real `200` after the network returns.
 */
import {
  activeDocumentId,
  editorState,
  readApiCalls,
  readHistoryButtons,
  readUndoState,
  SELECTORS,
  sleep,
  typeInEditor,
  waitForConnectionStatus,
  waitForEditorText,
} from '../lib/app.mjs';
import { reconstructDurableDocument, waitForDurableText } from '../lib/durable-store.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';

/* ---------------------------------------------------------------------- *
 * The published test ids this file drives
 * ---------------------------------------------------------------------- */

const AI = {
  open: '[data-testid="ai-open"]',
  panel: '[data-testid="ai-panel"]',
  instruction: '[data-testid="ai-instruction"]',
  intent: '[data-testid="ai-intent"]',
  generate: '[data-testid="ai-generate"]',
  status: '[data-testid="ai-status"]',
  empty: '[data-testid="ai-empty"]',
  proposal: '[data-testid="ai-proposal"]',
  summary: '[data-testid="ai-summary"]',
  diff: '[data-testid="ai-diff"]',
  accept: '[data-testid="ai-accept"]',
  reject: '[data-testid="ai-reject"]',
  directory: '[data-testid="ai-directory"]',
  directoryItem: '[data-testid="ai-directory-item"]',
  directoryRefresh: '[data-testid="ai-directory-refresh"]',
  directoryError: '[data-testid="ai-directory-error"]',
};

/**
 * The server stub's fixed copy (`apps/server/src/ai/stub.ts`).
 *
 * Duplicated on purpose: this file cannot import a server bundle, and these sentences are the
 * proof that the draft crossed the HTTP boundary. A wording change on the server must fail this
 * suite, exactly like the frozen apply-failure sentences in `31-m3-ai.mjs`.
 */
const STUB = {
  wholeDocumentSummary: 'Stub provider: uppercased the whole document.',
  selectionSummary: 'Stub provider: uppercased the selected range.',
};

/** The frozen status lines this file needs (`aiProposalCopy.ts`, `aiDirectoryCopy.ts`). */
const COPY = {
  idle: 'No proposal yet.',
  proposal: 'Proposal ready',
  applied: 'Suggestion applied through a Yjs transaction',
  notConfigured: 'The AI provider is not configured on the server.',
  directoryUnavailable: 'The document list is unavailable.',
  remoteIdleHint: 'describe the edit you want',
};

/** A per-run marker, so a replica or a row from an earlier run can never satisfy an assertion. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The document text rebuilt from the server's own bytes (never "what the page shows"). */
async function durableText(ctx, documentId) {
  const { text } = await reconstructDurableDocument(ctx.stack.dataPath, documentId);
  return text;
}

/* ---------------------------------------------------------------------- *
 * The mode switch
 * ---------------------------------------------------------------------- */

/**
 * Set once per run: the stack is a process pair, so the switch is a restart, not a flag.
 *
 * Module-level state is sound here because the runner executes scenarios strictly serially and
 * this file sorts last.
 */
let remoteStackReady = false;

/**
 * Put the shared stack into the remote-AI configuration, once per run.
 *
 * Order matters:
 *
 * 1. stop Vite **first** (with a TCP-level port wait — `/health` would be answered by Vite's
 *    proxy to the backend, not by Vite itself), so no page can be served by the old bundle;
 * 2. stage `AI_PROVIDER=stub` and `VITE_AI_PROVIDER=remote`;
 * 3. restart the backend on a **fresh** durable directory, so this group's durable assertions
 *    cannot read a row another scenario wrote;
 * 4. start Vite again — it inlines `VITE_*` at module-transform time, so only a new process
 *    sees the new mode.
 */
async function ensureRemoteAiStack(ctx) {
  if (remoteStackReady) return ctx.stack;

  const stack = ctx.stack;
  await stack.stopWeb();
  stack.setServerEnv({ AI_PROVIDER: 'stub' });
  stack.setWebEnv({ VITE_AI_PROVIDER: 'remote' });
  const dataPath = await stack.createDataPath('m3r-remote');
  const { before, after } = await stack.restartServer({ dataPath });
  await stack.startWeb();

  assert(
    after !== before,
    'the remote mode must be a new backend process, not a reused one: the provider is chosen at startup',
  );
  remoteStackReady = true;

  ctx.note('remote AI stack', {
    serverPort: stack.serverPort,
    webPort: stack.webPort,
    serverPidBefore: before,
    serverPidAfter: after,
    dataPath,
    serverEnv: JSON.stringify(stack.extraServerEnv),
    webEnv: JSON.stringify(stack.extraWebEnv),
  });
  ctx.note('backend AI startup line', firstAiLine(stack.serverLog()));
  return stack;
}

/** The `[server] ai ...` line of a server log, for the report. */
function firstAiLine(log) {
  return log.split('\n').find((line) => line.includes('[server] ai')) ?? '<no [server] ai line>';
}

/** The server must have been started with the stub, and said so. */
function assertStubServer(ctx) {
  const line = firstAiLine(ctx.stack.serverLog());
  assertIncludes(line, 'ready  stub', 'the backend must report the stub provider at startup');
  assertIncludes(
    ctx.stack.serverLog(),
    'development/evidence only',
    'the stub startup warning must be present (it must never be a production default)',
  );
}

/* ---------------------------------------------------------------------- *
 * Reading the panel and the directory
 * ---------------------------------------------------------------------- */

const PANEL_SELECTORS = { ...AI };

/**
 * Every fact this file asserts, in one round trip.
 *
 * `phase` is `data-phase` on the section (the panel's own state machine); `providerError` is the
 * typed `data-provider-error`; directory facts are `data-state` / `data-directory-error` /
 * `aria-current`, all machine-readable attributes rather than English.
 */
async function readPanel(page) {
  return page.evaluate((selectors) => {
    const one = (selector) => document.querySelector(selector);
    const textOf = (selector) => one(selector)?.textContent?.trim() ?? null;
    const panel = one(selectors.panel);
    const proposal = one(selectors.proposal);
    const accept = one(selectors.accept);
    const status = one(selectors.status);
    const diff = one(selectors.diff);
    const directory = one(selectors.directory);
    const error = one(selectors.directoryError);
    const items = [...document.querySelectorAll(selectors.directoryItem)].map((item) => ({
      id: item.getAttribute('data-document-id'),
      current: item.getAttribute('aria-current'),
      title: (item.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }));
    return {
      open: panel !== null,
      phase: panel === null ? null : panel.getAttribute('data-phase'),
      intentCount: document.querySelectorAll(selectors.intent).length,
      status: textOf(selectors.status),
      providerError: status === null ? null : status.getAttribute('data-provider-error'),
      empty: textOf(selectors.empty),
      instruction: one(selectors.instruction)?.value ?? null,
      proposalPresent: proposal !== null,
      proposalStatus: proposal === null ? null : proposal.getAttribute('data-status'),
      baseRevision: proposal === null ? null : proposal.getAttribute('data-base-revision'),
      summary: textOf(selectors.summary),
      diff: diff === null ? null : diff.textContent,
      diffLength: diff === null ? 0 : (diff.textContent ?? '').length,
      acceptPresent: accept !== null,
      acceptDisabled: accept === null ? null : accept.disabled === true,
      directory: {
        present: directory !== null,
        state: directory === null ? null : directory.getAttribute('data-state'),
        items,
        itemCount: items.length,
        errorPresent: error !== null,
        errorKind: error === null ? null : error.getAttribute('data-directory-error'),
        errorText: error === null ? null : (error.textContent ?? '').replace(/\s+/g, ' ').trim(),
      },
    };
  }, PANEL_SELECTORS);
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
      throw new Error(`timed out waiting for ${label}; last panel state: ${JSON.stringify(last)}`);
    }
    await sleep(100);
  }
}

/** Poll only the directory part; used where opening the panel is not what is being measured. */
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
        `timed out waiting for ${label}; last directory state: ${JSON.stringify(last)}`,
      );
    }
    await sleep(100);
  }
}

/** Scroll an element into view, then click its centre with real mouse input. */
async function clickVisible(page, selector) {
  await page.evaluate((target) => {
    document.querySelector(target)?.scrollIntoView({ block: 'center', inline: 'center' });
  }, selector);
  await sleep(100);
  await page.click(selector);
}

/** Open the panel with the real "Ask AI" trigger and wait for its idle state. */
async function openPanel(page) {
  await clickVisible(page, AI.open);
  return waitForPanel(page, (state) => state.open && state.phase === 'idle', {
    label: 'the AI panel to open',
  });
}

/** Type a free-form instruction — the remote endpoint takes natural language (no chips exist). */
async function typeInstruction(page, instruction) {
  await clickVisible(page, AI.instruction);
  await page.insertText(instruction);
  const panel = await readPanel(page);
  assertEqual(panel.instruction, instruction, 'the instruction box must hold what was typed');
  return panel;
}

/** Click Generate and wait until the request settles as a proposal or a typed error. */
async function generate(page) {
  await clickVisible(page, AI.generate);
  return waitForPanel(page, (state) => state.phase === 'proposal' || state.phase === 'error', {
    label: 'Generate to settle (proposal or error)',
  });
}

/**
 * Select the whole document with the real keyboard (Ctrl+A → CodeMirror `selectAll`).
 *
 * This is load-bearing for the remote stub: a **collapsed** cursor is still sent as a
 * `selection: { from, to }` with `from === to`, and the stub uppercases the empty range, which
 * produces a proposal whose diff is empty (measured by the probe note in `m3r/1`; the local
 * provider normalises the collapsed case, the remote provider does not). A real selection is
 * what makes the preview and the Accept meaningful.
 */
async function selectWholeDocument(page, expectedLength) {
  await clickVisible(page, SELECTORS.editorContent);
  await page.pressKey('a', { modifiers: 2 });
  const state = await editorState(page);
  assertEqual(state.anchor, 0, 'Ctrl+A must place the selection anchor at the document start');
  assertEqual(
    state.head,
    expectedLength,
    'Ctrl+A must select the whole reviewed snapshot (the stub receives exactly this range)',
  );
  return state;
}

/* ---------------------------------------------------------------------- *
 * Network + API-call evidence
 * ---------------------------------------------------------------------- */

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

/** Poll the page's `/api/**` log until a matching call has an observed outcome. */
async function waitForApiCall(
  page,
  predicate,
  { timeoutMs = 15_000, label = 'the API call' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = (await readApiCalls(page)).filter(predicate);
    if (last.length > 0 && last.every((call) => call.status !== null || call.error !== null)) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}; observed calls: ${JSON.stringify(last)}`);
    }
    await sleep(100);
  }
}

/* ---------------------------------------------------------------------- *
 * Directory helpers
 * ---------------------------------------------------------------------- */

/**
 * Wait until the server lists every expected id for this session.
 *
 * A document becomes listable when an authorized join records its metadata (`registry.ts`
 * `#recordDocumentMeta`). That write is deliberately not awaited by the join, so a document that
 * was just opened can briefly be absent from `GET /api/documents`. This waits for the **server**
 * precondition and reads nothing from the product: the directory assertion below must still see
 * its own list, not this one.
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
        `timed out waiting for ${expectedIds.join(', ')} to be listed; last list: ${JSON.stringify(last)}`,
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
        `timed out waiting for the workspace to switch to ${documentId}; last active document: ${JSON.stringify(last)}`,
      );
    }
    await sleep(100);
  }
}

/* ---------------------------------------------------------------------- *
 * Registration — only in the explicit remote mode
 * ---------------------------------------------------------------------- */

const requestedMode = process.env.INSIGHTHUB_E2E_AI_MODE;

/**
 * Fail loudly on a typo instead of silently running the default 68.
 *
 * A mistyped mode would otherwise produce a green run that contains **no** remote evidence —
 * exactly the kind of false success this suite exists to prevent.
 */
if (requestedMode !== undefined && requestedMode !== 'remote') {
  throw new Error(
    `INSIGHTHUB_E2E_AI_MODE=${JSON.stringify(requestedMode)} is not supported; ` +
      'use "remote" (suite/33-m3-remote.mjs) or leave it unset to run the 68 default scenarios',
  );
}

export function register(runner) {
  // Default mode: this file contributes nothing. 68/68 stays 68/68.
  if (requestedMode !== 'remote') return;

  /* ================================================================== *
   * 1 — real HTTP → server stub draft → client anchors → preview → Accept
   * ================================================================== */
  runner.scenario(
    'm3r/1-remote-draft-preview-accept',
    'remote mode: no local intent chips; Generate POSTs /api/ai/suggest, the stub draft becomes a locally anchored proposal whose preview changes nothing, Accept writes the uppercase text through a Yjs transaction, Undo/Redo step over it',
    async (ctx) => {
      await ensureRemoteAiStack(ctx);
      assertStubServer(ctx);

      /*
       * A document id of this scenario's own, for two independent reasons:
       *
       * 1. the 68 default scenarios have already run in the same browser profile, and a
       *    `demo-*` document would be hydrated from **IndexedDB** — a stale replica from an
       *    earlier scenario turned the editor into 237 characters of someone else's text the
       *    first time this suite ran in full (caught by this suite, kept as a regression note);
       * 2. a fresh id makes "the durable text is exactly what this scenario typed" true.
       *
       * The membership row is arranged by `newAppPage` (the fixture writes into the current
       * `stack.dataPath`, which the group switch has already moved to the fresh store).
       */
      const documentId = `a6-m3r-accept-${marker('doc')}`;
      // Lower case on purpose: the stub's uppercase must be observable character by character.
      const baseText = `remote draft ${marker('base')}`;
      const upperText = baseText.toUpperCase();

      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });

      await typeInEditor(page, baseText);
      const typed = await waitForEditorText(page, (text) => text === baseText, {
        label: 'the locally typed baseline',
      });
      const durableBase = await waitForDurableText(
        ctx.stack.dataPath,
        documentId,
        (text) => text === baseText,
        { label: 'the baseline to be durable' },
      );
      ctx.note('baseline', {
        documentId,
        editorText: JSON.stringify(typed.text),
        durableText: JSON.stringify(durableBase),
        expectedUppercase: JSON.stringify(upperText),
      });

      /* ---------- the panel opens in remote mode: no chips ---------- */
      const idle = await openPanel(page);
      ctx.note('panel opened', {
        phase: idle.phase,
        status: idle.status,
        intentCount: idle.intentCount,
        empty: idle.empty,
        directoryState: idle.directory.state,
      });
      assertEqual(
        idle.intentCount,
        0,
        'remote mode must not render the local-provider intent chips (their vocabulary is local-only)',
      );
      assertEqual(idle.status, COPY.idle, 'the idle status line must say no proposal exists yet');
      assertIncludes(
        idle.empty,
        COPY.remoteIdleHint,
        'the idle hint must be the remote copy (describe the edit), not the chip hint',
      );

      /* ---------- probe: a collapsed cursor is still a "selection" on this path ---------- */
      await typeInstruction(page, 'uppercase this document');
      const collapsed = await generate(page);
      ctx.note('collapsed-cursor remote probe', {
        phase: collapsed.phase,
        providerError: collapsed.providerError,
        diffLength: collapsed.diffLength,
        summary: collapsed.summary,
      });
      if (collapsed.phase === 'proposal') {
        // Evidence only: a zero-length selection makes the stub return a zero-length replace,
        // whose preview is empty. Reject it and continue with a real selection. (The gap is
        // reported to A0; `apps/**` is outside this round's file scope.)
        await clickVisible(page, AI.reject);
        await waitForPanel(page, (state) => state.phase === 'rejected', {
          label: 'the collapsed-cursor probe proposal to be rejected',
        });
      }

      /* ---------- a real selection covering the whole reviewed snapshot ---------- */
      const selection = await selectWholeDocument(page, baseText.length);
      ctx.note('selection', { anchor: selection.anchor, head: selection.head });

      const proposal = await generate(page);
      assertEqual(
        proposal.phase,
        'proposal',
        `the remote stub must produce a proposal (data-provider-error: ${proposal.providerError})`,
      );
      assertEqual(proposal.intentCount, 0, 'still remote: no chips after generation');
      assertEqual(proposal.proposalStatus, 'pending', 'a fresh proposal must be marked pending');
      assertEqual(
        proposal.baseRevision,
        '0',
        'data-base-revision must be the client-local revision the draft was anchored at',
      );
      assertEqual(proposal.acceptPresent, true, 'a pending proposal must offer Accept');
      assertEqual(proposal.acceptDisabled, false, 'Accept must be enabled for a pending proposal');
      assert(
        typeof proposal.summary === 'string' && proposal.summary.trim().length > 0,
        'ai-summary must be non-empty — the proposal has to say what it would do',
      );
      assertEqual(
        proposal.summary,
        STUB.selectionSummary,
        'the summary must be the server stub sentence (this string does not exist in the browser bundle)',
      );
      assert(
        typeof proposal.diff === 'string' && proposal.diff.trim().length > 0,
        'ai-diff must be non-empty — the Diff Preview has to show the change',
      );
      assertIncludes(proposal.diff, '+++ ', 'the preview must be a unified diff (+++ header)');
      assertIncludes(proposal.diff, '@@ ', 'the preview must carry a hunk header (@@)');
      ctx.note('proposal', {
        summary: proposal.summary,
        diffLength: proposal.diffLength,
        baseRevision: proposal.baseRevision,
        status: proposal.status,
        instruction: proposal.instruction,
        diffPreview: proposal.diff.slice(0, 400),
      });

      /* ---------- the request really crossed HTTP, and the server really answered 200 ------- */
      const suggestCalls = await waitForApiCall(
        page,
        (call) => call.method === 'POST' && call.path === '/api/ai/suggest',
        { label: 'POST /api/ai/suggest to be recorded' },
      );
      ctx.note(
        'POST /api/ai/suggest calls',
        suggestCalls.map((call) => ({ status: call.status, error: call.error, t: call.t })),
      );
      assert(
        suggestCalls.every((call) => call.status === 200),
        `every remote Generate must be answered 200 by the stub, got ${JSON.stringify(
          suggestCalls.map((call) => call.status),
        )}`,
      );

      /* ---------- nothing changed before Accept ---------- */
      await sleep(1_500);
      const beforeAccept = await editorState(page);
      const durableBeforeAccept = await durableText(ctx, documentId);
      ctx.note('before Accept', {
        editorText: JSON.stringify(beforeAccept.text),
        durableText: JSON.stringify(durableBeforeAccept),
        phase: (await readPanel(page)).phase,
      });
      assertEqual(
        beforeAccept.text,
        baseText,
        'generating a proposal must not change the editor (a proposal is not state)',
      );
      assertEqual(
        durableBeforeAccept,
        baseText,
        'generating a proposal must not change the durable document',
      );

      /* ---------- Accept: the one write ---------- */
      await clickVisible(page, AI.accept);
      const applied = await waitForEditorText(page, (text) => text === upperText, {
        label: 'the accepted proposal in the editor',
      });
      const durableApplied = await waitForDurableText(
        ctx.stack.dataPath,
        documentId,
        (text) => text === upperText,
        { label: 'the accepted proposal in the durable document' },
      );
      const afterAccept = await waitForPanel(
        page,
        (state) => state.phase === 'applied' && state.proposalPresent === false,
        { label: 'the applied phase' },
      );
      ctx.note('after Accept', {
        editorText: JSON.stringify(applied.text),
        durableText: JSON.stringify(durableApplied),
        phase: afterAccept.phase,
        status: afterAccept.status,
      });
      assertEqual(applied.text, upperText, 'Accept must apply the stub draft to the editor');
      assertEqual(
        durableApplied,
        upperText,
        'Accept must persist the stub draft through a Yjs transaction — character for character',
      );
      assertIncludes(afterAccept.status, COPY.applied, 'the status must report the real apply');
      assertEqual(afterAccept.proposalPresent, false, 'an applied proposal must be cleared');

      /* ---------- Undo / Redo ---------- */
      const buttonsAfterAccept = await readHistoryButtons(page);
      ctx.note('history buttons after Accept', buttonsAfterAccept);
      assertEqual(
        buttonsAfterAccept.undo.disabled,
        false,
        'an accepted AI edit must be undoable (UNDO_TRACKED_ORIGINS contains `ai`)',
      );

      // `clickVisible` because the scenario scrolled the editor into view for Ctrl+A; a plain
      // viewport click on the header button would land outside the viewport and do nothing.
      await clickVisible(page, SELECTORS.undoButton);
      const undone = await waitForEditorText(page, (text) => text === baseText, {
        label: 'Undo to revert the AI edit',
      });
      const durableUndone = await waitForDurableText(
        ctx.stack.dataPath,
        documentId,
        (text) => text === baseText,
        { label: 'Undo to revert the AI edit in the durable document' },
      );
      assertEqual(
        undone.text,
        baseText,
        'Undo must revert the AI edit and keep the typed baseline',
      );
      assertEqual(durableUndone, baseText, 'Undo must revert the AI transaction, not a snapshot');
      assertIncludes(
        (await readUndoState(page)) ?? '',
        'redo: available',
        'the undone AI edit must be redoable',
      );
      ctx.note('after Undo', {
        editorText: JSON.stringify(undone.text),
        durableText: JSON.stringify(durableUndone),
        undoState: await readUndoState(page),
      });

      await clickVisible(page, SELECTORS.redoButton);
      const redone = await waitForEditorText(page, (text) => text === upperText, {
        label: 'Redo to restore the AI edit',
      });
      const durableRedone = await waitForDurableText(
        ctx.stack.dataPath,
        documentId,
        (text) => text === upperText,
        { label: 'Redo to restore the AI edit in the durable document' },
      );
      ctx.note('after Redo', {
        editorText: JSON.stringify(redone.text),
        durableText: JSON.stringify(durableRedone),
      });
      assertEqual(redone.text, upperText, 'Redo must restore the accepted AI edit');
      assertEqual(durableRedone, upperText, 'Redo must restore it in the durable document');
    },
  );

  /* ================================================================== *
   * 2 — no server provider: fail closed, no proposal, no Accept, no write
   * ================================================================== */
  runner.scenario(
    'm3r/2-remote-provider-unconfigured',
    'remote client + default server (AI_PROVIDER unset): Generate gets 503, the panel shows the typed not-configured error, renders no proposal and no Accept, and neither the editor nor the durable text changes',
    async (ctx) => {
      await ensureRemoteAiStack(ctx);

      // Flip the backend to the **frozen default** configuration: no `AI_PROVIDER` at all.
      // (`undefined` deletes the key, including one inherited from the parent shell.)
      ctx.stack.setServerEnv({ AI_PROVIDER: undefined });
      const { before, after } = await ctx.stack.restartServer();
      assert(
        after !== before,
        'the unconfigured server must be a new process (provider chosen at startup)',
      );
      try {
        const startupLine = firstAiLine(ctx.stack.serverLog());
        ctx.note('backend AI startup line (unconfigured)', startupLine);
        assertIncludes(
          startupLine,
          'disabled',
          'AI_PROVIDER unset must leave the provider disabled',
        );
        assert(
          !ctx.stack.serverLog().includes('ready  stub'),
          'the unconfigured server must not fall back to the stub (there is no silent fallback)',
        );

        // Its own document id: the shared browser profile must not hydrate this page from an
        // earlier scenario's IndexedDB replica (see `m3r/1`).
        const documentId = `a6-m3r-unconfigured-${marker('doc')}`;
        const baseText = `unconfigured ${marker('base')}`;
        const page = await ctx.newAppPage({ documentId });
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });

        await typeInEditor(page, baseText);
        await waitForEditorText(page, (text) => text === baseText, {
          label: 'the locally typed baseline',
        });
        await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === baseText, {
          label: 'the baseline to be durable',
        });

        const idle = await openPanel(page);
        assertEqual(
          idle.intentCount,
          0,
          'the client is remote even though the server has no provider',
        );
        await typeInstruction(page, 'uppercase this document');

        const failed = await generate(page);
        ctx.note('after Generate (503)', {
          phase: failed.phase,
          providerError: failed.providerError,
          status: failed.status,
          proposalPresent: failed.proposalPresent,
          acceptPresent: failed.acceptPresent,
          diff: failed.diff,
        });
        assertEqual(failed.phase, 'error', 'a 503 must leave the panel in its error phase');
        assertEqual(
          failed.providerError,
          'not-configured',
          'the 503 must map to the typed not-configured kind (fail closed, not a generic failure)',
        );
        assertEqual(
          failed.status,
          COPY.notConfigured,
          'the error line must explain that the server has no AI provider',
        );
        assertEqual(
          failed.proposalPresent,
          false,
          'a failed request must never render a proposal (no partial draft)',
        );
        assertEqual(
          failed.acceptPresent,
          false,
          'there must be no Accept control to click when there is no proposal',
        );
        assertEqual(failed.diff, null, 'no diff preview may exist after a failed request');

        const suggestCalls = await waitForApiCall(
          page,
          (call) => call.method === 'POST' && call.path === '/api/ai/suggest',
          { label: 'POST /api/ai/suggest to be recorded' },
        );
        ctx.note(
          'POST /api/ai/suggest calls',
          suggestCalls.map((call) => ({ status: call.status, error: call.error, t: call.t })),
        );
        assertEqual(
          suggestCalls.length,
          1,
          'exactly one request must have been attempted for one Generate click',
        );
        assertEqual(
          suggestCalls[0].status,
          503,
          'the endpoint must answer 503 ai_provider_not_configured when AI_PROVIDER is unset',
        );

        // Give a wrongly-writing implementation every chance to show it.
        await sleep(1_500);
        const afterFailure = await editorState(page);
        const durableAfter = await durableText(ctx, documentId);
        ctx.note('after the failed Generate', {
          editorText: JSON.stringify(afterFailure.text),
          durableText: JSON.stringify(durableAfter),
        });
        assertEqual(afterFailure.text, baseText, 'a failed request must not change the editor');
        assertEqual(
          durableAfter,
          baseText,
          'a failed request must not change the durable document',
        );
      } finally {
        // Restore the group's configuration. The next start (this restart, or the runner's
        // afterEach) must not leave the backend unconfigured for a later scenario.
        ctx.stack.setServerEnv({ AI_PROVIDER: 'stub' });
        await ctx.stack.restartServer();
      }
    },
  );

  /* ================================================================== *
   * 3 — the read-only AI directory, and the switch it performs
   * ================================================================== */
  runner.scenario(
    'm3r/3-ai-directory',
    'opening the panel lists the documents this identity may read with the current one marked aria-current; selecting another readable document switches the workspace and closes the panel, and reopening follows the new document',
    async (ctx) => {
      await ensureRemoteAiStack(ctx);

      // Scenario-owned ids: the shared profile may hold earlier documents' replicas, and a
      // directory test must not depend on what another scenario happened to type.
      const activeId = `a6-m3r-dir-active-${marker('doc')}`;
      const otherId = `a6-m3r-dir-other-${marker('doc')}`;

      /*
       * The directory's list is server truth (`GET /api/documents`), and a document becomes
       * listable only after an authorized join records its metadata. Opening `otherId` once is
       * therefore precondition setup, not a shortcut: the scenario still asserts that the panel's
       * own request returned both rows.
       */
      const warm = await ctx.newAppPage({ documentId: otherId });
      await waitForConnectionStatus(warm, 'connected', { timeoutMs: 30_000 });
      await warm.close();

      const page = await ctx.newAppPage({ documentId: activeId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      const listed = await waitForDocumentList(page, [activeId, otherId]);
      ctx.note('server document list', listed);

      /* ---------- first open: ready, with the active document marked ---------- */
      await openPanel(page);
      const directory = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory to reach data-state=ready',
      });
      ctx.note('directory', {
        state: directory.state,
        itemCount: directory.itemCount,
        items: directory.items,
      });
      assertEqual(directory.present, true, 'the panel must render the ai-directory section');
      assert(
        directory.itemCount >= 2,
        `the directory must list every readable document (got ${directory.itemCount}: ${JSON.stringify(
          directory.items,
        )})`,
      );
      assertEqual(directory.errorPresent, false, 'the ready state must not carry an error block');
      const currentMarkers = directory.items.filter((item) => item.current === 'true');
      assertEqual(
        currentMarkers.length,
        1,
        'exactly one row must be marked aria-current (the active document)',
      );
      assertEqual(
        currentMarkers[0].id,
        activeId,
        'the current row must be the document this workspace is pointed at',
      );

      /* ---------- selecting another readable document switches the workspace ---------- */
      await clickVisible(page, `${AI.directoryItem}[data-document-id="${otherId}"]`);
      const switched = await waitForActiveDocument(page, otherId);
      await waitForPanel(page, (state) => state.open === false, {
        label: 'the AI panel to disappear when the document switch remounts the workspace',
      });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      ctx.note('after selecting another document', {
        activeDocument: switched,
        panelPresent: (await readPanel(page)).open,
      });
      assertEqual(switched, otherId, 'selecting a directory row must switch the workspace');

      /* ---------- reopening follows the new active document ---------- */
      const reopened = await openPanel(page);
      const directoryAfter = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory after reopening',
      });
      const currentAfter = directoryAfter.items.filter((item) => item.current === 'true');
      ctx.note('directory after reopening', {
        state: directoryAfter.state,
        itemCount: directoryAfter.itemCount,
        items: directoryAfter.items,
        panelPhase: reopened.phase,
      });
      assertEqual(
        currentAfter.length,
        1,
        'exactly one row must be aria-current after reopening the panel',
      );
      assertEqual(
        currentAfter[0].id,
        otherId,
        'the current row must follow the new active document, not the previous one',
      );
      assertEqual(
        directoryAfter.errorPresent,
        false,
        'reopening on a reachable server must not show a directory error',
      );
    },
  );

  /* ================================================================== *
   * 4 — offline directory: a real network failure, no cached rows, recovery
   * ================================================================== */
  runner.scenario(
    'm3r/4-ai-directory-offline',
    'going offline at the browser network layer makes the directory data-state=error with data-directory-error=network and no rows; restoring the network and pressing Refresh returns it to ready',
    async (ctx) => {
      await ensureRemoteAiStack(ctx);

      const documentId = `a6-m3r-dir-offline-${marker('doc')}`;
      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      // The join records this document's metadata without awaiting it; wait for the server
      // precondition so the first directory fetch cannot race an empty list.
      await waitForDocumentList(page, [documentId]);

      await openPanel(page);
      const ready = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory to reach data-state=ready',
      });
      ctx.note('directory before going offline', {
        state: ready.state,
        itemCount: ready.itemCount,
        items: ready.items,
      });
      assert(
        ready.itemCount >= 1,
        'the directory must have loaded at least one row before the offline probe means anything',
      );
      assertEqual(ready.errorPresent, false, 'the ready state must not carry an error block');

      /**
       * The `/api/documents` calls this page has made.
       *
       * The count is snapshotted before each phase so the phase's own calls can be asserted
       * exactly. Without the snapshot, an earlier successful `200` would satisfy "a failed
       * request happened" and an earlier abortion would satisfy "the offline request failed" —
       * a false-success path this suite exists to exclude.
       */
      const documentCalls = async () =>
        (await readApiCalls(page)).filter(
          (call) => call.method === 'GET' && call.path === '/api/documents',
        );

      /* ---------- real offline: CDP network emulation, not the socket shim ---------- */
      const callsBeforeOffline = (await documentCalls()).length;
      await setBrowserNetworkOffline(page, true);
      try {
        await clickVisible(page, AI.directoryRefresh);
        const failed = await waitForDirectory(page, (state) => state.state === 'error', {
          label: 'the directory to reach data-state=error while offline',
        });
        ctx.note('directory offline', {
          state: failed.state,
          errorKind: failed.errorKind,
          errorText: failed.errorText,
          itemCount: failed.itemCount,
          items: failed.items,
        });
        assertEqual(
          failed.errorKind,
          'network',
          'an unreachable server must surface as the typed network failure, not as an empty list',
        );
        assertIncludes(
          failed.errorText,
          COPY.directoryUnavailable,
          'the error copy must say the list is unavailable (and never pretend it is empty)',
        );
        assertEqual(
          failed.itemCount,
          0,
          'the error state must not render any document row — there is no cached list to show',
        );
        assertEqual(
          failed.items.length,
          0,
          'no ai-directory-item may exist while the list request has failed',
        );

        const offlineCalls = (await documentCalls()).slice(callsBeforeOffline);
        ctx.note(
          'GET /api/documents calls while offline',
          offlineCalls.map((call) => ({ status: call.status, error: call.error, t: call.t })),
        );
        assert(
          offlineCalls.length >= 1,
          'the offline Refresh must have attempted a `GET /api/documents`',
        );
        assert(
          offlineCalls.every((call) => call.status === null),
          `no directory request may have received an HTTP answer while the network was offline; got ${JSON.stringify(
            offlineCalls.map((call) => call.status),
          )}`,
        );
        assert(
          offlineCalls.some((call) => call.error !== null),
          'the offline refresh must be recorded as a failed network call, not a successful one',
        );
      } finally {
        await setBrowserNetworkOffline(page, false);
      }

      /* ---------- recovery: the same button, a real 200 ---------- */
      const callsBeforeRecovery = (await documentCalls()).length;
      await clickVisible(page, AI.directoryRefresh);
      const recovered = await waitForDirectory(page, (state) => state.state === 'ready', {
        label: 'the directory to return to data-state=ready',
      });
      ctx.note('directory after recovery', {
        state: recovered.state,
        itemCount: recovered.itemCount,
        items: recovered.items,
        errorPresent: recovered.errorPresent,
      });
      assert(
        recovered.itemCount >= 1,
        'the recovered directory must list the readable documents again',
      );
      assertEqual(
        recovered.errorPresent,
        false,
        'the recovered state must not keep the error block',
      );

      const recoveredCalls = (await documentCalls()).slice(callsBeforeRecovery);
      ctx.note(
        'GET /api/documents calls after recovery',
        recoveredCalls.map((call) => ({ status: call.status, error: call.error, t: call.t })),
      );
      assertEqual(
        recoveredCalls.length,
        1,
        'pressing Refresh once must issue exactly one `GET /api/documents`',
      );
      assertEqual(
        recoveredCalls[0].status,
        200,
        'the recovered refresh must be a real 200 from the server',
      );
    },
  );

  /**
   * A collapsed caret is not a selection.
   *
   * A6's round-2 probe found that the panel sent `selection: {from, to}` with `from === to` in
   * remote mode, the stub "uppercased" that empty range, and the user got an Accept-able proposal
   * whose diff was empty — "AI looks like it did something" with nothing to review. The fix makes
   * the remote provider omit a collapsed selection, so the stub sees the whole document instead.
   * This scenario keeps that from regressing: the proposal must be non-empty and Accept must
   * actually change the document.
   */
  runner.scenario(
    'm3r/5-collapsed-caret-is-not-an-empty-proposal',
    'remote mode: generating with a collapsed caret sends no selection, so the proposal is non-empty and Accept writes the uppercase text',
    async (ctx) => {
      await ensureRemoteAiStack(ctx);
      assertStubServer(ctx);

      const documentId = `a6-m3r-caret-${marker('doc')}`;
      const baseText = `caret only ${marker('base')}`;
      const upperText = baseText.toUpperCase();

      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });

      // Typing leaves the caret *collapsed* at the end of the document: no selection.
      await typeInEditor(page, baseText);
      await waitForEditorText(page, (text) => text === baseText, {
        label: 'the locally typed baseline',
      });
      await waitForDurableText(ctx.stack.dataPath, documentId, (text) => text === baseText, {
        label: 'the baseline to be durable',
      });

      await openPanel(page);
      await typeInstruction(page, 'uppercase');
      await generate(page);

      const proposal = await waitForPanel(page, (state) => state.phase === 'proposal', {
        label: 'a proposal from the server draft',
      });
      ctx.note('proposal for a collapsed caret', {
        summary: proposal.summary,
        diffLength: proposal.diffLength,
      });
      assert(
        proposal.diffLength > 0,
        'a collapsed caret must not produce an empty diff — the proposal must show a real change',
      );

      await clickVisible(page, AI.accept);
      const applied = await waitForDurableText(
        ctx.stack.dataPath,
        documentId,
        (text) => text === upperText,
        { label: 'Accept to write the uppercase text through the Yjs transaction' },
      );
      ctx.note('durable after Accept', { durable: JSON.stringify(applied) });
      assertEqual(applied, upperText, 'Accept must actually change the durable document');
    },
  );
}
