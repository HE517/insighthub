/**
 * M2 Phase 2 — authorization evidence from a **real browser** (P2-1 … P2-5, P2-9)
 * plus the process-scoped-session observation after a real restart.
 *
 * ## What makes these scenarios evidence rather than restatement
 *
 * | Scenario | What the browser actually produces |
 * | --- | --- |
 * | P2-1 | a viewer page whose editor is read-only in the DOM *and* in `EditorState`, a real `Input.insertText` that changes nothing and emits no SYNC frame, then a genuine SYNC update on the page's own socket answered with `FORBIDDEN` — the socket stays open, nothing is persisted, no peer sees it, and the owner's later edit still arrives on the *same* socket |
 * | P2-2 | `room-joined.role === 'viewer'` as the browser received it, with `userId` injected into the join payload/query/header and `mode: 'readwrite'` claimed — plus the UI gate, and a write sent on that very socket still refused |
 * | P2-3 | byte comparison of the two `404`s as the browser's own `fetch` saw them, next to the `401` for no session |
 * | P2-4 | one table where `documentCapabilities`, HTTP, WS join, WS frame, `room-joined.role` and the browser's own editable/read-only state are compared **per role**, and the browser is the one that performed the write (or was refused it) |
 * | P2-5 | a role change taking effect on an already-connected socket; `DELETE /api/session` turning the same token into `401` on HTTP **and** on the WS upgrade |
 * | P2-9 | `Network.getCookies` (what the browser holds) against `document.cookie`, `localStorage`, `sessionStorage`, `/api/session`, the bootstrap body and the server log |
 *
 * ## Why P2-1 / P2-2 / P2-4 no longer type into a viewer's editor
 *
 * A2's role gate (`docs/DECISIONS.md` D-067) makes a viewer's editor `EditorState.readOnly` +
 * `EditorView.editable = false`, and refuses the local write in the delivery layer as well. The
 * previous form of these three scenarios typed into that editor and waited for the `FORBIDDEN`
 * frame the write used to provoke — a write the UI no longer produces, so they timed out.
 *
 * A0's decision (D-067 §4) is to answer **both** questions rather than drop one: the UI is
 * asserted to be read-only, and the server's refusal is measured again through a **non-UI path**
 * (a real SYNC update built with the frozen codec and sent over the page's own authenticated
 * socket). Nothing was weakened: the `FORBIDDEN` assertion still runs, and it is still the
 * browser that receives it.
 *
 * The membership rows these scenarios depend on are written by
 * `lib/authz-fixture.mjs` into the run's own `authz.db` and appear in each scenario's evidence
 * as `authz fixture: …` lines — there is no test-only endpoint and no shared demo document
 * standing in for per-scenario isolation (`docs/DECISIONS.md` D-063 §2a).
 */
