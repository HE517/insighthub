/**
 * A6 Evidence Gate, round 2 (`docs/DECISIONS.md` D-086) — the two claims that were
 * `NOT VERIFIED` in the phase-1 inventory (`docs/agent-governance/CAPABILITY-EVIDENCE-INVENTORY.md`):
 *
 * | Inventory item | Scenario | What it adds |
 * | --- | --- | --- |
 * | **A1** "two **completely independent** browser contexts edit concurrently" | `collab/independent-contexts` | two `Target.createBrowserContext` contexts (separate cookies, `localStorage`, IndexedDB), insert/delete/replace, A = B = server text **and** equal state-vector digests |
 * | **C2** "document switch: A delayed → switch to B → B answers first → A arrives late" | `stale/directory-list` | the measured answer is that **no document-metadata HTTP request exists on the client**; the closest real stale path (`AiDirectory`'s `GET /api/documents`, which *is* cancellable) is delayed through CDP `Fetch`, the document is switched inside the window, and the late response is proven unable to override anything |
 *
 * ## Why `realtime/two-tabs-converge` could not be reused for A1
 *
 * Two tabs in one profile share one cookie jar, one `localStorage` and one IndexedDB replica. They
 * are two views of **one** client, so they can converge through mechanisms (a shared replica, a
 * shared session) that say nothing about two people. The new scenario opens each page in a
 * context created by `Target.createBrowserContext`, gives each its own demo identity and its own
 * membership row, and then proves the partition (a `localStorage` write in A is invisible in B;
 * the two session cookies are different tokens).
 *
 * ## What the state-vector digest adds
 *
 * Equal text is necessary but not sufficient: two replicas can show the same string while one of
 * them still holds structs the other has not integrated. `window.__qa.docStateVector()` (page
 * instrumentation, no product change) returns `sha256(Y.encodeStateVector(doc))`, which is
 * per-client clock state, i.e. the actual CRDT state. Equal digests across A, B **and** the
 * Node-side `WireOracle` are the "server-final-state equality" claim. Only the digest, the byte
 * length, the client count and the document length are recorded — never the body.
 *
 * ## Concurrency, deterministically
 *
 * Each participant edits a **disjoint region** (A the front, B the tail) with real keyboard input,
 * and the two participants' operations are started together (`Promise.all`), so they overlap in
 * time while the final text cannot depend on the interleaving order. The regions are chosen so
 * that a remote update landing mid-selection only shifts positions the editor already maps
 * correctly (CodeMirror maps the selection through the transaction), which is what makes the
 * expected text exact rather than "whatever converges".
 */
import {
  caretToEnd,
  caretToStart,
  describeIndexedDb,
  editorState,
  moveCaret,
  readApiCalls,
  readIndexedDb,
  readPageDiagnostics,
  setDocumentId,
  waitForConnectionStatus,
  waitForEditorText,
} from '../lib/app.mjs';
import { sleep } from '../lib/cdp.mjs';
import { assert, assertEqual } from '../lib/harness.mjs';
import { describeDivergence, WireOracle } from '../lib/oracle.mjs';

/** The identities the scenario gives the two contexts (never `demo-linus`, who owns neither). */
const AUTHOR = 'demo-ada';
const REVIEWER = 'demo-grace';

/* -------------------------------------------------------------------- *
 * Shared helpers (evidence-shaped, so a failure explains itself)
 * -------------------------------------------------------------------- */

/**
 * One page's workspace facts, read in a single round trip: the document the header points at, the
 * text the **live editor** holds, whether the AI panel is mounted, the connection badge and any
 * visible failure banner.
 */
async function readWorkspaceFacts(page) {
  const probe = await page.evaluate(() => {
    const state = window.__qa?.probe?.state?.() ?? null;
    return {
      activeDocument: document.querySelector('[data-testid="active-document"]')?.textContent?.trim() ?? null,
      editorText: state === null ? null : state.text,
      editorLength: state === null ? null : state.length,
      viewId: state === null ? null : state.viewId,
      connectionStatus:
        document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null,
      directoryPresent: document.querySelector('[data-testid="ai-directory"]') !== null,
      directoryState:
        document.querySelector('[data-testid="ai-directory"]')?.getAttribute('data-state') ?? null,
      directoryError:
        document.querySelector('[data-testid="ai-directory-error"]')?.textContent?.trim() ?? null,
      sessionFailed: document.querySelector('[data-testid="session-failed"]')?.textContent ?? null,
      identity: document.querySelector('[data-testid="session-identity"]')?.textContent?.trim() ?? null,
      claimedDemoIdentity: window.__qa?.demoIdentity ?? null,
      roleChip:
        [...document.querySelectorAll('span')]
          .map((node) => (node.textContent ?? '').trim())
          .find((text) => /^role:\s*\S+$/.test(text)) ?? null,
    };
  });
  return probe;
}

