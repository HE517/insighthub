/**
 * M2 Phase 2 closure — **F1 browser evidence** (`docs/DECISIONS.md` D-065 §4, D-067 §7).
 *
 * ## What this file is for
 *
 * A2's UI half (D-067) made `room-joined.role → session.getRole() → capabilityGate → editor` a
 * live path. A2 could only prove it at the state level (`reconfigure`, SSR markup, delivery-layer
 * refusal), and recorded four things as **unverified in a real browser**. This suite is those four
 * things, plus the one that keeps them honest: that the gate is *not* what protects the document.
 *
 * | Evidence point (D-065 §4) | Scenario |
 * | --- | --- |
 * | 1. a viewer's editor is read-only and says so; keystrokes write nothing; the editor is **not remounted** across the role transition | `f1/1-viewer-is-read-only-and-not-remounted` |
 * | 2. owner / editor have no regression (typing, undo, remote merge, document switch) | `f1/2-owner-and-editor-have-no-regression` |
 * | 3. `getRole() === null` must **not** lock the editor | `f1/3-unknown-role-does-not-lock-the-editor` |
 * | 4. the UI is **not** a security boundary: a client that lies to itself is still refused | `f1/4-ui-gate-is-not-a-security-boundary` |
 * | 5. no claim of instant revocation / instant UI role changes | measured in `f1/1` (the lag before the next `room-joined`) and `p2/5` (an open socket after a logout) |
 * | 6. real Chrome + a real backend | every scenario: `lib/chrome.mjs` + `lib/stack.mjs`; the run's `artifacts/results.md` records the browser build and the backend URL |
 *
 * ## Two rules that shaped every assertion
 *
 * - **`getRole() === null` is never a guess** (`docs/CONTRACTS.md` §17.9 rule 1/2): a client that
 *   guessed `viewer` would lock a user out of their own unsent text, and one that guessed `editor`
 *   would offer controls the server refuses. So `f1/3` is not a corner case — it is the state
 *   every page is in before its first join, including every offline start.
 * - **The UI gate is advisory** (`docs/ARCHITECTURE.md` §8.2). `f1/4` therefore does the opposite
 *   of `f1/1`: it *defeats* the gate inside the browser, and requires the server to refuse anyway.
 *   A suite that only proved `f1/1` would be testing a control that is not the boundary.
 *
 * ## The F3 evidence condition (D-065 §5)
 *
 * `f1/3` proves the `null` window was not manufactured by the harness: the page is opened with
 * `role: null` (both membership writers on the page-opening path disabled —
 * `run.mjs#newAppPage` + `lib/app.mjs#setDocumentId`) **and** `offlineFirst`, so no `join-room` is
 * ever attempted. The scenario asserts that the fixture wrote no membership row, that the database
 * row does not exist, and only then grants one explicitly — so the row it later relies on is
 * recorded as `inserted` at a known moment, not inherited from a fixture that helped itself.
 */
import {
  countOutboundSyncFrames,
  countServerErrorCode,
  deliverServerFrame,
  documentReplica,
  editorState,
  lastRoomJoinedRole,
  markEditorDom,
  pageCloseCodes,
  pressInEditor,
  qaSummary,
  readConnectionStatus,
  readEditorDomMarker,
  readEditorGate,
  readIndexedDb,
  readUndoState,
  screenshot,
  setDocumentId,
  setOffline,
  sleep,
  typeInEditor,
  waitForConnectionStatus,
  waitForEditorText,
} from '../lib/app.mjs';
import { DEMO_USERS } from '../lib/authz-fixture.mjs';
import { loadShared } from '../lib/deps.mjs';
import { reconstructDurableDocument } from '../lib/durable-store.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { WireOracle } from '../lib/oracle.mjs';
import {
  assertKeystrokeProducesNoWrite,
  assertUiEditable,
  assertUiReadOnly,
  sendBypassWrite,
  waitForBypassDenial,
  waitForRoleTag,
} from '../lib/role-gate.mjs';

