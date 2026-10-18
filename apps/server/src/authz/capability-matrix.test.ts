/**
 * **P2-4** (one decision, several layers), **P2-6** (management capability is owner-only) and
 * **P2-2** (a caller cannot declare who it is) — table driven.
 *
 * ## What "three-way agreement" means here, exactly
 *
 * For every `(role, capability)` pair the same question is asked three ways:
 *
 * | Layer | Question | Source |
 * | --- | --- | --- |
 * | shared judge | `documentCapabilities[capability](role)` | `packages/shared/src/permission.ts` |
 * | authz core | `authz.can(documentId, userId, capability)` | `apps/server/src/authz/authz.ts` |
 * | HTTP | `status === 200` on a real request | `apps/server/src/app.ts` |
 *
 * ## Why the HTTP column is a probe route
 *
 * Phase 2 has **no** production endpoint that requires more than `canRead`: a read needs
 * `canRead`, and §17.3 forbids inventing a membership endpoint just to make a `403` observable.
 * The refusal mapping is therefore exercised by mounting the **production**
 * `createDocumentAccessHandler` — the same factory `GET /api/documents/:id` uses — with the other
 * three capabilities. Nothing about the mapping is reimplemented for the test; only the mount
 * point differs, and the task report says so instead of presenting it as a product route.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import {
  DOCUMENT_ROLES,
  documentCapabilities,
  type DocumentCapability,
  type DocumentMeta,
  type DocumentRole,
} from '@insighthub/shared';

import { createDocumentAccessHandler } from '../app.js';
import {
  bootstrap,
  startHarness,
  type BootstrappedSession,
  type Harness,
} from './test-support.js';

const CAPABILITIES: readonly DocumentCapability[] = [
  'canRead',
  'canComment',
  'canEdit',
  'canManageMembers',
];

/** One live `(document, user)` pair per role, from the demo fixture. */
const CALLER_FOR_ROLE: Record<
  DocumentRole,
  { readonly documentId: string; readonly userId: string }
> = {
  viewer: { documentId: 'demo-document', userId: 'demo-linus' },
  commenter: { documentId: 'demo-team-notes', userId: 'demo-ada' },
  editor: { documentId: 'demo-document', userId: 'demo-grace' },
  owner: { documentId: 'demo-document', userId: 'demo-ada' },
};

/** A caller with no membership at all on the document it asks about. */
const NON_MEMBER = { documentId: 'demo-private-notes', userId: 'demo-grace' } as const;

let harness: Harness;
let probe: Server;
let probeUrl = '';
const sessions = new Map<string, BootstrappedSession>();

/** The session for a demo user, failing loudly rather than returning `undefined`. */
function sessionFor(userId: string): BootstrappedSession {
  const session = sessions.get(userId);
  assert.ok(session !== undefined, `no bootstrapped session for ${userId}`);
  return session;
}

before(async () => {
  harness = await startHarness();

  // The probe mounts the production handler once per capability. Every route is the same code as
  // `GET /api/documents/:id`, only parameterised by the capability the contract's 403 row talks
  // about ("the action needs more than canRead").
  const app = express();
  app.disable('x-powered-by');
  for (const capability of CAPABILITIES) {
    app.get(`/probe/${capability}/:id`, createDocumentAccessHandler(harness.authz, capability));
  }
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  probe = createServer(app);
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address() as AddressInfo;
  probeUrl = `http://127.0.0.1:${address.port}`;

  for (const userId of ['demo-ada', 'demo-grace', 'demo-linus']) {
    sessions.set(userId, await bootstrap(harness, userId));
  }
});

after(async () => {
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await harness.close();
});

/** Ask one capability through the production handler. */
async function probeStatus(
  capability: DocumentCapability,
  documentId: string,
  cookie: string | null,
  extraHeaders: Record<string, string> = {},
  query = '',
): Promise<number> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (cookie !== null) headers['cookie'] = cookie;
  const response = await fetch(`${probeUrl}/probe/${capability}/${documentId}${query}`, {
    headers,
  });
  // Drain the body so the connection is released and no handle is left open.
  await response.text();
  return response.status;
}