/** The directory rows as rendered: document id + `aria-current` marker. */
async function readDirectoryRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="ai-directory-item"]')].map((node) => ({
      id: node.getAttribute('data-document-id'),
      current: node.getAttribute('aria-current') === 'true',
      title: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
  );
}

/**
 * Absolute (wall-clock) window of one page's recorded editor **edits**.
 *
 * `qa.probe.transactions[i].t` is page-relative, but both renderers run on the same machine clock,
 * so `qa.startedAt + t` is comparable across pages. That is what turns "the two clients were
 * editing at the same time" from a narration into a measurement. Selection-only updates (the
 * probe also records transactions with no change) are kept in `transactions` but excluded from
 * `editWindow`, so the window is the time span in which text actually changed.
 *
 * `since` slices off the transactions of an earlier round, so round 2's window cannot be
 * contaminated by round 1's.
 */
async function readEditWindow(page, { since = 0 } = {}) {
  return page.evaluate((from) => {
    const qa = window.__qa;
    const all = (qa?.probe?.transactions ?? []).map((entry) => ({ ...entry }));
    const transactions = all.slice(from);
    const edits = transactions.filter(
      (entry) => (entry.inserted ?? 0) > 0 || (entry.deleted ?? 0) > 0,
    );
    const absolute = edits.map((entry) => qa.startedAt + entry.t);
    return {
      startedAt: qa.startedAt,
      pageNow: Date.now() - qa.startedAt,
      total: all.length,
      transactions,
      edits,
      editWindow: absolute.length === 0 ? null : [Math.min(...absolute), Math.max(...absolute)],
    };
  }, since);
}

/**
 * Type `text` as **separate real keystrokes**, one `Input.insertText` per character.
 *
 * Why the concurrent-editing scenario types this way: each character becomes its own Yjs
 * transaction, so a participant's edit *stream* lasts tens of milliseconds instead of one. That is
 * what makes "the two clients were editing at the same time" measurable (the two streams have to
 * overlap) instead of depending on two single keystrokes landing in the same millisecond — and it
 * is also the more interesting case, because remote updates then arrive in the middle of a local
 * stream.
 */
async function typePerCharacter(page, text) {
  for (const character of text) {
    await page.insertText(character);
  }
}

/** Whether two `[from, to]` windows (or `null`) overlap. */
function overlaps(first, second) {
  return (
    first !== null && second !== null && first[0] <= second[1] && second[0] <= first[1]
  );
}

/** The page's own `/api/**` log entry for one request start (`t`), or `null`. */
async function findApiCall(page, path, requestT) {
  const calls = await readApiCalls(page);
  return calls.find((call) => call.path === path && call.t === requestT) ?? null;
}

/**
 * Wait until the page's own request log shows `path` started at `requestT` as **settled**
 * (either a status or an error). Conditional polling, never a fixed sleep.
 */
async function waitForApiCallSettled(page, { path, requestT, timeoutMs = 8_000 }) {
  const deadline = Date.now() + timeoutMs;
  let entry = null;
  for (;;) {
    entry = await findApiCall(page, path, requestT);
    if (entry !== null && (entry.status !== null || entry.error !== null)) {
      const observedAt = await page.evaluate(() => Date.now() - window.__qa.startedAt);
      return { entry, observedAt };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the ${path} request started at t=${requestT}ms never settled within ${timeoutMs}ms ` +
          `(entry: ${JSON.stringify(entry)})`,
      );
    }
    await sleep(25);
  }
}

/**
 * Wait until the two pages' editors **and** the server-side witness hold exactly `expected`.
 *
 * Conditional polling with a diagnostic that names all three sides and the first divergence, so a
 * failure says *what* did not converge instead of "timed out".
 */
async function waitForThreeWayConvergence({ pageA, pageB, oracle, expected, timeoutMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  let stateA = null;
  let stateB = null;
  for (;;) {
    stateA = await editorState(pageA);
    stateB = await editorState(pageB);
    if (stateA.text === expected && stateB.text === expected && oracle.text === expected) {
      return { stateA, stateB, oracleText: oracle.text };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the three replicas did not converge within ${timeoutMs}ms: ` +
          `A ${stateA.text.length} chars, B ${stateB.text.length} chars, ` +
          `server witness ${oracle.text.length} chars; ` +
          `A vs B: ${describeDivergence(stateA.text, stateB.text)}; ` +
          `A vs expected: ${describeDivergence(expected, stateA.text)}; ` +
          `B vs expected: ${describeDivergence(expected, stateB.text)}; ` +
          `witness vs expected: ${describeDivergence(expected, oracle.text)}`,
      );
    }
    await sleep(150);
  }
}