/** A per-run marker, so stale content from an earlier scenario can never satisfy an assertion. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The document text reconstructed from the durable bytes (the server's own truth). */
async function durableText(ctx, documentId) {
  return (await reconstructDurableDocument(ctx.stack.dataPath, documentId)).text;
}

/** Wait until the durable text satisfies `predicate`, returning the last observed text. */
async function waitForDurableText(ctx, documentId, predicate, { timeoutMs = 30_000, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await durableText(ctx, documentId);
    if (last !== null && predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label ?? 'the durable text'}; ` +
          `the store holds ${JSON.stringify((last ?? '').slice(-200))}`,
      );
    }
    await sleep(150);
  }
}

/** Take the connection down and bring it back, so the client performs a real re-join. */
async function rejoin(ctx, page, label) {
  await setOffline(page, true);
  const dropped = await waitForConnectionStatus(page, ['reconnecting', 'offline', 'error'], {
    timeoutMs: 25_000,
  });
  await setOffline(page, false);
  const restored = await waitForConnectionStatus(page, 'connected', { timeoutMs: 60_000 });
  ctx.note(`${label}: reconnect cycle`, { whileOffline: dropped, after: restored });
}

export function register(runner) {
  /* ================================================================== *
   * Evidence point 1 — the viewer's UI is read-only, and the editor survives the transition
   * ================================================================== */
  runner.scenario(
    'f1/1-viewer-is-read-only-and-not-remounted',
    'a viewer’s editor is read-only in the DOM and in EditorState, says so visibly, writes nothing on a real keystroke — and the role transition reconfigures the SAME .cm-editor element',
    async (ctx) => {
      const documentId = `f1-ui-${marker('doc')}`;
      const seed = marker('F1-SEED');
      const refused = marker('F1-REFUSED');
      const restored = marker('F1-PROMOTED');

      // ada owns it and linus starts as an **editor**, so the transition is a real demotion
      // (viewer → editor → viewer is what a role change actually looks like here).
      await ctx.authz.grant(documentId, DEMO_USERS.ada, 'owner');
      await ctx.authz.grant(documentId, DEMO_USERS.linus, 'editor');

      const owner = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'owner',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        owner.append(`${seed}\n`);
        await waitForDurableText(ctx, documentId, (text) => text.includes(seed), {
          label: 'the seed write',
        });

        const page = await ctx.newAppPage({ documentId, as: DEMO_USERS.linus, role: null });
        await waitForEditorText(page, (text) => text.includes(seed), {
          label: 'the editor to hydrate the seeded content',
        });

        /* ---------- before: a known editing role ---------- */
        await assertUiEditable(ctx, page, { role: 'editor', label: 'editor (before the demotion)' });
        const identityToken = marker('CM-ELEMENT');
        const marked = await markEditorDom(page, identityToken);
        assertEqual(marked.ok, true, 'the .cm-editor element must exist to be marked');
        const viewBefore = await editorState(page);
        ctx.note('editor identity before the role change', {
          marker: identityToken,
          viewId: viewBefore.viewId,
          mounts: marked.mounts,
          unmounts: marked.unmounts,
          live: marked.live,
        });
        /**
         * The counters are compared as **deltas** from this point, not as absolute values: what
         * matters is whether the role transition created a second editor. The absolute numbers at
         * this instant are recorded above so the delta has a baseline.
         */
        const noRemount = async (label) => {
          const counters = await readEditorDomMarker(page);
          ctx.note(`${label}: editor mount counters`, counters);
          assertEqual(
            counters.mounts,
            marked.mounts,
            `${label}: no new .cm-editor may have been mounted`,
          );
          assertEqual(
            counters.unmounts,
            marked.unmounts,
            `${label}: no .cm-editor may have been unmounted (no remount)`,
          );
          assertEqual(counters.marker, identityToken, `${label}: the same element must still be there`);
          return counters;
        };

        /* ---------- the demotion: the server changes, the UI does NOT ---------- */
        const demoted = await ctx.authz.grant(documentId, DEMO_USERS.linus, 'viewer');
        ctx.note('membership after the demotion', demoted);
        await sleep(3_000);

        const lag = await readEditorGate(page);
        ctx.note('the UI 3 s after the membership says viewer (no room-joined yet)', {
          roleTag: lag.roleTag,
          contentEditable: lag.contentEditable,
          noticePresent: lag.notice.present,
          note:
            'NOT a defect: the client learns its role only from room-joined (§17.9 rule 1), and ' +
            'Phase 2 sends no role-change message. This measurement is why D-066 §5 forbids ' +
            'claiming that a role change reaches the UI immediately. The server has already ' +
            'started refusing this socket’s writes — measured in p2/5-role-change-is-re-evaluated.',
        });
        assertEqual(
          lag.roleTag,
          'role: editor',
          'the UI must still show the previous role until the next successful join (D-066 §5)',
        );
        assertEqual(
          lag.contentEditable,
          'true',
          'the editor must stay as it was — the client has not been told about the demotion yet',
        );
        await noRemount('3 s after the demotion');

        /* ---------- the next join: while it is in flight the role is UNKNOWN ---------- */
        await setOffline(page, true);
        await waitForConnectionStatus(page, ['reconnecting', 'offline', 'error'], {
          timeoutMs: 25_000,
        });
        const unknown = await readEditorGate(page);
        ctx.note('the UI while reconnecting (getRole() is null)', {
          roleTag: unknown.roleTag,
          contentEditable: unknown.contentEditable,
          noticePresent: unknown.notice.present,
        });
        assertEqual(unknown.roleTag, null, 'no role chip may be shown while the role is unknown');
        assertEqual(
          unknown.contentEditable,
          'true',
          'an unknown role must never lock the editor out of its own text (§17.9, R10)',
        );
        assertEqual(
          unknown.notice.present,
          false,
          'an unknown role must not be presented as read-only (§17.9)',
        );
        await noRemount('while reconnecting (role unknown)');

        await setOffline(page, false);
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 60_000 });
        await waitForRoleTag(ctx, page, 'viewer', { label: 'the demoted role', timeoutMs: 60_000 });

        /* ---------- after: the viewer gate, and the same DOM element ---------- */
        await assertUiReadOnly(ctx, page, { role: 'viewer', label: 'viewer (after the demotion)' });

        const viewAfter = await editorState(page);
        const identityAfter = await readEditorDomMarker(page);
        ctx.note('editor identity after the role transition', {
          markerBefore: identityToken,
          markerAfter: identityAfter.marker,
          viewIdBefore: viewBefore.viewId,
          viewIdAfter: viewAfter.viewId,
          mountsBefore: marked.mounts,
          mountsAfter: identityAfter.mounts,
          unmountsBefore: marked.unmounts,
          unmountsAfter: identityAfter.unmounts,
        });
        assertEqual(
          identityAfter.marker,
          identityToken,
          'the .cm-editor DOM node must be the SAME element after the role transition ' +
            '(a reconfigure, not a remount — D-067 §7)',
        );
        assertEqual(
          viewAfter.viewId,
          viewBefore.viewId,
          'the live EditorView must be the same object (no second editor was constructed)',
        );
        await noRemount('after the demotion was applied');

        /* ---------- the keystroke a viewer cannot turn into a write ---------- */
        // Kept from the pre-gate version of the suite at its **full strength**: the same real
        // input is sent, and now nothing at all is expected to happen (D-067 §4).
        //
        // "Does not change `Y.Text`" is read from three layers, because the editor's buffer is
        // only a view: the live editor document, the client's own IndexedDB replica (which y-indexeddb
        // writes one binary Yjs update per document change, batched at 1 s — hence the quiet
        // windows), and the durable store after the write would have been relayed.
        await sleep(2_500); // let the hydration updates finish flushing before the baseline
        const replicaBefore = documentReplica(await readIndexedDb(page, { includeSample: false }), documentId);
        const updatesBefore = replicaBefore?.stores.find((store) => store.name === 'updates')?.count ?? 0;

        await assertKeystrokeProducesNoWrite(ctx, page, {
          documentId,
          label: 'viewer',
          attempt: refused,
        });

        await sleep(2_500);
        const replicaAfter = documentReplica(await readIndexedDb(page, { includeSample: false }), documentId);
        const updatesAfter = replicaAfter?.stores.find((store) => store.name === 'updates')?.count ?? 0;
        ctx.note('the viewer’s local replica after the keystroke', {
          database: replicaAfter?.name ?? null,
          updatesBefore,
          updatesAfter,
          note: 'a keystroke that reached Y.Text would add a binary update record',
        });
        assertEqual(
          updatesAfter,
          updatesBefore,
          'a viewer keystroke must not add a Yjs update to the local replica (Y.Text unchanged)',
        );

        await sleep(2_000);
        const afterType = await durableText(ctx, documentId);
        ctx.note('durable text after the viewer keystroke', {
          containsRefusedText: (afterType ?? '').includes(refused),
        });
        assert(
          !(afterType ?? '').includes(refused),
          'a viewer keystroke must never reach the durable store',
        );
        assert(!owner.text.includes(refused), 'no peer may see a viewer keystroke');

        const shot = await screenshot(page, 'f1-1-viewer-read-only');
        ctx.note('evidence screenshot', shot);

        /* ---------- promotion: back to editor, same element, typing works ---------- */
        const promoted = await ctx.authz.grant(documentId, DEMO_USERS.linus, 'editor');
        ctx.note('membership after the promotion', promoted);
        await rejoin(ctx, page, 'after the promotion');
        await waitForRoleTag(ctx, page, 'editor', { label: 'the promoted role', timeoutMs: 60_000 });
        await assertUiEditable(ctx, page, { role: 'editor', label: 'editor (after the promotion)' });

        await typeInEditor(page, restored);
        await waitForDurableText(ctx, documentId, (text) => text.includes(restored), {
          label: 'the promoted editor’s keystroke to be persisted',
        });
        const identityPromoted = await readEditorDomMarker(page);
        ctx.note('editor identity after the promotion', {
          marker: identityPromoted.marker,
          mounts: identityPromoted.mounts,
          unmounts: identityPromoted.unmounts,
        });
        assertEqual(
          identityPromoted.marker,
          identityToken,
          'the promotion must reuse the same .cm-editor element too',
        );
        await noRemount('after the promotion was applied');
      } finally {
        owner.close();
      }
    },
  );

  /* ================================================================== *
   * Evidence point 2 — owner and editor have no regression
   * ================================================================== */
  runner.scenario(
    'f1/2-owner-and-editor-have-no-regression',
    'owner and editor: editable UI, typing persists, session undo still reverts, a remote edit merges, and a document switch still works',
    async (ctx) => {
      const documentId = `f1-regress-${marker('doc')}`;
      const nextDocumentId = `f1-regress-next-${marker('doc')}`;
      const seed = marker('F1-SEED');
      const typed = marker('EDITOR-TYPED');
      const remote = marker('F1-REMOTE');
      const typedAfterSwitch = marker('F1-AFTER-SWITCH');

      await ctx.authz.grant(documentId, DEMO_USERS.ada, 'owner');
      await ctx.authz.grant(documentId, DEMO_USERS.linus, 'editor');

      const owner = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'owner',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        owner.append(`${seed}\n`);
        await waitForDurableText(ctx, documentId, (text) => text.includes(seed), {
          label: 'the seed write',
        });

        /* ---------- an editor ---------- */
        const page = await ctx.newAppPage({ documentId, as: DEMO_USERS.linus, role: null });
        await waitForEditorText(page, (text) => text.includes(seed), {
          label: 'the editor to hydrate',
        });
        await assertUiEditable(ctx, page, { role: 'editor' });

        await typeInEditor(page, typed);
        await waitForDurableText(ctx, documentId, (text) => text.includes(typed), {
          label: 'the editor’s keystroke to be persisted',
        });
        ctx.note('editor typed and it persisted', true);

        // Undo is the session's `Y.UndoManager`, i.e. a local `Y.Text` write — the path A2's gate
        // had to cover for a viewer. For an editor it must still work (R13).
        const undoBefore = await readUndoState(page);
        ctx.note('undo state after typing', undoBefore);
        assertIncludes(undoBefore ?? '', 'available', 'a local edit must be undoable');
        await pressInEditor(page, 'z', { modifiers: 2 });
        await waitForDurableText(ctx, documentId, (text) => !text.includes(typed), {
          label: 'the local undo to revert the insert',
        });
        ctx.note('undo outcome', { revertedLocally: true, typedMarker: typed });

        // A remote edit must still merge into an editable document.
        owner.append(`${remote}\n`);
        const merged = await waitForEditorText(page, (text) => text.includes(remote), {
          label: 'the remote edit to arrive',
        });
        ctx.note('editor after the remote edit', {
          length: merged.text.length,
          containsRemote: merged.text.includes(remote),
          containsSeed: merged.text.includes(seed),
        });
        assertIncludes(merged.text, remote, 'a remote edit must still reach an editable editor');

        /* ---------- the owner, and a document switch ---------- */
        await setDocumentId(page, nextDocumentId);
        // The switch arranges access for this identity (the default `ifAbsent` rule), so the new
        // document reports `owner`: one more role→UI pairing read from a real page.
        await waitForRoleTag(ctx, page, 'owner', { label: 'the role on the new document' });
        await assertUiEditable(ctx, page, { role: 'owner', label: 'owner (after the switch)' });
        ctx.note('role on the switched document', {
          roomJoinedRole: await lastRoomJoinedRole(page, nextDocumentId),
        });
        assertEqual(
          await lastRoomJoinedRole(page, nextDocumentId),
          'owner',
          'the switched document must report the role its membership holds',
        );

        await typeInEditor(page, typedAfterSwitch);
        await waitForDurableText(ctx, nextDocumentId, (text) => text.includes(typedAfterSwitch), {
          label: 'the owner’s keystroke to be persisted on the new document',
        });
        const previousStillClean = !(await durableText(ctx, documentId)).includes(typedAfterSwitch);
        ctx.note('the previous document after the switch', {
          containsTheNewText: !previousStillClean,
        });
        assert(
          previousStillClean,
          'a keystroke after the switch must go to the new document only',
        );
        assert(
          !owner.text.includes(typedAfterSwitch),
          'a keystroke on the new document must not reach the old document’s peer',
        );
        const sockets = await pageCloseCodes(page);
        ctx.note('close codes across the switch', sockets.map((entry) => entry.code));
      } finally {
        owner.close();
      }
    },
  );

  /* ================================================================== *
   * Evidence point 3 — an unknown role must not lock the editor (and F3)
   * ================================================================== */
  runner.scenario(
    'f1/3-unknown-role-does-not-lock-the-editor',
    'getRole() === null in a real browser window (offline from the first frame, no membership written): the editor is editable and the typing reaches Y.Text — the case that would silently break users',
    async (ctx) => {
      const documentId = `f1-null-${marker('doc')}`;
      const typed = marker('NULL-ROLE-TYPED');

      /* ---------- F3: prove the harness created nothing before the window ---------- */
      // `role: null` disables **both** membership writers on the page-opening path
      // (`run.mjs#newAppPage` and `lib/app.mjs#setDocumentId`), and `offlineFirst` means no
      // `join-room` is attempted at all, so no authorization decision is ever made.
      const writesBefore = ctx.authz.log.length;
      const rowBefore = await ctx.authz.membership(documentId, DEMO_USERS.ada);
      ctx.note('F3 — before the page exists', {
        fixtureWritesSoFar: writesBefore,
        membershipRow: rowBefore,
        note:
          'this identity has no membership at all, and the page-opening path has written none ' +
          '(D-065 §5: an implicit owner row here would make every later observation suspect)',
      });
      assertEqual(writesBefore, 0, 'F3: no membership write may have happened before this window');
      assertEqual(rowBefore, null, 'F3: this identity must have no membership row at all');

      /* ---------- the window: offline from before the first frame ---------- */
      const page = await ctx.newAppPage({
        documentId,
        as: DEMO_USERS.ada,
        role: null,
        offlineFirst: true,
      });
      await waitForEditorText(page, () => true, { label: 'the editor to mount offline' });

      const status = await readConnectionStatus(page);
      const summary = await qaSummary(page);
      const joinedRole = await lastRoomJoinedRole(page, documentId);
      const gate = await readEditorGate(page);
      ctx.note('the unknown-role window in the browser', {
        connectionStatus: status,
        liveDocumentSockets: summary.liveDocumentSockets,
        roomJoinedRole: joinedRole,
        roleTag: gate.roleTag,
        contentEditable: gate.contentEditable,
        viewReadOnly: gate.viewReadOnly,
        notice: { present: gate.notice.present, text: gate.notice.text },
      });

      assert(
        status !== 'connected',
        `the window is only meaningful if the page is not connected (status: ${status})`,
      );
      assertEqual(
        summary.liveDocumentSockets,
        0,
        'no collaboration socket may be open — otherwise a join could have happened',
      );
      assertEqual(
        joinedRole,
        null,
        'the page must never have received a room-joined, which is what makes getRole() null',
      );
      assertEqual(gate.roleTag, null, 'no role chip may be shown for an unknown role');
      assertEqual(
        gate.contentEditable,
        'true',
        'getRole() === null must NOT lock the editor (§17.9 gating consequence, R10)',
      );
      assertEqual(gate.viewReadOnly, false, 'an unknown role must not set EditorState.readOnly');
      assertEqual(
        gate.notice.present,
        false,
        'an unknown role must not be presented as read-only (§17.9)',
      );

      /* ---------- F3 again, now that the page exists ---------- */
      const writesDuringSetup = ctx.authz.log.length;
      const rowDuringWindow = await ctx.authz.membership(documentId, DEMO_USERS.ada);
      ctx.note('F3 — during the unknown-role window', {
        fixtureWrites: writesDuringSetup,
        membershipRow: rowDuringWindow,
        bootstraps: summary.bootstrapCalls,
        claimedIdentity: summary.demoIdentity,
        note:
          'the page did bootstrap a real session (the claim is legitimate); what it never did is ' +
          'join a room, so no membership was needed and none was written',
      });
      assertEqual(writesDuringSetup, 0, 'F3: opening the page must not have written a membership');
      assertEqual(rowDuringWindow, null, 'F3: still no membership row for this identity');

      /* ---------- the keystroke must be accepted, and must reach Y.Text ---------- */
      const beforeType = await editorState(page);
      await typeInEditor(page, typed);
      const afterType = await editorState(page);
      ctx.note('typing while the role is unknown', {
        editorLengthBefore: beforeType.text.length,
        editorLengthAfter: afterType.text.length,
        typedMarker: typed,
        containsTyped: afterType.text.includes(typed),
      });
      assertIncludes(
        afterType.text,
        typed,
        'an unknown role must accept real typing (§17.9: never lock a user out of unsent text)',
      );

      // The editor's document is the surface; `Y.Text` is the source of truth. Two independent
      // proofs that the keystroke really became a Yjs document update:
      //   (a) the client's own IndexedDB replica now holds binary update records;
      //   (b) after the join, the server's durable document contains it (below).
      await sleep(2_500);
      const replica = documentReplica(await readIndexedDb(page, { includeSample: true }), documentId);
      const updatesStore = replica?.stores.find((store) => store.name === 'updates') ?? null;
      ctx.note('the client’s local replica for this document', {
        database: replica?.name ?? null,
        updates: updatesStore?.count ?? 0,
        firstRecordType: updatesStore?.sample?.firstRecordType ?? null,
        note: 'binary Yjs updates, not a parallel Markdown string (R11)',
      });
      assert(
        (updatesStore?.count ?? 0) >= 1,
        'the keystroke must have produced a Yjs update in the local replica (Y.Text was written)',
      );
      assertEqual(
        updatesStore?.sample?.firstRecordType,
        'binary',
        'the replica must hold encoded Yjs updates, never a plain string copy of the body',
      );

      /* ---------- now arrange access, explicitly and on the record ---------- */
      const granted = await ctx.authz.grant(documentId, DEMO_USERS.ada, 'editor');
      ctx.note('membership arranged AFTER the window', granted);
      assertEqual(
        granted.action,
        'inserted',
        'the row must not have existed before this moment — F3 is what this assertion rules out',
      );

      await setOffline(page, false);
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 60_000 });
      await waitForRoleTag(ctx, page, 'editor', { label: 'the role after the join' });
      await assertUiEditable(ctx, page, { role: 'editor', label: 'after the join' });

      // (b) The decisive proof that the text reached `Y.Text`: the server now holds what the user
      // typed while the client had no idea what its role was.
      await waitForDurableText(ctx, documentId, (text) => text.includes(typed), {
        timeoutMs: 45_000,
        label: 'the text typed while the role was unknown to reach the durable document',
      });
      const persisted = await durableText(ctx, documentId);
      ctx.note('the unknown-role typing after the join', {
        persistedOnTheServer: persisted.includes(typed),
        note:
          'a Yjs update only exists if Y.Text was written: the keystroke was accepted locally ' +
          'while getRole() was null, and the state-vector handshake uploaded it',
      });
      assertIncludes(
        persisted,
        typed,
        'the text typed while the role was unknown must reach Y.Text and therefore the server',
      );
    },
  );

  /* ================================================================== *
   * Evidence point 4 — the UI gate is NOT the security boundary
   * ================================================================== */
  runner.scenario(
    'f1/4-ui-gate-is-not-a-security-boundary',
    'a viewer page that forges its own room-joined(owner) gets a fully editable UI — and the server still refuses the write: nothing applied, persisted or broadcast, and the socket stays a reader',
    async (ctx) => {
      const documentId = `f1-bypass-${marker('doc')}`;
      const seed = marker('F1-SEED');
      const sneaky = marker('FORGED-OWNER-WRITE');
      const later = marker('OWNER-AFTER');

      await ctx.authz.grant(documentId, DEMO_USERS.ada, 'owner');
      await ctx.authz.grant(documentId, DEMO_USERS.linus, 'viewer');

      const owner = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'owner',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        owner.append(`${seed}\n`);
        await waitForDurableText(ctx, documentId, (text) => text.includes(seed), {
          label: 'the seed write',
        });

        const page = await ctx.newAppPage({ documentId, as: DEMO_USERS.linus, role: null });
        await waitForEditorText(page, (text) => text.includes(seed), {
          label: 'the viewer to hydrate the content',
        });
        // The starting point: the gate is doing its job.
        await assertUiReadOnly(ctx, page, { role: 'viewer' });
        const socketsBefore = await qaSummary(page);
        /**
         * Close codes observed **before** the forged role. The page renders its shell under
         * `React.StrictMode` (`apps/web/src/main.tsx`), so the creation effect runs twice and the
         * first session's socket is closed while still connecting (1006): those closes are
         * startup noise, not a reaction to anything below. The assertion is therefore "no NEW
         * close", which is the question that matters.
         */
        const closesBefore = await pageCloseCodes(page);
        ctx.note('transport before the forged role', {
          sockets: socketsBefore.sockets,
          liveDocumentSockets: socketsBefore.liveDocumentSockets,
          closeCodes: closesBefore.map((entry) => entry.code),
        });

        /* ---------- the client lies to itself ---------- */
        // A schema-valid `room-joined` with `role: 'owner'`, delivered to the page's own message
        // handler with the contract's own constructor. `room-joined.role` is documented as
        // carrying **no authority** (§17.5): it decides which controls the client shows. So this
        // is exactly the attacker the gate cannot stop — the client's own runtime.
        const shared = await loadShared();
        const forged = JSON.stringify(
          shared.createRoomJoinedMessage({
            documentId,
            connectionId: 'f1-forged-connection',
            peers: [],
            role: 'owner',
          }),
        );
        const delivered = await deliverServerFrame(page, documentId, forged);
        ctx.note('forged room-joined delivered into the page', {
          delivered,
          payload: { documentId, role: 'owner', connectionId: 'f1-forged-connection' },
          note: 'not a server message: injected into the page’s own handler, on purpose',
        });
        assertEqual(delivered.ok, true, 'the forged room-joined must reach the page’s handler');

        await waitForRoleTag(ctx, page, 'owner', {
          label: 'the forged role',
          timeoutMs: 15_000,
        });
        await assertUiEditable(ctx, page, {
          role: 'owner',
          label: 'the lying client (forged owner)',
        });
        ctx.note(
          'the UI gate is defeated',
          'the page now renders an editable editor and no notice — which is why the gate ' +
            'cannot be the security boundary (docs/ARCHITECTURE.md §8.2)',
        );

        /* ---------- and the write is refused anyway ---------- */
        // The lying client can now produce a write the way a real user would: a keystroke into its
        // own editable editor, which the binding writes into the client's `Y.Text` and the sync
        // provider puts on the wire. If the UI gate were the boundary, this would succeed.
        const syncFramesBefore = await countOutboundSyncFrames(page, documentId);
        await typeInEditor(page, sneaky);
        await waitForEditorText(page, (text) => text.includes(sneaky), {
          label: 'the keystroke to enter the lying client’s local document',
        });
        await sleep(1_500);
        const syncFramesAfter = await countOutboundSyncFrames(page, documentId);
        const forbiddenAfterTyping = await countServerErrorCode(page, 'FORBIDDEN', documentId);
        ctx.note('the lying client produced a real write', {
          localEditorNowHoldsIt: true,
          syncFramesBefore,
          syncFramesAfter,
          forbiddenFramesAfterTyping: forbiddenAfterTyping,
        });
        assert(
          syncFramesAfter > syncFramesBefore,
          'the lying client must really have emitted a SYNC write frame — otherwise nothing is tested',
        );

        // A second attempt, made *entirely* outside the editor (no keystroke, no UI at all), so the
        // refusal cannot be attributed to anything the role gate did.
        const bypass = await sendBypassWrite(ctx, page, {
          documentId,
          text: `${sneaky}-socket`,
          label: 'lying client (explicit frame)',
        });
        const denial = await waitForBypassDenial(ctx, page, {
          documentId,
          label: 'lying client',
          afterCount: bypass.forbiddenBefore,
        });
        ctx.note('the server’s answer to a forged owner', {
          code: denial.code,
          message: denial.message ?? null,
        });

        await sleep(3_000);
        const stored = await durableText(ctx, documentId);
        const closesAfter = await pageCloseCodes(page);
        ctx.note('what the forged owner achieved', {
          persisted: (stored ?? '').includes(sneaky),
          broadcastToTheOwner: owner.text.includes(sneaky),
          socketsBefore: socketsBefore.sockets,
          socketsAfter: (await qaSummary(page)).sockets,
          closeCodesBefore: closesBefore.map((entry) => entry.code),
          closeCodesAfter: closesAfter.map((entry) => entry.code),
          note:
            'the local editor still shows the text: a client that ignores the gate forks its own ' +
            'replica. That is the accepted non-security defect of D-064 §2 item 3 — the server ' +
            'rejected the write before apply/persist/broadcast',
        });
        assert(
          !(stored ?? '').includes(sneaky),
          'a forged owner role must not get anything persisted (§17.5: no apply, no persist)',
        );
        assert(
          !owner.text.includes(sneaky),
          'a forged owner role must not get anything broadcast to the other peer',
        );
        assertEqual(
          (await qaSummary(page)).sockets,
          socketsBefore.sockets,
          'the refusal must be non-fatal: no reconnect, no new socket',
        );
        assertEqual(
          closesAfter.length,
          closesBefore.length,
          'the refusal must not close the socket (FORBIDDEN is non-fatal, §17.5)',
        );

        // A refused write must not turn the reader into a non-reader.
        owner.append(`${later}\n`);
        const received = await waitForEditorText(page, (text) => text.includes(later), {
          timeoutMs: 30_000,
          label: 'the owner’s later edit to arrive after the refusal',
        });
        ctx.note('the lying client still receives updates', {
          containsOwnerEdit: received.text.includes(later),
          liveDocumentSockets: (await qaSummary(page)).liveDocumentSockets,
        });
        assertIncludes(
          received.text,
          later,
          'a refused write must not stop the socket from receiving (a reader stays a reader)',
        );
      } finally {
        owner.close();
      }
    },
  );
}
