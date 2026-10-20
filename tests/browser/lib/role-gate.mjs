/**
 * Shared assertions for the **UI role gate** (M2 Phase 2, A7 F1 / `docs/DECISIONS.md` D-067).
 *
 * ## Why this is its own module
 *
 * Two suites need the same three questions answered — the P2 table (`20-m2-phase2-authz.mjs`)
 * and the F1 evidence suite (`21-m2-f1-role-ui.mjs`) — and a second copy of an assertion is how
 * two scenarios end up proving slightly different things while both look green. The wording is
 * therefore written once, in one place.
 *
 * ## What these helpers may and may not claim
 *
 * They assert what a **browser** shows: the DOM refuses the keystroke, the live `EditorState`
 * is read-only, the explanation is visible, and a real keystroke produces no write. They never
 * claim that this is what stops an authorised mutation — the server does that, and the only way
 * to observe it is to send a frame (`syncUpdateFrameBase64` + `sendSyncUpdateFromPage`), which is
 * why the pair exists (`docs/DECISIONS.md` D-067 §4: "UI read-only assertion **and** proof that
 * the server still refuses through a NON-UI path").
 *
 * They also never claim that a role change reaches the UI immediately: the client learns its role
 * only from `room-joined` (`docs/CONTRACTS.md` §17.9 rule 1), so a membership change takes effect
 * in the UI at the next successful join — and `docs/DECISIONS.md` D-066 §5 forbids saying
 * otherwise. `waitForRoleTag` is deliberately a *poll with a timeout*, never "it is already true".
 */
import {
  countOutboundSyncFrames,
  countServerErrorCode,
  editorState,
  readEditorGate,
  READ_ONLY_NOTICE_BANNED_WORDS,
  sendSyncUpdateFromPage,
  sleep,
  typeInEditor,
  waitForNewServerErrorCode,
} from './app.mjs';
import { loadShared, loadYjs } from './deps.mjs';
import { assert, assertEqual, assertIncludes } from './harness.mjs';

/**
 * A real `SYNC` **update** frame carrying `text`, as base64, built with the frozen codec.
 *
 * Built from a throwaway `Y.Doc`, so the page's own document is untouched: a refused write must
 * not leave the client's `Y.Text` structurally diverged, or the next assertion would be measuring
 * a broken document instead of the server's answer.
 */
export async function syncUpdateFrameBase64(text) {
  const [Y, shared] = await Promise.all([loadYjs(), loadShared()]);
  const throwaway = new Y.Doc();
  throwaway.getText(shared.DOCUMENT_TEXT_KEY).insert(0, text);
  return Buffer.from(shared.encodeSyncUpdate(Y.encodeStateAsUpdate(throwaway))).toString('base64');
}

/**
 * Assert what the browser shows for a **known role without `canEdit`**, and record it.
 *
 * The four facts `docs/CONTRACTS.md` §17.9 requires are checked together, because any one of them
 * alone can be satisfied by a wrong implementation:
 *
 * 1. `EditorView.editable` made the DOM refuse the keystroke (`contenteditable="false"`);
 * 2. `EditorState.readOnly` is set on the **live** view — the facet CodeMirror's own commands and
 *    input handlers consult;
 * 3. the explanation is **visible**: laid out with a real box, not merely present in the DOM;
 * 4. the copy says *why*, and never implies a save or an instant role change
 *    (`docs/CONTRACTS.md` §17.9, `docs/DECISIONS.md` D-064 §1, D-066 §5).
 */
export async function assertUiReadOnly(ctx, page, { role, label = role }) {
  const gate = await readEditorGate(page);
  ctx.note(`UI gate (${label})`, {
    contentEditable: gate.contentEditable,
    viewReadOnly: gate.viewReadOnly,
    roleTag: gate.roleTag,
    notice: gate.notice,
  });

  assert(gate.editorPresent, `${label}: the editor must be mounted`);
  assertEqual(
    gate.roleTag,
    `role: ${role}`,
    `${label}: the UI must show the role the server reported`,
  );
  assertEqual(
    gate.contentEditable,
    'false',
    `${label}: EditorView.editable must make the content element non-editable (§17.9)`,
  );
  assertEqual(
    gate.viewReadOnly,
    true,
    `${label}: EditorState.readOnly must be set on the live EditorView (§17.9)`,
  );

  assert(gate.notice.present, `${label}: the read-only notice must be rendered (§17.9)`);
  assert(gate.notice.visible, `${label}: the read-only notice must be VISIBLE, not only in the DOM`);
  assertEqual(
    gate.notice.testId,
    'read-only-notice',
    `${label}: the notice must carry its stable test id`,
  );
  const copy = (gate.notice.text ?? '').toLowerCase();
  assertIncludes(copy, 'read-only for your role', `${label}: the notice must say why (§17.9)`);
  for (const word of READ_ONLY_NOTICE_BANNED_WORDS) {
    assert(
      !copy.includes(word),
      `${label}: the notice must not contain "${word}" — nothing was saved and no role change is ` +
        'instant (D-064 §1, D-066 §5); notice was: ' +
        JSON.stringify(gate.notice.text),
    );
  }
  ctx.note(`${label}: read-only notice copy`, JSON.stringify(gate.notice.text));
  return gate;
}

/**
 * The same facts for a role that **may** edit.
 *
 * This is the control that stops "the editor is read-only" from being satisfied by an editor that
 * is read-only for everybody — including an implementation that mapped `null` (unknown) to
 * `viewer`.
 */