/**
 * Wait until both pages report the **same** state-vector digest.
 *
 * Separated from text convergence on purpose: the text can be equal one poll before the last
 * update is integrated, and the digest is what says "the CRDT state is identical".
 */
async function waitForEqualStateVectors(pageA, pageB, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let vectorA = null;
  let vectorB = null;
  for (;;) {
    vectorA = await pageA.evaluate(() => window.__qa.docStateVector());
    vectorB = await pageB.evaluate(() => window.__qa.docStateVector());
    if (vectorA?.ok === true && vectorB?.ok === true && vectorA.hash === vectorB.hash) {
      return { vectorA, vectorB };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the two state vectors never matched within ${timeoutMs}ms: A=${JSON.stringify(vectorA)} ` +
          `B=${JSON.stringify(vectorB)}`,
      );
    }
    await sleep(150);
  }
}

export function register(runner) {
  /* ================================================================== *
   * A — two independent browser contexts, concurrent editing, convergence
   * ================================================================== */
  runner.scenario(
    'collab/independent-contexts',
    'two independent browser contexts (separate cookies/storage/IndexedDB) edit one document concurrently and converge, with equal state-vector digests',
    async (ctx) => {
      const documentId = 'a6-collab-independent';
      /**
       * The seeded body and the exact expected result.
       *
       * A owns the **front** region: it inserts `FRONT_MARKER` and then deletes `DELETED_TOKEN`
       * forwards. B owns the **tail**: it inserts `TAIL_MARKER`, then selects `REPLACED_TOKEN`
       * with one word-selection keystroke and types the replacement. The two regions never
       * overlap, so the final text is a constant of the edits and not of the interleaving.
       *
       * Both tokens are **one word** of word characters (no `-`, no `|`), so
       * `Ctrl+Shift+ArrowLeft` selects exactly the token in a single real key press.
       */
      const DELETED_TOKEN = 'ALPHA1122334455667788';
      const REPLACED_TOKEN = 'OMEGA9988776655443322';
      const FRONT_MARKER = '[A-FRONT-2026]';
      const TAIL_MARKER = '[B-BACK-2026]';
      const REPLACEMENT = '[B-OMEGA-REPLACED-20]';
      const BASELINE = `${DELETED_TOKEN}|middle|${REPLACED_TOKEN}`;
      const EXPECTED = `${FRONT_MARKER}|middle|${REPLACEMENT}${TAIL_MARKER}`;
      assertEqual(DELETED_TOKEN.length, REPLACED_TOKEN.length, 'the two seeded tokens must match in length');

      // 1. The authorization fixture seeds exactly two members of the same document. This is a
      //    test fixture arming `docs/CONTRACTS.md` §17 membership; it is not a product seed.
      const memberA = await ctx.authz.grant(documentId, AUTHOR, 'editor');
      const memberB = await ctx.authz.grant(documentId, REVIEWER, 'owner');
      ctx.note('seeded memberships', { A: memberA, B: memberB });

      // 2. A real Yjs peer on the real server: it writes the baseline *before* the pages open and
      //    stays connected as the independent convergence witness (it shares no code with the
      //    browser client). It publishes no awareness, so it cannot perturb presence.
      const witness = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'witness',
        userId: REVIEWER,
        role: 'owner',
      });
      try {
        witness.replaceAll(BASELINE);
        ctx.note('baseline written by the witness peer', {
          characters: BASELINE.length,
          tokenLength: DELETED_TOKEN.length,
        });

        // 3. Two **independent browser contexts**, each with its own cookie jar, storage and
        //    IndexedDB partition. Two tabs in one profile would not be two clients.
        const contextA = await ctx.newBrowserContext();
        const contextB = await ctx.newBrowserContext();
        ctx.note('browser contexts', {
          A: contextA,
          B: contextB,
          distinct: contextA !== contextB,
        });

        const pageA = await ctx.newAppPage({
          documentId,
          as: AUTHOR,
          // The scenario already stated both roles above; `null` keeps the harness from writing
          // any membership row of its own (D-065 §5, A6 F3).
          role: null,
          browserContextId: contextA,
        });
        const pageB = await ctx.newAppPage({
          documentId,
          as: REVIEWER,
          role: null,
          browserContextId: contextB,
        });

        await waitForConnectionStatus(pageA, 'connected', { timeoutMs: 30_000 });
        await waitForConnectionStatus(pageB, 'connected', { timeoutMs: 30_000 });
        const baselineA = await waitForEditorText(pageA, (text) => text === BASELINE, {
          label: 'the seeded baseline in context A',
        });
        const baselineB = await waitForEditorText(pageB, (text) => text === BASELINE, {
          label: 'the seeded baseline in context B',
        });
        ctx.note('baseline loaded in both editors', {
          A: { length: baselineA.length, viewId: baselineA.viewId },
          B: { length: baselineB.length, viewId: baselineB.viewId },
        });

        // 4. Prove the partition, not just assume it: a storage write in A must be invisible in B,
        //    and the two contexts must hold two different session tokens.
        await pageA.evaluate(() => {
          window.localStorage.setItem('__qa-context-probe', 'A');
        });
        const storageProbeInB = await pageB.evaluate(() =>
          window.localStorage.getItem('__qa-context-probe'),
        );
        const cookiesA = await pageA.getCookies({ urls: [ctx.stack.appUrl] });
        const cookiesB = await pageB.getCookies({ urls: [ctx.stack.appUrl] });
        const sessionOf = (cookies) => cookies.filter((cookie) => cookie.name === 'insighthub_session');
        const sessionA = sessionOf(cookiesA);
        const sessionB = sessionOf(cookiesB);
        const idbA = await readIndexedDb(pageA, { includeSample: false });
        const idbB = await readIndexedDb(pageB, { includeSample: false });
        ctx.note('independent storage partitions', {
          localStorageProbeWrittenInA: await pageA.evaluate(() =>
            window.localStorage.getItem('__qa-context-probe'),
          ),
          localStorageProbeVisibleInB: storageProbeInB,
          // The session token is a credential: only its presence/shape is recorded, never a value.
          sessionCookies: {
            A: { count: sessionA.length, httpOnly: sessionA.map((cookie) => cookie.httpOnly === true) },
            B: { count: sessionB.length, httpOnly: sessionB.map((cookie) => cookie.httpOnly === true) },
            distinctTokens: sessionA[0]?.value !== sessionB[0]?.value,
          },
          indexedDb: { A: describeIndexedDb(idbA), B: describeIndexedDb(idbB) },
        });
        assertEqual(
          storageProbeInB,
          null,
          'a localStorage write in context A must be invisible in context B (independent storage)',
        );
        assertEqual(sessionA.length, 1, 'context A must hold exactly one session cookie');
        assertEqual(sessionB.length, 1, 'context B must hold exactly one session cookie');
        assert(
          sessionA[0].value !== sessionB[0].value,
          'the two contexts must hold two different session tokens, not one shared session',
        );
        assert(
          sessionA[0].httpOnly === true && sessionB[0].httpOnly === true,
          'both sessions must still be HttpOnly (the browser, not JS, must hold them)',
        );

        const identityA = await readWorkspaceFacts(pageA);
        const identityB = await readWorkspaceFacts(pageB);
        ctx.note('identities and roles as the browser renders them', {
          A: {
            claimed: identityA.claimedDemoIdentity,
            identity: identityA.identity,
            roleChip: identityA.roleChip,
            activeDocument: identityA.activeDocument,
          },
          B: {
            claimed: identityB.claimedDemoIdentity,
            identity: identityB.identity,
            roleChip: identityB.roleChip,
            activeDocument: identityB.activeDocument,
          },
        });
        assertEqual(identityA.activeDocument, documentId, 'page A must point at the shared document');
        assertEqual(identityB.activeDocument, documentId, 'page B must point at the shared document');
        assertEqual(identityA.roleChip, 'role: editor', 'A must be told it is an editor');
        assertEqual(identityB.roleChip, 'role: owner', 'B must be told it is an owner');

        // 5. Round 1 — A inserts at the front, B inserts at the tail. Started together and typed
        //    character by character, so the two edit streams genuinely overlap in time.
        await Promise.all([
          (async () => {
            await caretToStart(pageA);
            await typePerCharacter(pageA, FRONT_MARKER);
          })(),
          (async () => {
            await caretToEnd(pageB);
            await typePerCharacter(pageB, TAIL_MARKER);
          })(),
        ]);
        const round1 = { A: await readEditWindow(pageA), B: await readEditWindow(pageB) };
        ctx.note('round 1 (concurrent inserts) edit windows', {
          A: { transactions: round1.A.transactions, editWindow: round1.A.editWindow },
          B: { transactions: round1.B.transactions, editWindow: round1.B.editWindow },
          overlapped: overlaps(round1.A.editWindow, round1.B.editWindow),
        });
        assert(
          round1.A.editWindow !== null && round1.B.editWindow !== null,
          'both pages must have recorded a local edit in round 1 ' +
            `(A: ${JSON.stringify(round1.A.editWindow)}, B: ${JSON.stringify(round1.B.editWindow)})`,
        );
        assert(
          overlaps(round1.A.editWindow, round1.B.editWindow),
          'the two clients must have edited at the same time in round 1 ' +
            `(A window ${JSON.stringify(round1.A.editWindow)}, ` +
            `B window ${JSON.stringify(round1.B.editWindow)})`,
        );

        // 6. Round 2 — A deletes a known seeded token forwards (20 real Delete presses), B selects
        //    the other token with one word-selection keystroke and types a replacement character by
        //    character (21 transactions). Both streams are long, so the two must overlap.
        await Promise.all([
          (async () => {
            await caretToStart(pageA);
            await moveCaret(pageA, 'right', FRONT_MARKER.length);
            for (let index = 0; index < DELETED_TOKEN.length; index += 1) {
              await pageA.pressKey('Delete');
            }
          })(),
          (async () => {
            await caretToEnd(pageB);
            await moveCaret(pageB, 'left', TAIL_MARKER.length);
            // `Ctrl+Shift+ArrowLeft` is CodeMirror's `selectGroupLeft`: one press selects the whole
            // word before the caret, which is exactly the seeded token.
            await pageB.pressKey('ArrowLeft', { modifiers: 2 | 8 });
            await typePerCharacter(pageB, REPLACEMENT);
          })(),
        ]);
        const round2 = {
          A: await readEditWindow(pageA, { since: round1.A.total }),
          B: await readEditWindow(pageB, { since: round1.B.total }),
        };
        ctx.note('round 2 (delete + replace) edit windows', {
          A: { transactions: round2.A.transactions, editWindow: round2.A.editWindow },
          B: { transactions: round2.B.transactions, editWindow: round2.B.editWindow },
          overlapped: overlaps(round2.A.editWindow, round2.B.editWindow),
        });
        assert(
          overlaps(round2.A.editWindow, round2.B.editWindow),
          'the delete and the replace must have overlapped in time ' +
            `(A window ${JSON.stringify(round2.A.editWindow)}, ` +
            `B window ${JSON.stringify(round2.B.editWindow)})`,
        );

        // 7. Convergence — conditional polling, with per-replica diagnostics on timeout.
        const converged = await waitForThreeWayConvergence({
          pageA,
          pageB,
          oracle: witness,
          expected: EXPECTED,
        });
        ctx.note('converged text', {
          A: { characters: converged.stateA.length, viewId: converged.stateA.viewId },
          B: { characters: converged.stateB.length, viewId: converged.stateB.viewId },
          serverWitness: { characters: converged.oracleText.length },
        });
        assertEqual(
          converged.stateA.text,
          converged.stateB.text,
          `the two contexts' editors must hold the same text (${describeDivergence(
            converged.stateA.text,
            converged.stateB.text,
          )})`,
        );
        assertEqual(
          converged.oracleText,
          converged.stateA.text,
          'the server final state must equal both editors',
        );
        assertEqual(converged.stateA.text, EXPECTED, 'the merged result must be the expected text');
        assertEqual(
          converged.stateA.viewId,
          baselineA.viewId,
          'the concurrent edits must not have remounted A’s editor',
        );
        assertEqual(
          converged.stateB.viewId,
          baselineB.viewId,
          'the concurrent edits must not have remounted B’s editor',
        );

        // 8. State-vector digests: A = B = server. Only hashes/lengths are recorded, never content.
        const { vectorA, vectorB } = await waitForEqualStateVectors(pageA, pageB);
        const vectorWitness = witness.stateVectorHash();
        ctx.note('state-vector digests (sha256 of Y.encodeStateVector)', {
          A: vectorA,
          B: vectorB,
          serverWitness: vectorWitness,
        });
        assertEqual(vectorA.hash, vectorB.hash, 'A and B must report the same state-vector digest');
        assertEqual(
          vectorWitness.hash,
          vectorA.hash,
          'the server-side witness must report the same state-vector digest',
        );
        assertEqual(vectorA.documentId, documentId, 'A’s digest must be of the shared document');
        assertEqual(vectorB.documentId, documentId, 'B’s digest must be of the shared document');

        const diagnostics = {
          A: await readPageDiagnostics(pageA),
          B: await readPageDiagnostics(pageB),
        };
        ctx.note('page diagnostics', diagnostics);
        assertEqual(diagnostics.A.pageErrors.length, 0, 'page A must record no uncaught exception');
        assertEqual(diagnostics.B.pageErrors.length, 0, 'page B must record no uncaught exception');

        // 9. Dispose the contexts inside the scenario, so "no leaked storage partition" is
        //    measured here rather than left to the runner's safety net.
        assert(await ctx.closeBrowserContext(contextA), 'context A must be disposed');
        assert(await ctx.closeBrowserContext(contextB), 'context B must be disposed');
        ctx.note('browser contexts disposed', { A: true, B: true });
      } finally {
        witness.close();
      }
    },
  );

  /* ================================================================== *
   * C — HTTP stale-response ownership
   * ================================================================== */
  runner.scenario(
    'stale/directory-list',
    'a delayed HTTP response cannot override the document the user switched to (the only cancellable list request; no document-metadata request exists)',
    async (ctx) => {
      const documentA = 'a6-stale-directory-a';
      const documentB = 'a6-stale-directory-b';
      const BODY_A = 'STALE-A-BODY|';
      const BODY_B = 'STALE-B-BODY|';
      /** A marker only a *stale* list could contain; nothing in the product may ever render it. */
      const STALE_MARKER = 'STALE-RESPONSE-MARKER';

      await ctx.authz.grant(documentA, AUTHOR, 'owner');
      await ctx.authz.grant(documentB, AUTHOR, 'owner');
      for (const [documentId, body] of [
        [documentA, BODY_A],
        [documentB, BODY_B],
      ]) {
        const seeder = await WireOracle.connect({
          url: ctx.stack.wsUrl,
          documentId,
          label: `seed-${documentId}`,
        });
        seeder.replaceAll(body);
        seeder.close();
      }

      const page = await ctx.newAppPage({
        documentId: documentA,
        as: AUTHOR,
        role: null,
      });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await waitForEditorText(page, (text) => text === BODY_A, { label: 'document A content' });

      // 1. The static answer, measured: opening and switching a document performs **no** HTTP
      //    document-metadata request. The switch is a WebSocket `join-room` + `room-joined`.
      const callsOnOpenAndSwitch = await readApiCalls(page);
      const metadataCalls = callsOnOpenAndSwitch.filter((call) =>
        /^\/api\/documents\/[^/]+$/.test(call.path),
      );
      ctx.note('HTTP calls while opening and switching a document', callsOnOpenAndSwitch);
      ctx.note(
        'document-metadata HTTP request',
        'NOT APPLICABLE — the client performs no GET /api/documents/:id on open or switch; ' +
          'the switch is a WebSocket join-room. The closest cancellable HTTP path is the ' +
          'AiDirectory list request tested below.',
      );
      assertEqual(
        metadataCalls.length,
        0,
        'no document-metadata request may exist on the open/switch path: ' +
          `${JSON.stringify(metadataCalls)}`,
      );

      // 2. Open the read-only directory — the closest **real** stale-response path, and the only
      //    HTTP request in the client that an ownership change cancels.
      await page.click('[data-testid="ai-open"]');
      await page.waitForSelector('[data-testid="ai-directory"][data-state="ready"]', {
        timeoutMs: 15_000,
      });
      const initialRows = await readDirectoryRows(page);
      const initialFacts = await readWorkspaceFacts(page);
      ctx.note('directory before the delay', {
        rows: initialRows,
        activeDocument: initialFacts.activeDocument,
        state: initialFacts.directoryState,
      });
      assert(
        initialRows.some((row) => row.id === documentA && row.current),
        'the directory must mark the open document as current before the delay',
      );

      // 3. Delay the **next** list response at the response stage (headers and body are held by
      //    CDP, so the page's own `fetch` stays pending). Only `/api/documents` is intercepted.
      const paused = [];
      page.on('Fetch.requestPaused', (params) => {
        paused.push({ params, receivedAt: Date.now() });
      });
      await page.send('Fetch.enable', {
        patterns: [{ urlPattern: '*/api/documents*', requestStage: 'Response' }],
      });
      await page.click('[data-testid="ai-directory-refresh"]');
      const pauseDeadline = Date.now() + 15_000;
      while (paused.length === 0 && Date.now() < pauseDeadline) await sleep(25);
      assert(
        paused.length >= 1,
        'the directory request was never paused — the delay would not have been applied ' +
          `(Fetch.requestPaused events: ${paused.length})`,
      );
      const held = paused[0].params;
      ctx.note('held response (paused at the response stage)', {
        url: held.request?.url,
        method: held.request?.method,
        responseStatusCode: held.responseStatusCode ?? null,
        responseHeaders: (held.responseHeaders ?? []).map((header) => header.name),
      });
      assertEqual(
        held.responseStatusCode,
        200,
        'the held response must be the real server answer (HTTP 200), not a fabricated one',
      );

      // The real body of the held response, so "this was a real, complete answer" is a fact and
      // not an assumption. Read before the switch; reading is passive.
      let heldBody = null;
      try {
        const body = await page.send('Fetch.getResponseBody', { requestId: held.requestId });
        const bytes = Buffer.from(body.body ?? '', body.base64Encoded === true ? 'base64' : 'utf8');
        let ids = null;
        try {
          const parsed = JSON.parse(bytes.toString('utf8'));
          // `GET /api/documents` answers `{ documents: DocumentMeta[] }` (`docs/CONTRACTS.md` §12).
          const list = Array.isArray(parsed) ? parsed : parsed?.documents;
          ids = Array.isArray(list) ? list.map((entry) => entry?.id ?? null) : null;
        } catch {
          /* recorded as unparsable instead of failing the scenario here */
        }
        heldBody = { byteLength: bytes.length, ids, base64Encoded: body.base64Encoded === true };
      } catch (error) {
        heldBody = { error: String(error?.message ?? error) };
      }
      ctx.note('held response body', heldBody);

      // The page's own request log: the request must be **pending** while the response is held.
      const callsWhileHeld = await readApiCalls(page);
      const pending = callsWhileHeld.filter(
        (call) => call.path === '/api/documents' && call.status === null && call.error === null,
      );
      ctx.note('page request log while the response is held', { calls: callsWhileHeld, pending });
      assertEqual(
        pending.length,
        1,
        'exactly one directory request must be pending in the page’s own log while held ' +
          `(pending: ${JSON.stringify(pending)})`,
      );
      const requestT = pending[0].t;

      // 4. Inside that window, switch to the other document through the real UI.
      const switched = await page.evaluate(() => Date.now() - window.__qa.startedAt);
      // The abort is observed **while** the switch runs: polling for it afterwards would make
      // "which came first, the abort or the request's own 5 s timeout" depend on how long the
      // UI switch took. Both run concurrently on the same CDP session.
      const switchDone = setDocumentId(page, documentB, { arrangeAccess: false });
      const settledPromise = waitForApiCallSettled(page, {
        path: '/api/documents',
        requestT,
        timeoutMs: 8_000,
      });
      await switchDone;
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      const switchedDone = await page.evaluate(() => Date.now() - window.__qa.startedAt);

      // 5. The page's own request must be **aborted**, and not by the internal 5 s timeout.
      const settled = await settledPromise;
      ctx.note('the page’s own request after the switch', {
        entry: settled.entry,
        requestStartedAt: requestT,
        switchStartedAt: switched,
        switchFinishedAt: switchedDone,
        settledObservedAt: settled.observedAt,
        elapsedSinceRequestMs: settled.observedAt - requestT,
      });
      assertEqual(
        settled.entry.error,
        'AbortError',
        'the in-flight directory request must be aborted when the document switch unmounts the ' +
          `panel (observed entry: ${JSON.stringify(settled.entry)})`,
      );
      assertEqual(
        settled.entry.status,
        null,
        'the aborted request must never be recorded as a served response',
      );
      assert(
        settled.observedAt - requestT < 5_000,
        'the abort must come from the switch, not from the request’s internal 5 s timeout ' +
          `(settled after ${settled.observedAt - requestT}ms)`,
      );

      // 6. The UI and the session belong to B, and the abort is not rendered as a failure.
      const factsAfterSwitch = await readWorkspaceFacts(page);
      ctx.note('workspace after the switch, with the response still held', factsAfterSwitch);
      assertEqual(factsAfterSwitch.activeDocument, documentB, 'the active document must be B');
      assertEqual(factsAfterSwitch.editorText, BODY_B, 'the editor must hold B’s content');
      assertEqual(
        factsAfterSwitch.directoryPresent,
        false,
        'switching documents must unmount the directory (the panel belongs to the workspace)',
      );
      assertEqual(
        factsAfterSwitch.directoryError,
        null,
        'an aborted request must never be rendered as a directory failure',
      );
      assertEqual(
        factsAfterSwitch.sessionFailed,
        null,
        'the switch must not leave a failed session banner',
      );

      // 7. Release the delayed response. The page has already aborted the request, so the browser
      //    refuses to deliver it — and if a future browser *does* deliver it, the assertions below
      //    are the ones that would catch the pollution. The outcome is recorded either way.
      let release;
      try {
        await page.send('Fetch.fulfillRequest', {
          requestId: held.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from(
            JSON.stringify([
              {
                id: STALE_MARKER,
                title: 'stale response',
                revision: 0,
                ownerId: AUTHOR,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ]),
          ).toString('base64'),
        });
        release = { delivered: true };
      } catch (error) {
        release = { delivered: false, error: String(error?.message ?? error) };
      }
      ctx.note('release of the delayed response', release);

      // 8. Nothing moved: the request stays aborted (a delivered 200 would have set `status`), the
      //    document is still B, the editor still holds B’s content, and the stale marker never
      //    reaches the DOM.
      const settledAfterRelease = await findApiCall(page, '/api/documents', requestT);
      const factsAfterRelease = await readWorkspaceFacts(page);
      const staleMarkerRendered = await page.evaluate(
        (marker) => document.body.innerText.includes(marker),
        STALE_MARKER,
      );
      ctx.note('after releasing the delayed response', {
        request: settledAfterRelease,
        workspace: {
          activeDocument: factsAfterRelease.activeDocument,
          editorLength: factsAfterRelease.editorLength,
          connectionStatus: factsAfterRelease.connectionStatus,
          directoryPresent: factsAfterRelease.directoryPresent,
          directoryError: factsAfterRelease.directoryError,
        },
        staleMarkerRendered,
      });
      assertEqual(
        settledAfterRelease.error,
        'AbortError',
        'the delayed response must stay aborted — a delivered response would settle it',
      );
      assertEqual(
        settledAfterRelease.status,
        null,
        'the delayed response must never be recorded as a served response',
      );
      assertEqual(
        factsAfterRelease.activeDocument,
        documentB,
        'the released stale response must not move the active document back to A',
      );
      assertEqual(factsAfterRelease.editorText, BODY_B, 'the editor must still hold B’s content');
      assertEqual(staleMarkerRendered, false, 'no content from the stale response may reach the DOM');
      assertEqual(factsAfterRelease.directoryPresent, false, 'the panel must stay closed');

      // 9. Re-open the directory on B: its list must be the **server’s** list for B, with B marked
      //    current — i.e. the ownership decision was made by the new mount, not by the late answer.
      await page.send('Fetch.disable');
      await page.click('[data-testid="ai-open"]');
      await page.waitForSelector('[data-testid="ai-directory"][data-state="ready"]', {
        timeoutMs: 15_000,
      });
      const rowsAfter = await readDirectoryRows(page);
      const session = await ctx.authz.session(AUTHOR);
      const serverList = await ctx.authz.json('/api/documents', { cookie: session.cookie });
      const serverDocuments = Array.isArray(serverList.body) ? serverList.body : serverList.body?.documents;
      ctx.note('directory after the switch, against the server list', {
        rendered: rowsAfter,
        server: {
          status: serverList.status,
          ids: Array.isArray(serverDocuments) ? serverDocuments.map((entry) => entry?.id) : null,
        },
        activeDocument: (await readWorkspaceFacts(page)).activeDocument,
      });
      assertEqual(serverList.status, 200, 'the server list must be readable for the same session');
      assert(
        Array.isArray(serverDocuments),
        `GET /api/documents must answer a document list (body: ${JSON.stringify(serverList.body)})`,
      );
      assertEqual(
        rowsAfter.filter((row) => row.current).map((row) => row.id).join(','),
        documentB,
        'exactly document B must be marked current',
      );
      assertEqual(
        rowsAfter.map((row) => row.id).join(','),
        serverDocuments.map((entry) => entry.id).join(','),
        'the rendered list must be the server’s list, in the server’s order',
      );
      assert(
        !rowsAfter.some((row) => row.id === STALE_MARKER),
        'the stale response must not have contributed a row',
      );

      const diagnostics = await readPageDiagnostics(page);
      ctx.note('page diagnostics', diagnostics);
      assertEqual(diagnostics.pageErrors.length, 0, 'the stale-response path must not throw');
    },
  );
}