/** What §17.4 requires the HTTP layer to answer for one caller and one capability. */
function expectedStatus(role: DocumentRole | null, capability: DocumentCapability): number {
  if (role === null || !documentCapabilities.canRead(role)) {
    // The non-disclosure answer wins over "insufficient capability": a caller that cannot read is
    // not told that the reason is a missing permission.
    return 404;
  }
  return documentCapabilities[capability](role) ? 200 : 403;
}

describe('P2-4 — shared judge, authz core and HTTP agree for every role × capability', () => {
  it('produces the same answer in all three layers', async () => {
    const rows: Array<{
      role: DocumentRole;
      capability: DocumentCapability;
      shared: boolean;
      core: boolean;
      http: number;
    }> = [];

    for (const role of DOCUMENT_ROLES) {
      const caller = CALLER_FOR_ROLE[role];
      const session = sessionFor(caller.userId);
      // The pair really does carry this role — otherwise the whole table would be measuring the
      // wrong caller.
      assert.equal(harness.authz.roleFor(caller.documentId, caller.userId), role);

      for (const capability of CAPABILITIES) {
        rows.push({
          role,
          capability,
          shared: documentCapabilities[capability](role),
          core: harness.authz.can(caller.documentId, caller.userId, capability),
          http: await probeStatus(capability, caller.documentId, session.cookie),
        });
      }
    }

    // 4 roles × 4 capabilities, every combination present exactly once.
    assert.equal(rows.length, DOCUMENT_ROLES.length * CAPABILITIES.length);

    for (const row of rows) {
      const label = `${row.role} × ${row.capability}`;
      assert.equal(row.core, row.shared, `core vs shared: ${label}`);
      assert.equal(row.http === 200, row.shared, `http vs shared: ${label}`);
      // And the negative mapping, so a 200 is never produced for a denied capability and a denial
      // never falls into the non-disclosure 404 by accident.
      assert.equal(row.http, expectedStatus(row.role, row.capability), `http mapping: ${label}`);
    }
  });

  it('answers 404 (not 403) when there is no membership, for all four capabilities', async () => {
    const session = sessionFor(NON_MEMBER.userId);
    for (const capability of CAPABILITIES) {
      assert.equal(harness.authz.can(NON_MEMBER.documentId, NON_MEMBER.userId, capability), false);
      assert.equal(
        await probeStatus(capability, NON_MEMBER.documentId, session.cookie),
        404,
        `${capability} without a membership must be the opaque answer`,
      );
    }
  });

  it('answers 401 before any capability is considered', async () => {
    for (const capability of CAPABILITIES) {
      assert.equal(await probeStatus(capability, 'demo-document', null), 401, capability);
    }
  });

  it('returns the same DocumentMeta the production endpoint returns', async () => {
    // The probe and the product route must not diverge in the success body either.
    const session = sessionFor('demo-ada');
    const viaProbe = await fetch(`${probeUrl}/probe/canRead/demo-document`, {
      headers: { cookie: session.cookie },
    });
    const viaProduct = await harness.request('/api/documents/demo-document', {
      headers: { cookie: session.cookie },
    });
    assert.equal(viaProbe.status, 200);
    assert.equal(viaProduct.status, 200);
    assert.deepEqual(
      (await viaProbe.json()) as DocumentMeta,
      (await viaProduct.json()) as DocumentMeta,
    );
  });
});

describe('P2-6 — canManageMembers belongs to the owner alone', () => {
  it('grants management to the owner and refuses it to editor, commenter and viewer', async () => {
    const expected: Record<DocumentRole, number> = {
      owner: 200,
      editor: 403,
      commenter: 403,
      viewer: 403,
    };

    for (const role of DOCUMENT_ROLES) {
      const caller = CALLER_FOR_ROLE[role];
      const session = sessionFor(caller.userId);

      assert.equal(
        harness.authz.can(caller.documentId, caller.userId, 'canManageMembers'),
        role === 'owner',
        `${role} core answer`,
      );
      assert.equal(
        await probeStatus('canManageMembers', caller.documentId, session.cookie),
        expected[role],
        `${role} HTTP answer`,
      );
    }
  });

  it('does not let edit imply manage on the same document', async () => {
    // An editor is powerful on content and powerless on membership; this is the pair a single
    // "at least editor" check in a member endpoint would get wrong.
    const editor = CALLER_FOR_ROLE.editor;
    const session = sessionFor(editor.userId);
    assert.equal(harness.authz.can(editor.documentId, editor.userId, 'canEdit'), true);
    assert.equal(harness.authz.can(editor.documentId, editor.userId, 'canManageMembers'), false);
    assert.equal(await probeStatus('canEdit', editor.documentId, session.cookie), 200);
    assert.equal(await probeStatus('canManageMembers', editor.documentId, session.cookie), 403);
  });
});