import {
  inboundControl,
  lastRoomJoinedRole,
  outboundControl,
  pageCloseCodes,
  qaSummary,
  readConnectionStatus,
  readEditorGate,
  setOffline,
  sleep,
  typeInEditor,
  waitForConnectionStatus,
  waitForEditorText,
  waitForServerErrorCode,
} from '../lib/app.mjs';
import { DEMO_USERS, SESSION_COOKIE_NAME } from '../lib/authz-fixture.mjs';
import { loadShared, loadYjs } from '../lib/deps.mjs';
import { reconstructDurableDocument } from '../lib/durable-store.mjs';
import { assert, assertDeepEqual, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { WireOracle } from '../lib/oracle.mjs';
import {
  assertKeystrokeProducesNoWrite,
  assertUiEditable,
  assertUiReadOnly,
  sendBypassWrite,
  waitForBypassDenial,
} from '../lib/role-gate.mjs';
import { openWireSocket } from '../lib/wire-socket.mjs';

/** A per-run marker, so stale content from an earlier scenario can never satisfy an assertion. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The UI-gate and non-UI-write assertions live in `lib/role-gate.mjs`, because the F1 evidence
 * suite (`21-m2-f1-role-ui.mjs`) asks the same three questions. One wording, one place — a second
 * copy is how two scenarios end up proving slightly different things while both look green.
 */

/** The document text reconstructed from the durable bytes (the server's own truth). */
async function durableText(ctx, documentId) {
  const reconstructed = await reconstructDurableDocument(ctx.stack.dataPath, documentId);
  return reconstructed.text;
}

/** Wait until the durable text satisfies `predicate`, returning the last observed text. */
async function waitForDurableText(ctx, documentId, predicate, { timeoutMs = 25_000, label } = {}) {
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

/**
 * Attempt one WebSocket upgrade and report the **handshake outcome**.
 *
 * Never throws on a refusal: a `401` on the upgrade is a result these scenarios assert, and it
 * has to be observable as a status code rather than as "the socket did not open".
 */
async function attemptUpgrade(url, cookie, { timeoutMs = 15_000 } = {}) {
  const socket = await openWireSocket(url, { cookie });
  const outcome = await Promise.race([
    socket.settled(),
    sleep(timeoutMs).then(() => ({ kind: 'timeout' })),
  ]);
  return { socket, outcome };
}

/** The `Set-Cookie` pair for a session cookie out of `Network.getCookies` output. */
function findSessionCookie(cookies) {
  return cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME) ?? null;
}

/**
 * Wait until another peer has received `needle`.
 *
 * Persistence happens *before* broadcast (`docs/CONTRACTS.md` §14.3), so a positive "the peer saw
 * it" check has to allow the relay a moment; a negative one must not (it uses a sleep instead).
 */
async function waitForPeerText(peer, needle, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (peer.text.includes(needle)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/** Headers that legitimately differ between two identical responses (wall clock only). */
const VOLATILE_HEADERS = new Set(['date']);

function comparableHeaders(headers) {
  const comparable = {};
  for (const [key, value] of Object.entries(headers)) {
    if (VOLATILE_HEADERS.has(key)) continue;
    comparable[key] = value;
  }
  return comparable;
}

export function register(runner) {
  /* ================================================================== *
   * P2-1 — a viewer cannot write, and stays a reader
   * ================================================================== */
  runner.scenario(
    'p2/1-viewer-cannot-write',
    'a viewer page is read-only (real keystrokes write nothing) — and a SYNC update that bypasses the UI is still refused with FORBIDDEN, unpersisted and unbroadcast, while the socket keeps reading',
    async (ctx) => {
      // `demo-document` is the seeded fixture: ada=owner, grace=editor, linus=viewer
      // (`apps/server/src/authz/demo-fixture.ts`). Using it means this scenario proves the
      // *seeded* roles, not a role the harness arranged for itself — and `role: null` means the
      // page-opening path writes no membership row at all (D-065 §5 / A6 F3).
      const documentId = 'demo-document';
      const existing = marker('VIEWER-READ');
      const attempted = marker('VIEWER-WRITE');
      const later = marker('OWNER-AFTER');

      const owner = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'owner',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      try {
        assertEqual(owner.roomJoinedRole, 'owner', 'the seeded owner must be told role=owner');
        owner.append(`${existing}\n`);
        await waitForDurableText(ctx, documentId, (text) => text.includes(existing), {
          label: 'the seeded content to be durable',
        });
        ctx.note('seeded content', JSON.stringify(existing));

        const viewer = await ctx.newAppPage({ documentId, as: DEMO_USERS.linus, role: null });
        const identityTag = await viewer.evaluate(
          () => document.querySelector('[data-testid="session-identity"]')?.textContent ?? null,
        );
        ctx.note('browser session identity', identityTag);
        assertIncludes(identityTag ?? '', 'Linus', 'the page must hold the viewer session');

        // §17.5: `room-joined.role` is the only channel that tells a client its own role.
        const role = await lastRoomJoinedRole(viewer, documentId);
        ctx.note('room-joined.role in the browser', role);
        assertEqual(role, 'viewer', "the browser's own room-joined must report role=viewer");

        // A viewer *can* read: the stored content is rendered.
        const visible = await waitForEditorText(viewer, (text) => text.includes(existing), {
          timeoutMs: 25_000,
          label: 'the viewer to render the existing content',
        });
        ctx.note('viewer editor text (first 120)', JSON.stringify(visible.text.slice(0, 120)));
        assertIncludes(visible.text, existing, 'a viewer must be able to read the document');

        const socketsBefore = await qaSummary(viewer);

        /* ---------- (a) the UI half: a viewer page cannot produce a write ---------- */
        // Re-aimed by A0 (D-067 §4). Before A2's gate this scenario typed into the viewer's
        // editor and asserted the FORBIDDEN frame that resulted. The gate now makes that write
        // impossible, so the same keystroke is used to prove the *opposite* fact — the UI
        // produces nothing — and the server's refusal is proven separately, over the wire.
        await assertUiReadOnly(ctx, viewer, { documentId, role: 'viewer' });
        await assertKeystrokeProducesNoWrite(ctx, viewer, {
          documentId,
          label: 'viewer',
          attempt: attempted,
        });

        /* ---------- (b) the server half: bypass the UI, over the page's own socket ---------- */
        // A genuine SYNC update on the browser's authenticated socket. Nothing in the UI is
        // involved: this is what a client that ignores its own role gate would send.
        const bypass = await sendBypassWrite(ctx, viewer, {
          documentId,
          text: attempted,
          label: 'viewer',
        });

        const denial = await waitForBypassDenial(ctx, viewer, {
          documentId,
          label: 'viewer',
          afterCount: bypass.forbiddenBefore,
        });
        ctx.note('error frame the browser received', denial);

        // The denial is non-fatal: the socket is still there and no fatal close happened.
        const afterDenial = await qaSummary(viewer);
        const closes = await pageCloseCodes(viewer);
        ctx.note('transport after the denial', {
          socketsBefore: socketsBefore.sockets,
          socketsAfter: afterDenial.sockets,
          liveDocumentSockets: afterDenial.liveDocumentSockets,
          closeCodes: closes.map((entry) => entry.code),
        });
        assert(
          afterDenial.liveDocumentSockets >= 1,
          'a FORBIDDEN denial must not close the collaboration socket (§17.5)',
        );
        assertEqual(
          afterDenial.sockets,
          socketsBefore.sockets,
          'the denial must not force the client to reconnect (no new socket)',
        );
        assert(
          !closes.some((entry) => entry.code === 1008),
          'a refused *write* must never be delivered as a policy-violation close',
        );

        // Give a broken server every chance to persist it before asserting that it did not.
        await sleep(3_000);
        const stored = await durableText(ctx, documentId);
        ctx.note('durable text tail after the attempt', JSON.stringify((stored ?? '').slice(-200)));
        assert(
          !(stored ?? '').includes(attempted),
          'a refused viewer write must never reach the durable store (§17.5: no apply/persist)',
        );
        assert(!owner.text.includes(attempted), 'the other peer must never see the refused write');

        // The same socket must still receive the owner's later edit — "a reader stays a reader".
        owner.append(`${later}\n`);
        const received = await waitForEditorText(viewer, (text) => text.includes(later), {
          timeoutMs: 25_000,
          label: "the owner's later edit to arrive on the viewer's socket",
        });
        ctx.note('viewer editor after the owner edit', {
          length: received.text.length,
          containsOwnerEdit: received.text.includes(later),
        });
        assertIncludes(
          received.text,
          later,
          'the viewer must still receive updates after being denied a write',
        );

        await waitForDurableText(ctx, documentId, (text) => text.includes(later), {
          label: "the owner's edit to be durable",
        });
        const editorAfter = (await waitForEditorText(viewer, () => true)).text;
        ctx.note('viewer local text after the refused bypass', {
          containsRefusedText: editorAfter.includes(attempted),
          note:
            'the refused frame was built from a throwaway Y.Doc, so the client never integrated ' +
            'it and its own text is intact: the divergence D-064 §2 item 3 records comes from a ' +
            'client writing its OWN Y.Text, which A2’s gate now prevents',
        });
        assert(
          !editorAfter.includes(attempted),
          'the refused bypassed update must never appear in the client’s document either',
        );
        // The gate must survive all of it: the viewer's editor is still read-only.
        const gateAfter = await readEditorGate(viewer);
        assertEqual(
          gateAfter.contentEditable,
          'false',
          'the viewer’s editor must still be read-only after being refused a write',
        );
      } finally {
        owner.close();
      }
    },
  );

  /* ================================================================== *
   * P2-2 — identity and mode cannot be self-declared
   * ================================================================== */
  runner.scenario(
    'p2/2-identity-cannot-be-self-declared',
    "userId in the join payload / query / header and mode=readwrite change nothing: the page's UI is read-only, its socket is still role=viewer, and a write sent on it is still refused",
    async (ctx) => {
      const documentId = `p2-identity-${marker('doc')}`;
      const base = marker('IDENTITY-BASE');
      const attempted = marker('IDENTITY-WRITE');

      // Explicit roles: this scenario is about the wire, so the membership must be stated here
      // rather than inherited from a fixture default.
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
        owner.append(`${base}\n`);
        await waitForDurableText(ctx, documentId, (text) => text.includes(base), {
          label: 'the base content to be durable',
        });

        // The browser page is `demo-linus`; the client always sends `mode: 'readwrite'` on its
        // own join (`apps/web/src/collab/internal/sync-provider.ts`), so the claim is visible in
        // the page's outbound frames without any injection at all.
        const viewer = await ctx.newAppPage({ documentId, as: DEMO_USERS.linus, role: null });
        await waitForEditorText(viewer, (text) => text.includes(base), {
          timeoutMs: 25_000,
          label: 'the viewer page to join and hydrate',
        });
        const outboundJoins = (await outboundControl(viewer, documentId)).filter(
          (frame) => frame.messageType === 'join-room',
        );
        ctx.note(
          'join-room frames the browser sent',
          outboundJoins.map((frame) => ({ mode: frame.mode, claimedUserId: frame.claimedUserId ?? null })),
        );
        assert(
          outboundJoins.length >= 1 && outboundJoins.every((frame) => frame.mode === 'readwrite'),
          "the real client's join must claim mode=readwrite (the advisory field)",
        );
        assertEqual(
          await lastRoomJoinedRole(viewer, documentId),
          'viewer',
          'a readwrite claim must not change the role the server reports',
        );

        // Now inject the field the frozen schema does not have, through the page's own socket:
        // a second `join-room` carrying `userId: 'demo-ada'`.
        const shared = await loadShared();
        const before = (await inboundControl(viewer, documentId)).filter(
          (frame) => frame.messageType === 'room-joined',
        ).length;
        const injected = await viewer.evaluate(
          (id, envelope) => window.__qa.sendControl(id, envelope),
          documentId,
          JSON.stringify(
            shared.createEnvelope(shared.WS_MESSAGE_TYPES.joinRoom, {
              documentId,
              protocolVersion: shared.PROTOCOL_VERSION,
              mode: 'readwrite',
              userId: DEMO_USERS.ada,
            }),
          ),
        );
        ctx.note('payload-injecting join sent from the page', injected);
        const injectedFrames = (await outboundControl(viewer, documentId)).filter(
          (frame) => frame.messageType === 'join-room' && frame.claimedUserId !== undefined,
        );
        ctx.note(
          'join-room frames carrying a claimed userId',
          injectedFrames.map((frame) => ({
            mode: frame.mode,
            claimedUserId: frame.claimedUserId,
          })),
        );
        assert(
          injectedFrames.some((frame) => frame.claimedUserId === DEMO_USERS.ada),
          'the injected join must really have carried userId on the wire (otherwise nothing is tested)',
        );

        // Wait for the acknowledgement of the injected join.
        const deadline = Date.now() + 15_000;
        let roleAfterInjection = null;
        while (Date.now() < deadline) {
          const joins = (await inboundControl(viewer, documentId)).filter(
            (frame) => frame.messageType === 'room-joined',
          );
          if (joins.length > before) {
            roleAfterInjection = joins[joins.length - 1].role;
            break;
          }
          await sleep(100);
        }
        ctx.note('room-joined.role after injecting userId into the payload', roleAfterInjection);
        assertEqual(
          roleAfterInjection,
          'viewer',
          'a userId in the join payload must not change the resolved role',
        );

        /* ---------- the UI half: the page cannot produce the write at all ---------- */
        await assertUiReadOnly(ctx, viewer, { documentId, role: 'viewer' });
        await assertKeystrokeProducesNoWrite(ctx, viewer, {
          documentId,
          label: 'viewer after the identity injection',
          attempt: attempted,
        });

        /* ---------- the server half: send it over the socket that made the claims ---------- */
        // This is the socket that carried `userId: 'demo-ada'` and `mode: 'readwrite'`. If any of
        // that were trusted, this frame would be applied. It is refused instead, which is the
        // claim this scenario has always made — now measured where it is actually decided.
        const bypass = await sendBypassWrite(ctx, viewer, {
          documentId,
          text: attempted,
          label: 'viewer after the identity injection',
        });

        const denial = await waitForBypassDenial(ctx, viewer, {
          documentId,
          label: 'viewer after the identity injection',
          afterCount: bypass.forbiddenBefore,
        });
        ctx.note('browser denial after the identity injection', denial);
        await sleep(2_000);
        const stored = await durableText(ctx, documentId);
        assert(
          !(stored ?? '').includes(attempted),
          'a mode=readwrite + userId claim must not buy a write (nothing may be persisted)',
        );
        assert(
          !owner.text.includes(attempted),
          'a mode=readwrite + userId claim must not buy a broadcast to the other peer',
        );

        // Query string + request header, which a browser cannot forge: the oracle is still a
        // *real* client on the real wire, so this covers the two carriers a page cannot set.
        const queryAttempt = marker('QUERY-WRITE');
        const queried = await WireOracle.connect({
          url: ctx.stack.wsUrl,
          documentId,
          label: 'viewer-with-query-and-header',
          userId: DEMO_USERS.linus,
          role: 'viewer',
          mode: 'readwrite',
          query: { userId: DEMO_USERS.ada, mode: 'readwrite' },
          headers: { 'x-insighthub-user': DEMO_USERS.ada },
          joinExtras: { userId: DEMO_USERS.ada },
        });
        try {
          ctx.note('query/header claimant room-joined.role', queried.roomJoinedRole);
          assertEqual(
            queried.roomJoinedRole,
            'viewer',
            'a userId in the query or a header must not change the resolved role',
          );
          queried.append(queryAttempt);
          await queried.waitForErrorCode('FORBIDDEN');
          ctx.note('query/header claimant server errors', queried.serverErrors);
        } finally {
          queried.close();
        }
        await sleep(2_000);
        const afterQueried = await durableText(ctx, documentId);
        assert(
          !(afterQueried ?? '').includes(queryAttempt),
          'the query/header claimant’s update must not be persisted',
        );

        // HTTP: the same claim in a query string and a header is ignored as well.
        const linus = await ctx.authz.session(DEMO_USERS.linus);
        const claimed = await ctx.authz.json(
          `/api/documents/${documentId}?userId=${DEMO_USERS.ada}`,
          { cookie: linus.cookie, headers: { 'x-insighthub-user': DEMO_USERS.ada } },
        );
        ctx.note('HTTP with a claimed userId in query+header', {
          status: claimed.status,
          id: claimed.body?.id ?? null,
        });
        assertEqual(claimed.status, 200, 'a viewer may read the document it belongs to');
        const identity = await ctx.authz.json('/api/session', {
          cookie: linus.cookie,
          headers: { 'x-insighthub-user': DEMO_USERS.ada },
        });
        ctx.note('GET /api/session with a claimed userId', identity.body);
        assertEqual(identity.body?.userId, DEMO_USERS.linus, 'the session decides the identity');
      } finally {
        owner.close();
      }
    },
  );

  /* ================================================================== *
   * P2-3 — non-disclosure: one 404 for "unknown" and "not yours"
   * ================================================================== */
  runner.scenario(
    'p2/3-non-disclosure-404',
    'unknown document and no-membership document produce the same 404 (status, body, headers); no session is 401',
    async (ctx) => {
      const tab = marker('doc');
      const publicDocument = `p2-public-${tab}`;
      const secretDocument = `p2-secret-${tab}`;
      const unknownDocument = `p2-unknown-${tab}`;
      const secret = marker('SECRET');

      // `ada` owns the public document and has **no** membership on the secret one, which is
      // owned by `grace`. The secret document really exists and really has content.
      await ctx.authz.grant(publicDocument, DEMO_USERS.ada, 'owner');
      await ctx.authz.grant(secretDocument, DEMO_USERS.grace, 'owner');

      const grace = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId: secretDocument,
        label: 'grace',
        userId: DEMO_USERS.grace,
        role: 'owner',
      });
      try {
        grace.append(`${secret}\n`);
        await waitForDurableText(ctx, secretDocument, (text) => text.includes(secret), {
          label: 'the secret document to be durable',
        });

        const page = await ctx.newAppPage({ documentId: publicDocument, as: DEMO_USERS.ada });
        const origin = await page.evaluate(() => location.origin);

        // The page's own `fetch`, with the session cookie the browser holds.
        const browserProbe = async (path, credentials = 'include') =>
          page.evaluate(
            async (url, mode) => {
              const response = await fetch(url, { credentials: mode });
              const body = await response.text();
              const headers = {};
              for (const [key, value] of response.headers.entries()) headers[key.toLowerCase()] = value;
              return { status: response.status, body, headers };
            },
            path,
            credentials,
          );

        const unknown = await browserProbe(`/api/documents/${unknownDocument}`);
        const notMember = await browserProbe(`/api/documents/${secretDocument}`);
        const mine = await browserProbe(`/api/documents/${publicDocument}`);
        const anonymous = await browserProbe(`/api/documents/${publicDocument}`, 'omit');

        ctx.note('browser fetch (ada) · unknown document', {
          status: unknown.status,
          body: unknown.body,
        });
        ctx.note('browser fetch (ada) · existing document without membership', {
          status: notMember.status,
          body: notMember.body,
        });
        ctx.note('browser fetch (ada) · own document', { status: mine.status });
        ctx.note('browser fetch (no credentials) · own document', {
          status: anonymous.status,
          body: anonymous.body,
        });

        assertEqual(anonymous.status, 401, 'no session must be 401 (§17.4)');
        assertEqual(unknown.status, 404, 'an unknown document must be 404');
        assertEqual(notMember.status, 404, 'a document outside the membership must be 404');
        assertEqual(mine.status, 200, 'the caller’s own document must be 200');

        // Byte-identical: same body, same status, same headers (except the clock).
        assertEqual(
          notMember.body,
          unknown.body,
          'the two 404 bodies must be byte-identical (non-disclosure, §17.4)',
        );
        assertDeepEqual(
          comparableHeaders(notMember.headers),
          comparableHeaders(unknown.headers),
          'the two 404 header sets must be identical (non-disclosure, §17.4)',
        );
        ctx.note('404 headers compared', comparableHeaders(unknown.headers));

        // The same three requests from Node, so the claim does not depend on the proxy layer.
        const ada = await ctx.authz.session(DEMO_USERS.ada);
        const nodeUnknown = await ctx.authz.json(`/api/documents/${unknownDocument}`, {
          cookie: ada.cookie,
        });
        const nodeNotMember = await ctx.authz.json(`/api/documents/${secretDocument}`, {
          cookie: ada.cookie,
        });
        const nodeAnonymous = await ctx.authz.json(`/api/documents/${publicDocument}`);
        ctx.note('node fetch · statuses', {
          unknown: nodeUnknown.status,
          notMember: nodeNotMember.status,
          noCookie: nodeAnonymous.status,
        });
        assertEqual(nodeAnonymous.status, 401, 'no cookie must be 401');
        // Objects, so identity is not the question — the two answers must be *equal*.
        assertDeepEqual(nodeUnknown.body, nodeNotMember.body, 'the two 404 bodies must match (node)');
        assertDeepEqual(
          comparableHeaders(nodeNotMember.headers),
          comparableHeaders(nodeUnknown.headers),
          'the two 404 header sets must match (node)',
        );

        // The list endpoint must not leak it either.
        const list = await ctx.authz.json('/api/documents', { cookie: ada.cookie });
        const listedIds = (list.body?.documents ?? []).map((document) => document.id);
        ctx.note('GET /api/documents for ada', listedIds);
        assert(
          !listedIds.includes(secretDocument),
          'the documents list must not contain a document outside the membership',
        );
        assert(listedIds.includes(publicDocument), 'the list must contain the caller’s document');

        // §17.4's third 404 branch ("no `canRead`") is not constructible with the frozen role
        // vocabulary: every role can read. Recorded instead of pretended.
        const shared = await loadShared();
        const readDeniedRoles = shared.DOCUMENT_ROLES.filter(
          (role) => !shared.documentCapabilities.canRead(role),
        );
        ctx.note(
          'roles without canRead (the third 404 branch)',
          readDeniedRoles.length === 0 ? 'none — every role can read in Phase 2' : readDeniedRoles,
        );
      } finally {
        grace.close();
      }
    },
  );

  /* ================================================================== *
   * P2-4 — one table across documentCapabilities / HTTP / WS join / WS frame / role
   * ================================================================== */
  runner.scenario(
    'p2/4-role-capability-consistency',
    'owner, editor and viewer get the same answer from documentCapabilities, HTTP, the WS join, the WS frame, room-joined.role and the browser’s own UI gate',
    async (ctx) => {
      const documentId = `p2-matrix-${marker('doc')}`;
      const shared = await loadShared();
      const roles = [
        { role: 'owner', userId: DEMO_USERS.ada },
        { role: 'editor', userId: DEMO_USERS.grace },
        { role: 'viewer', userId: DEMO_USERS.linus },
      ];
      for (const entry of roles) {
        await ctx.authz.grant(documentId, entry.userId, entry.role);
      }

      // One witness peer for the whole table: every accepted write must reach it, and every
      // refused write must not.
      const witness = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'witness',
        userId: DEMO_USERS.ada,
        role: 'owner',
      });
      const rows = [];
      try {
        witness.append(`${marker('SEED')}\n`);
        await waitForDurableText(ctx, documentId, (text) => text.length > 0, {
          label: 'the seed write',
        });

        for (const { role, userId } of roles) {
          const expected = {
            canRead: shared.documentCapabilities.canRead(role),
            canEdit: shared.documentCapabilities.canEdit(role),
          };
          const text = marker(`MATRIX-${role.toUpperCase()}`);

          // 1. HTTP (`GET /api/documents/:id` takes `canRead`; Phase 2 has no HTTP endpoint
          //    that takes `canEdit`, which the row records rather than hides).
          const session = await ctx.authz.session(userId);
          const http = await ctx.authz.json(`/api/documents/${documentId}`, {
            cookie: session.cookie,
          });

          // 2/5. WS join + the role the server reported.
          const peer = await WireOracle.connect({
            url: ctx.stack.wsUrl,
            documentId,
            label: `matrix-${role}`,
            userId,
            role,
            mode: 'readwrite',
          });
          let frameOutcome;
          let admitted;
          let reportedRole;
          try {
            admitted = peer.joined;
            reportedRole = peer.roomJoinedRole;
            peer.append(text);
            frameOutcome = expected.canEdit
              ? await waitForDurableText(ctx, documentId, (value) => value.includes(text), {
                  label: `${role} write to become durable`,
                }).then(() => 'applied')
              : await peer.waitForErrorCode('FORBIDDEN').then(() => 'denied');
          } finally {
            peer.close();
          }
          // `apply → persist → broadcast`, so the peer's view needs one beat after persistence.
          await sleep(1_000);
          const durableAfter = await durableText(ctx, documentId);
          const persisted = (durableAfter ?? '').includes(text);
          const broadcast = witness.text.includes(text);

          // 3. The browser must agree with all of that: its own `room-joined.role`, the UI gate
          //    that role produces, and an actual write attempt.
          const page = await ctx.newAppPage({ documentId, as: userId, role: null });
          const browserRole = await lastRoomJoinedRole(page, documentId);
          const browserText = marker(`BROWSER-${role.toUpperCase()}`);
          const gate = expected.canEdit
            ? await assertUiEditable(ctx, page, { role })
            : await assertUiReadOnly(ctx, page, { documentId, role });
          if (expected.canEdit) {
            await typeInEditor(page, browserText);
            await waitForDurableText(ctx, documentId, (value) => value.includes(browserText), {
              timeoutMs: 25_000,
              label: `the ${role}'s browser keystroke to persist`,
            });
          } else {
            // The UI can no longer generate this write (that is the point of A2's gate), so the
            // refusal is measured with a real SYNC frame on the page's own socket instead of
            // being dropped (D-067 §4). Nothing about the server-side assertion is weakened.
            await assertKeystrokeProducesNoWrite(ctx, page, {
              documentId,
              label: `${role} browser`,
              attempt: browserText,
            });
            const bypass = await sendBypassWrite(ctx, page, {
              documentId,
              text: browserText,
              label: `${role} browser`,
            });
            assertEqual(bypass.ok, true, `${role}: the bypassed write must reach the socket`);
            await waitForBypassDenial(ctx, page, {
              documentId,
              label: `${role} browser`,
              afterCount: bypass.forbiddenBefore,
            });
            await sleep(2_000);
            assert(
              !(await durableText(ctx, documentId)).includes(browserText),
              `a ${role}'s browser-originated update must not persist`,
            );
          }
          const browserPersisted = (await durableText(ctx, documentId)).includes(browserText);
          await page.close();

          rows.push({
            role,
            expected,
            http: { status: http.status, canReadAnswer: http.status === 200 },
            wsJoin: { admitted, role: reportedRole },
            wsFrame: { outcome: frameOutcome, persisted, broadcast },
            browser: {
              roomJoinedRole: browserRole,
              keystrokePersisted: browserPersisted,
              ui: {
                contentEditable: gate.contentEditable,
                viewReadOnly: gate.viewReadOnly,
                noticePresent: gate.notice.present,
                noticeVisible: gate.notice.visible,
                noticeText: gate.notice.text,
              },
            },
          });
        }

        ctx.note('capability table', rows);
        for (const row of rows) {
          assertEqual(
            row.wsJoin.admitted,
            true,
            `${row.role}: every role holds canRead, so every join must be admitted`,
          );
          assertEqual(
            row.http.canReadAnswer,
            row.expected.canRead,
            `${row.role}: HTTP must agree with documentCapabilities.canRead`,
          );
          assertEqual(
            row.wsJoin.role,
            row.role,
            `${row.role}: room-joined.role must equal the membership role`,
          );
          assertEqual(
            row.browser.roomJoinedRole,
            row.role,
            `${row.role}: the browser's own room-joined.role must agree`,
          );
          assertEqual(
            row.wsFrame.outcome,
            row.expected.canEdit ? 'applied' : 'denied',
            `${row.role}: the WS frame gate must agree with documentCapabilities.canEdit`,
          );
          assertEqual(
            row.wsFrame.persisted,
            row.expected.canEdit,
            `${row.role}: persistence must agree with canEdit`,
          );
          assertEqual(
            row.wsFrame.broadcast,
            row.expected.canEdit,
            `${row.role}: broadcast must agree with canEdit`,
          );
          assertEqual(
            row.browser.keystrokePersisted,
            row.expected.canEdit,
            `${row.role}: the browser keystroke must agree with canEdit`,
          );
          // The UI gate is the fifth column of the same table (D-065 §4 point 1): what the
          // editor allows locally must be the same `documentCapabilities.canEdit` answer the
          // server enforces, and a non-editing role must be told why.
          assertEqual(
            row.browser.ui.contentEditable,
            row.expected.canEdit ? 'true' : 'false',
            `${row.role}: the editor's editability must agree with canEdit`,
          );
          assertEqual(
            row.browser.ui.viewReadOnly,
            !row.expected.canEdit,
            `${row.role}: EditorState.readOnly must equal !canEdit`,
          );
          assertEqual(
            row.browser.ui.noticePresent,
            !row.expected.canEdit,
            `${row.role}: the read-only notice must appear exactly when the role may not edit`,
          );
        }
        ctx.note(
          'HTTP and canEdit',
          'no Phase 2 HTTP endpoint takes canEdit (`GET /api/documents/:id` is canRead only); ' +
            'canEdit is covered at the WS frame and in the browser, where it is enforced',
        );
      } finally {
        witness.close();
      }
    },
  );

  /* ================================================================== *
   * P2-5a — a role change is re-evaluated on a live socket
   * ================================================================== */
  runner.scenario(
    'p2/5-role-change-is-re-evaluated',
    'the capability gate is re-asked per frame: a demoted editor is refused and a promoted viewer is accepted, both without reconnecting',
    async (ctx) => {
      const documentId = `p2-rolechange-${marker('doc')}`;
      const beforeDemotion = marker('BEFORE-DEMOTION');
      const afterDemotion = marker('AFTER-DEMOTION');
      const refusedWhileViewer = marker('REFUSED-WHILE-VIEWER');
      const acceptedAfterPromotion = marker('PROMOTED-WRITE');

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
        owner.append(`${marker('BASE')}\n`);
        await waitForDurableText(ctx, documentId, (text) => text.length > 0, {
          label: 'the base write',
        });

        /* ---------- (a) demotion, observed in the real browser ---------- */
        const editor = await ctx.newAppPage({ documentId, as: DEMO_USERS.linus, role: null });
        const socketsBefore = (await qaSummary(editor)).sockets;
        assertEqual(
          await lastRoomJoinedRole(editor, documentId),
          'editor',
          'the page must start as an editor',
        );
        await typeInEditor(editor, beforeDemotion);
        await waitForDurableText(ctx, documentId, (text) => text.includes(beforeDemotion), {
          timeoutMs: 25_000,
          label: 'the editor write to be persisted',
        });

        const demoted = await ctx.authz.grant(documentId, DEMO_USERS.linus, 'viewer');
        ctx.note('membership after demotion', demoted);
        await sleep(500);
        await typeInEditor(editor, afterDemotion);
        await waitForServerErrorCode(editor, 'FORBIDDEN', { documentId });
        await sleep(2_000);
        const afterRefusal = await durableText(ctx, documentId);
        ctx.note('browser transport across the demotion', {
          socketsBefore,
          socketsAfter: (await qaSummary(editor)).sockets,
        });
        assert(
          !(afterRefusal ?? '').includes(afterDemotion),
          'a demoted editor’s next keystroke must not be persisted',
        );
        assertEqual(
          (await qaSummary(editor)).sockets,
          socketsBefore,
          'the demotion must take effect on the live socket, not by reconnecting',
        );
        assertIncludes(
          afterRefusal,
          beforeDemotion,
          'the write accepted while the page was an editor must stay',
        );

        /* ---------- (b) promotion, observed on one live oracle socket ---------- */
        // The refused frame is built from a throwaway `Y.Doc`, so the peer's own document stays
        // clean and a later accepted write can be integrated (see `sendRawSyncUpdate`).
        const [Y, shared] = await Promise.all([loadYjs(), loadShared()]);
        const throwaway = new Y.Doc();
        throwaway.getText(shared.DOCUMENT_TEXT_KEY).insert(0, refusedWhileViewer);
        const peerIsViewer =
          (await ctx.authz.membership(documentId, DEMO_USERS.linus))?.role === 'viewer';
        assert(peerIsViewer, 'the peer must be a viewer before the promotion');
        const promotedPeer = await WireOracle.connect({
          url: ctx.stack.wsUrl,
          documentId,
          label: 'promoted-peer',
          userId: DEMO_USERS.linus,
          role: 'viewer',
        });
        try {
          promotedPeer.sendRawSyncUpdate(Y.encodeStateAsUpdate(throwaway));
          await promotedPeer.waitForErrorCode('FORBIDDEN');
          await sleep(2_000);
          assert(
            !(await durableText(ctx, documentId)).includes(refusedWhileViewer),
            'a viewer’s update frame must not be persisted',
          );

          const promoted = await ctx.authz.grant(documentId, DEMO_USERS.linus, 'editor');
          ctx.note('membership after promotion', promoted);
          await sleep(500);
          const textBefore = await durableText(ctx, documentId);
          promotedPeer.append(acceptedAfterPromotion);
          const afterPromotion = await waitForDurableText(
            ctx,
            documentId,
            (text) => text.includes(acceptedAfterPromotion),
            { timeoutMs: 25_000, label: 'the promoted peer’s write to be persisted' },
          );
          ctx.note('promotion outcome', {
            persisted: afterPromotion.includes(acceptedAfterPromotion),
            socketStillOpen: promotedPeer.joined,
          });
          assert(
            promotedPeer.joined,
            'the promotion must not require a new socket (the peer never reconnected)',
          );
          const broadcast = await waitForPeerText(owner, acceptedAfterPromotion);
          ctx.note('promoted write reached the other peer', broadcast);
          assert(broadcast, 'the promoted peer’s write must be broadcast to the other peer');
          ctx.note('durable text length before/after the promotion', {
            before: textBefore.length,
            after: afterPromotion.length,
          });
        } finally {
          promotedPeer.close();
        }
      } finally {
        owner.close();
      }
    },
  );

  /* ================================================================== *
   * P2-5b — `DELETE /api/session` invalidates the token everywhere
   * ================================================================== */
  runner.scenario(
    'p2/5-session-revocation-is-everywhere',
    'after DELETE /api/session the same token is 401 on HTTP and on the WS upgrade, through the proxy and directly',
    async (ctx) => {
      const documentId = `p2-revoke-${marker('doc')}`;
      await ctx.authz.grant(documentId, DEMO_USERS.ada, 'owner');

      const session = await ctx.authz.session(DEMO_USERS.ada);
      const live = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'revoked-peer',
        userId: DEMO_USERS.ada,
        cookie: session.cookie,
      });
      try {
        live.append(`${marker('PRE-REVOKE')}\n`);
        await waitForDurableText(ctx, documentId, (text) => text.length > 0, {
          label: 'the pre-revocation write',
        });

        const before = await ctx.authz.json('/api/session', { cookie: session.cookie });
        assertEqual(before.status, 200, 'the session must be live before the revocation');

        const deletion = await ctx.authz.request('/api/session', {
          method: 'DELETE',
          cookie: session.cookie,
        });
        ctx.note('DELETE /api/session', {
          status: deletion.status,
          clearedCookie: (deletion.headers.get('set-cookie') ?? '')
            .toLowerCase()
            .includes(`${SESSION_COOKIE_NAME}=;`) ||
            (deletion.headers.get('set-cookie') ?? '').toLowerCase().includes('expires=thu, 01 jan 1970'),
        });
        assertEqual(deletion.status, 204, 'DELETE /api/session must answer 204');

        const after = await ctx.authz.json('/api/session', { cookie: session.cookie });
        const document = await ctx.authz.json(`/api/documents/${documentId}`, {
          cookie: session.cookie,
        });
        ctx.note('same token after the revocation', {
          session: { status: after.status, body: after.body },
          document: { status: document.status, body: document.body },
        });
        assertEqual(after.status, 401, 'the destroyed token must be 401 on GET /api/session');
        assertEqual(document.status, 401, 'the destroyed token must be 401 on the document API');

        // The upgrade, both paths: through the Vite proxy (what a browser uses) and directly.
        for (const [label, url] of [
          ['through the Vite proxy', ctx.stack.wsUrl],
          ['directly to the backend', `ws://127.0.0.1:${ctx.stack.serverPort}/ws`],
        ]) {
          const { socket, outcome } = await attemptUpgrade(url, session.cookie);
          try {
            const body = outcome.kind === 'refused' ? await socket.refusalBody({ timeoutMs: 3_000 }) : '';
            ctx.note(`WS upgrade with the destroyed token (${label})`, { ...outcome, body });
            assertEqual(outcome.kind, 'refused', `${label}: the upgrade must be refused`);
            assertEqual(outcome.status, 401, `${label}: the refusal must be HTTP 401`);
            assertEqual(
              socket.upgrade.status,
              401,
              `${label}: the observable upgrade status must be 401`,
            );
            // The status is the contract (§17.5). The body is checked when the transport
            // delivers one: a dev proxy may answer the refusal itself and forwards no body,
            // which is a property of the proxy, not of the server's answer.
            if (body !== '') {
              assertIncludes(body, 'unauthenticated', `${label}: the refusal body`);
            } else {
              ctx.note(`${label}: no refusal body was delivered (proxy behaviour)`, true);
            }
          } finally {
            socket.terminate();
          }
        }

        // An upgrade with a valid *other* session still works, so the refusal above is about the
        // token and not about a broken server.
        const fresh = await ctx.authz.session(DEMO_USERS.ada);
        const { socket: goodSocket, outcome: goodOutcome } = await attemptUpgrade(
          ctx.stack.wsUrl,
          fresh.cookie,
        );
        ctx.note('WS upgrade with a freshly bootstrapped session', goodOutcome);
        try {
          assertEqual(goodOutcome.kind, 'open', 'a fresh session must still be able to connect');
        } finally {
          goodSocket.terminate();
        }

        // Contract boundary, recorded rather than asserted: §17.2 says a destroyed token yields
        // 401 "everywhere", and a socket that is already open is not a request. This measures
        // what actually happens so A7 can decide whether "everywhere" includes it.
        const late = marker('POST-REVOKE');
        live.append(`${late}\n`);
        await sleep(2_500);
        const lateDurable = await durableText(ctx, documentId);
        live.close();
        ctx.note('an already-open socket after the revocation', {
          writeApplied: (lateDurable ?? '').includes(late),
          note:
            'not asserted: the contract speaks about requests, and §17.5 re-checks the membership ' +
            'per frame; the session is resolved once at the upgrade. Recorded for A7.',
        });

        // Browser side: the page really loses its cookie.
        const page = await ctx.newAppPage({ documentId, as: DEMO_USERS.ada });
        const pageBefore = await page.evaluate(async () => {
          const response = await fetch('/api/session', { credentials: 'include' });
          return { status: response.status };
        });
        const pageDelete = await page.evaluate(async () => {
          const response = await fetch('/api/session', {
            method: 'DELETE',
            credentials: 'include',
          });
          return { status: response.status };
        });
        const pageAfter = await page.evaluate(async () => {
          const response = await fetch('/api/session', { credentials: 'include' });
          return { status: response.status, body: await response.text() };
        });
        ctx.note('browser session revocation', {
          before: pageBefore.status,
          delete: pageDelete.status,
          after: pageAfter.status,
        });
        assertEqual(pageBefore.status, 200, 'the page must have a live session first');
        assertEqual(pageDelete.status, 204, 'the page must be able to destroy its own session');
        assertEqual(pageAfter.status, 401, 'after that the page must be unauthenticated');

        // Observation: the page's reconnect loop cannot recover on its own (no re-bootstrap).
        await setOffline(page, true);
        await waitForConnectionStatus(page, ['reconnecting', 'offline', 'error'], {
          timeoutMs: 20_000,
        });
        await setOffline(page, false);
        await sleep(8_000);
        const status = await readConnectionStatus(page);
        const summary = await qaSummary(page);
        ctx.note('page after losing its session', {
          status,
          bootstrapCalls: summary.bootstrapCalls,
          closeCodes: (await pageCloseCodes(page)).map((entry) => entry.code),
          note: 'not asserted: the client has no re-bootstrap path (reported as a Phase 2 limitation)',
        });
      } finally {
        live.close();
      }
    },
  );

  /* ================================================================== *
   * P2-9 — the token is HttpOnly and appears nowhere JS can reach
   * ================================================================== */
  runner.scenario(
    'p2/9-token-not-exposed-to-js',
    'the session cookie exists in the browser but is invisible to JS, and no body, storage or log carries the token',
    async (ctx) => {
      const documentId = 'demo-document';
      const page = await ctx.newAppPage({ documentId, as: DEMO_USERS.ada });
      await waitForEditorText(page, () => true);
      const origin = await page.evaluate(() => location.origin);

      // 1. The cookie really is in the browser's store (CDP sees HttpOnly cookies).
      const cookies = await page.getCookies({ urls: [origin] });
      const session = findSessionCookie(cookies);
      ctx.note(
        'browser cookie store',
        cookies.map((cookie) => ({
          name: cookie.name,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          path: cookie.path,
          secure: cookie.secure,
          valueLength: String(cookie.value ?? '').length,
        })),
      );
      assert(session !== null, `the browser must hold a ${SESSION_COOKIE_NAME} cookie`);
      assertEqual(session.httpOnly, true, 'the session cookie must be HttpOnly (§17.2)');
      assertEqual(session.path, '/', 'the session cookie must be Path=/');
      assertEqual(session.secure, false, 'a plain-HTTP dev origin must not set Secure');
      const token = session.value;

      // 2. Page script cannot see it — neither in `document.cookie` nor in web storage.
      const pageView = await page.evaluate(
        (name, secret) => {
          const storageDump = (storage) => {
            const entries = [];
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index) ?? '';
              entries.push({ key, value: storage.getItem(key) ?? '' });
            }
            return entries;
          };
          return {
            documentCookie: document.cookie,
            localStorage: storageDump(localStorage),
            sessionStorage: storageDump(sessionStorage),
            cookieVisible: document.cookie.includes(name),
            tokenVisibleInCookie: document.cookie.includes(secret),
            tokenVisibleInLocalStorage: JSON.stringify(storageDump(localStorage)).includes(secret),
            tokenVisibleInSessionStorage: JSON.stringify(storageDump(sessionStorage)).includes(secret),
            documentCookieLength: document.cookie.length,
          };
        },
        SESSION_COOKIE_NAME,
        token,
      );
      ctx.note('what page script can see', {
        cookieVisible: pageView.cookieVisible,
        tokenVisibleInCookie: pageView.tokenVisibleInCookie,
        documentCookieLength: pageView.documentCookieLength,
        localStorage: pageView.localStorage,
        sessionStorage: pageView.sessionStorage,
      });
      assertEqual(pageView.cookieVisible, false, 'document.cookie must not expose the session cookie');
      assertEqual(pageView.tokenVisibleInCookie, false, 'the token must not appear in document.cookie');
      assertEqual(pageView.tokenVisibleInLocalStorage, false, 'the token must not be in localStorage');
      assertEqual(pageView.tokenVisibleInSessionStorage, false, 'the token must not be in sessionStorage');

      // 3. `/api/session` as the page sees it.
      const sessionBody = await page.evaluate(async () => {
        const response = await fetch('/api/session', { credentials: 'include' });
        return { status: response.status, text: await response.text() };
      });
      ctx.note('browser GET /api/session', {
        status: sessionBody.status,
        keys: Object.keys(JSON.parse(sessionBody.text)),
      });
      assertEqual(sessionBody.status, 200, 'the page must have a live session');
      assert(
        !sessionBody.text.includes(token),
        'the /api/session body must not carry the token (§17.2)',
      );
      assertDeepEqual(
        Object.keys(JSON.parse(sessionBody.text)).sort(),
        ['displayName', 'expiresAt', 'userId'],
        '/api/session must answer identity only',
      );

      // 4. Bootstrap (the one call that mints a token) — body only, done last because a
      //    successful bootstrap rotates this page's session.
      const bootstrap = await page.evaluate(async () => {
        const response = await fetch('/api/session/bootstrap', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ demoUserId: 'demo-ada' }),
        });
        return {
          status: response.status,
          text: await response.text(),
          setCookie: response.headers.get('set-cookie'),
        };
      });
      const bootstrapBody = JSON.parse(bootstrap.text);
      ctx.note('browser POST /api/session/bootstrap', {
        status: bootstrap.status,
        keys: Object.keys(bootstrapBody),
        // A browser hides `Set-Cookie` from page script entirely (it is a forbidden response
        // header). That is one more reason the token cannot be read, and it is asserted here
        // rather than assumed, because the visibility is what the claim is about.
        setCookieVisibleToScript: bootstrap.setCookie !== null,
      });
      assertEqual(bootstrap.status, 200, 'the bootstrap must succeed');
      assertDeepEqual(
        Object.keys(bootstrapBody).sort(),
        ['displayName', 'expiresAt', 'userId'],
        'the bootstrap body must be identity only (§17.4)',
      );
      assert(
        !bootstrap.text.includes(token) && !/"(token|session|jwt|credential)"/i.test(bootstrap.text),
        'the bootstrap body must not carry the session token (§17.2/§17.4)',
      );
      assertEqual(
        bootstrap.setCookie,
        null,
        'page script must not be able to read the bootstrap Set-Cookie header',
      );

      // 5. The token never reached the server's log (a token in a log is a token leaked).
      const serverLog = ctx.stack.serverLog();
      ctx.note('server log carries the token', serverLog.includes(token));
      assertEqual(serverLog.includes(token), false, 'the session token must never be logged (§17.2)');

      // 6. After the rotation, page script still cannot read the (new) cookie.
      const afterRotation = await page.evaluate(
        (name) => ({ cookieVisible: document.cookie.includes(name), cookie: document.cookie }),
        SESSION_COOKIE_NAME,
      );
      const rotated = findSessionCookie(await page.getCookies({ urls: [origin] }));
      ctx.note('after the bootstrap rotation', {
        cookieVisibleToScript: afterRotation.cookieVisible,
        rotatedCookieHttpOnly: rotated?.httpOnly ?? null,
        rotatedValueLength: String(rotated?.value ?? '').length,
      });
      assertEqual(afterRotation.cookieVisible, false, 'the rotated cookie must stay invisible to JS');
      assert(rotated !== null && rotated.value !== token, 'the rotation must issue a new token');
      assertEqual(rotated.httpOnly, true, 'the rotated cookie must still be HttpOnly (§17.2)');
    },
  );

  /* ================================================================== *
   * Task 3 — what a process restart really does to a session
   * ================================================================== */
  runner.scenario(
    'p2/S-session-scope-after-restart',
    'records whether a page re-bootstraps after a hard restart (sessions are process-scoped), and that a renewed session restores writing',
    async (ctx) => {
      // A fresh store keeps this scenario independent of everything the suite wrote before it.
      const restarted = await ctx.stack.restartServerOnFreshDataPath('p2-session-scope');
      ctx.note('fresh data directory', restarted.dataPath);
      const documentId = `p2-session-scope-${marker('doc')}`;
      const before = marker('BEFORE-RESTART');
      const after = marker('AFTER-RENEWAL');

      const page = await ctx.newAppPage({ documentId, as: DEMO_USERS.ada });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      await typeInEditor(page, before);
      await waitForDurableText(ctx, documentId, (text) => text.includes(before), {
        label: 'the pre-restart write',
      });

      const origin = await page.evaluate(() => location.origin);
      const cookieBefore = findSessionCookie(await page.getCookies({ urls: [origin] }));
      assert(cookieBefore !== null, 'the page must hold a session cookie before the restart');
      const staleCookie = `${SESSION_COOKIE_NAME}=${cookieBefore.value}`;
      const liveBefore = await ctx.authz.json('/api/session', { cookie: staleCookie });
      assertEqual(liveBefore.status, 200, 'the token must be live before the restart');

      const pids = await ctx.stack.restartServer();
      ctx.note('hard restart', pids);
      assert(pids.after !== pids.before, 'this must be a real process restart');

      // (a) The contract: the old token is gone, on both transports.
      const liveAfter = await ctx.authz.json('/api/session', { cookie: staleCookie });
      const documentAfter = await ctx.authz.json(`/api/documents/${documentId}`, {
        cookie: staleCookie,
      });
      ctx.note('the pre-restart token after the restart', {
        session: liveAfter.status,
        document: documentAfter.status,
      });
      assertEqual(liveAfter.status, 401, 'a process restart must invalidate the session (§17.2)');
      assertEqual(documentAfter.status, 401, 'the document API must answer 401 for that token');
      const upgrade = await attemptUpgrade(ctx.stack.wsUrl, staleCookie);
      ctx.note('WS upgrade with the pre-restart token', upgrade.outcome);
      try {
        assertEqual(upgrade.outcome.kind, 'refused', 'the stale token must not open a socket');
        assertEqual(upgrade.outcome.status, 401, 'the refusal must be HTTP 401');
      } finally {
        upgrade.socket.terminate();
      }

      // (b) Observation (recorded, not asserted): does the page notice and re-bootstrap?
      const bootstrapBefore = (await qaSummary(page)).bootstrapCalls;
      const timeline = [];
      const observedUntil = Date.now() + 20_000;
      while (Date.now() < observedUntil) {
        timeline.push({
          t: 20_000 - (observedUntil - Date.now()),
          status: await readConnectionStatus(page),
        });
        await sleep(2_000);
      }
      const summaryDuring = await qaSummary(page);
      const statuses = [...new Set(timeline.map((entry) => entry.status))];
      ctx.note('page state with the stale session', {
        statusesObserved: statuses,
        connectedAtAnyPoint: statuses.includes('connected'),
        bootstrapCalls: summaryDuring.bootstrapCalls,
        bootstrapCallsBeforeRestart: bootstrapBefore,
        reBootstrapped: summaryDuring.bootstrapCalls > bootstrapBefore,
        closeCodes: (await pageCloseCodes(page)).map((entry) => entry.code),
        note:
          'observed, not asserted: the client has no 401-driven re-bootstrap, so it keeps retrying ' +
          'a dead token (A1 provider / A2 wiring). Reported as a Phase 2 limitation for A7.',
      });

      // (c) The server is healthy — a renewed session restores everything, which is what proves
      //     the limitation is the missing re-bootstrap and not a broken server.
      const renewed = await ctx.authz.renewBrowserSession(page, DEMO_USERS.ada);
      ctx.note('session renewed out-of-band', {
        userId: renewed.userId,
        tokenLength: renewed.tokenLength,
        note: 'the harness renews the cookie; the page itself never re-bootstraps',
      });
      const status = await waitForConnectionStatus(page, 'connected', { timeoutMs: 60_000 });
      ctx.note('page after the renewed session', { status });
      await typeInEditor(page, after);
      await waitForDurableText(ctx, documentId, (text) => text.includes(after), {
        timeoutMs: 30_000,
        label: 'the post-renewal write to be persisted',
      });
      const finalSummary = await qaSummary(page);
      ctx.note('page transport after the renewal', {
        bootstrapCalls: finalSummary.bootstrapCalls,
        liveDocumentSockets: finalSummary.liveDocumentSockets,
      });
    },
  );
}