export async function assertUiEditable(ctx, page, { role, label = role }) {
  const gate = await readEditorGate(page);
  ctx.note(`UI gate (${label})`, {
    contentEditable: gate.contentEditable,
    viewReadOnly: gate.viewReadOnly,
    roleTag: gate.roleTag,
    noticePresent: gate.notice.present,
  });
  assertEqual(gate.roleTag, `role: ${role}`, `${label}: the UI must show the reported role`);
  assertEqual(gate.contentEditable, 'true', `${label}: the content element must stay editable`);
  assertEqual(gate.viewReadOnly, false, `${label}: EditorState.readOnly must not be set`);
  assertEqual(
    gate.notice.present,
    false,
    `${label}: no read-only notice may be shown to a role that may edit`,
  );
  return gate;
}

/**
 * Wait until the UI renders `role: <role>`.
 *
 * A poll with a timeout, deliberately: the client re-reads the role only when a `room-joined`
 * arrives (§17.9 rule 1), so "the UI will flip" is a future event, never an immediate one.
 */
export async function waitForRoleTag(ctx, page, role, { timeoutMs = 45_000, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const gate = await readEditorGate(page);
    last = gate.roleTag;
    if (gate.roleTag === `role: ${role}`) return gate;
    if (Date.now() >= deadline) {
      throw new Error(
        `${label ?? 'the UI'} never rendered role ${JSON.stringify(role)} within ${timeoutMs}ms ` +
          `(last role tag: ${JSON.stringify(last)})`,
      );
    }
    await sleep(150);
  }
}

/**
 * Prove the UI produced **no write at all**: a real keystroke leaves the editor's document
 * identical and emits no outbound `SYNC` frame.
 *
 * `Input.insertText` is the same browser input path a real paste or IME would use, so this is not
 * a synthetic state change. Awareness frames are excluded on purpose: a viewer legitimately
 * publishes its cursor over the same socket (§17.5), and counting those would make "no write
 * frame" pass or fail for a reason that has nothing to do with writing text.
 */
export async function assertKeystrokeProducesNoWrite(ctx, page, { documentId, label, attempt }) {
  const before = await editorState(page);
  const framesBefore = await countOutboundSyncFrames(page, documentId);

  await typeInEditor(page, attempt);
  await sleep(1_500);

  const after = await editorState(page);
  const framesAfter = await countOutboundSyncFrames(page, documentId);
  ctx.note(`${label}: real keystroke in a read-only editor`, {
    editorLengthBefore: before.text.length,
    editorLengthAfter: after.text.length,
    textUnchanged: before.text === after.text,
    syncFramesBefore: framesBefore,
    syncFramesAfter: framesAfter,
    typedMarker: attempt,
  });

  assertEqual(
    after.text,
    before.text,
    `${label}: a real keystroke must not change the editor's document (no local Y.Text write)`,
  );
  assertEqual(
    framesAfter,
    framesBefore,
    `${label}: a real keystroke must not emit a SYNC write frame`,
  );
  return { framesBefore, framesAfter, before, after };
}

/**
 * The non-UI half: send a genuine SYNC update on the page's own authenticated socket.
 *
 * Returns the frame the instrumentation recorded **and** how many `FORBIDDEN` frames the page had
 * already received, so the caller can demand a *newer* one: an assertion that nothing was
 * persisted is worthless if nothing was ever attempted, and a denial is only evidence if it
 * answers this attempt.
 */
export async function sendBypassWrite(ctx, page, { documentId, text, label }) {
  const forbiddenBefore = await countServerErrorCode(page, 'FORBIDDEN', documentId);
  const base64 = await syncUpdateFrameBase64(text);
  const result = await sendSyncUpdateFromPage(page, documentId, base64);
  ctx.note(`${label}: SYNC update sent on the page’s own socket (UI bypassed)`, {
    ok: result.ok,
    byteLength: result.byteLength,
    forbiddenFramesBefore: forbiddenBefore,
    recordedFrame:
      result.frame === null || result.frame === undefined
        ? null
        : {
            direction: result.frame.direction,
            kind: result.frame.kind,
            frameType: result.frame.frameType,
          },
  });
  assertEqual(result.ok, true, `${label}: the bypassed write must really reach the page's socket`);
  assertEqual(
    result.frame?.frameType,
    0,
    `${label}: the injected frame must be a SYNC frame (frame type 0) — otherwise no write is tested`,
  );
  return { ...result, forbiddenBefore };
}

/**
 * Wait for the denial that answers the bypassed write.
 *
 * `afterCount` makes it a **new** frame rather than "a FORBIDDEN arrived at some point"; the
 * evidence line states the count it was waiting beyond, so the report shows the denial is caused
 * by the attempt and not by anything that happened before it.
 */
export async function waitForBypassDenial(ctx, page, { documentId, label, afterCount }) {
  const { frame, count } = await waitForNewServerErrorCode(page, 'FORBIDDEN', {
    documentId,
    afterCount,
  });
  ctx.note(`${label}: the FORBIDDEN frame the browser received`, {
    code: frame.code,
    message: frame.message ?? null,
    forbiddenFramesBefore: afterCount,
    forbiddenFramesNow: count,
    note: 'a NEW frame, received by the real browser, caused by the bypassed write',
  });
  return frame;
}