describe('P2-2 — a caller cannot declare who it is, or how it intends to work', () => {
  it('ignores every identity-shaped input on the wire', async () => {
    const grace = sessionFor('demo-grace');

    // `demo-private-notes` is readable by `demo-ada` and by nobody else. If any vector below were
    // honoured, grace's answer would become 200 — so this single document tests all of them.
    const documentId = 'demo-private-notes';
    const baseline = await probeStatus('canRead', documentId, grace.cookie);
    assert.equal(baseline, 404, 'grace cannot read a document she is not a member of');

    const vectors: Array<{ label: string; headers: Record<string, string>; query: string }> = [
      { label: 'query userId', headers: {}, query: '?userId=demo-ada' },
      { label: 'query user', headers: {}, query: '?user=demo-ada' },
      { label: 'query mode', headers: {}, query: '?mode=readwrite' },
      { label: 'query userId + mode', headers: {}, query: '?userId=demo-ada&mode=readwrite' },
      { label: 'X-User-Id header', headers: { 'x-user-id': 'demo-ada' }, query: '' },
      {
        label: 'X-Insighthub-User header',
        headers: { 'x-insighthub-user': 'demo-ada' },
        query: '',
      },
      { label: 'Authorization header', headers: { authorization: 'Bearer demo-ada' }, query: '' },
    ];

    for (const vector of vectors) {
      const status = await probeStatus(
        'canRead',
        documentId,
        grace.cookie,
        vector.headers,
        vector.query,
      );
      assert.equal(status, baseline, `${vector.label} changed the answer`);
    }

    // A second cookie naming another user must not be mistaken for an identity either: the only
    // cookie this server reads is the opaque session one.
    const withExtraCookie = await probeStatus(
      'canRead',
      documentId,
      `${grace.cookie}; userId=demo-ada`,
    );
    assert.equal(withExtraCookie, baseline, 'a plain `userId` cookie is not an identity');

    // Positive control: with a session that really is ada's, the same document *is* readable, so
    // the 404 above proves the identity was honoured rather than every request being denied.
    assert.equal(await probeStatus('canRead', documentId, sessionFor('demo-ada').cookie), 200);
  });

  it('does not let a declared `mode` grant an edit capability', async () => {
    const viewer = sessionFor('demo-linus');

    // `join-room.mode` is the WebSocket field §17.5 keeps for compatibility and never believes.
    // The HTTP analogue: a client-declared intent is not an input, so a viewer asking for
    // `readwrite` still gets the refusal it would get anyway.
    assert.equal(await probeStatus('canEdit', 'demo-document', viewer.cookie), 403);
    assert.equal(
      await probeStatus('canEdit', 'demo-document', viewer.cookie, {}, '?mode=readwrite'),
      403,
      'a declared mode must never widen a capability',
    );
    // And the real editor needs no declaration at all.
    assert.equal(await probeStatus('canEdit', 'demo-document', sessionFor('demo-grace').cookie), 200);
  });

  it('answers from the session identity, not from the bootstrap claim', async () => {
    // A second bootstrap is a rotation for that client, never an upgrade of an existing session:
    // the viewer's cookie keeps the viewer's capabilities while ada's new session is ada's.
    const viewer = sessionFor('demo-linus');
    const ada = await bootstrap(harness, 'demo-ada');
    assert.equal(await probeStatus('canEdit', 'demo-document', viewer.cookie), 403);
    assert.equal(await probeStatus('canEdit', 'demo-document', ada.cookie), 200);
  });
});
