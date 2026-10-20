import { afterEach, describe, expect, it } from 'vitest';

import {
  DOCUMENT_ROLES,
  type ConnectionStatus,
  type DocumentRole,
} from '@insighthub/shared';

import {
  parseRoomJoinedRole,
  type DocumentSession,
} from '../internal/document-session.js';
import {
  createTestContext,
  testSocketFactory,
  waitFor,
  type TestContext,
} from './support/scenarios.js';
import { ContractTestServer } from './support/test-server.js';

/**
 * M2 Phase 2 — `CollaborativeSession.getRole()`, exercised on the real session
 * (`docs/CONTRACTS.md` §17.9).
 *
 * The type-level shape is pinned in `packages/shared/src/collab-session.test.ts`. This
 * file pins what the getter **answers**:
 *
 * | Requirement (§17.9) | Test |
 * | --- | --- |
 * | role arrives from `room-joined` | every role in the vocabulary round-trips |
 * | invalid / absent role → `null`, never `editor`/`viewer` | the parse rule + two wire tests |
 * | `null` before the first successful join | fresh active session, network not started |
 * | `null` while offline / reconnecting | explicit disconnect, dropped socket |
 * | `null` after a denied join | `ROOM_NOT_FOUND` on `join-room` |
 * | `null` after `destroy()` | joined, then destroyed |
 * | "most recent successful join" wins | a reconnect with a different role |
 * | announced through the **existing** subscription | a role change with no status change |
 * | not persisted / not in awareness | awareness entry shape + a reload of the same document |
 *
 * ## Why a null role is the safe answer
 *
 * `null` means UNKNOWN. A guessed `editor` shows controls the server will reject; a guessed
 * `viewer` locks a user out of their own unsent text, which R10 forbids. The server
 * re-derives the real role at every enforcement point, so the client loses nothing by
 * admitting it does not know (§17.9 rule 5).
 */

let context: TestContext | undefined;
let server: ContractTestServer | undefined;

afterEach(async () => {
  await context?.cleanup();
  context = undefined;
  await server?.stop();
  server = undefined;
});

function ctx(): TestContext {
  context ??= createTestContext();
  return context;
}

/**
 * Start a contract server whose `room-joined` reports `role`.
 *
 * `role` is `unknown` because the double is deliberately able to violate the payload
 * contract: that is how "an unparseable value yields `null`" is tested against the real
 * wire path instead of only against the parser helper.
 */
async function startServer(documentId: string, role: unknown = 'owner'): Promise<ContractTestServer> {
  const room = new ContractTestServer(documentId);
  room.joinRole = role;
  await room.start();
  server = room;
  return room;
}

interface RoleSnapshot {
  readonly status: ConnectionStatus;
  readonly role: DocumentRole | null;
}

/** Record what `getRole()` answered at every existing-channel notification. */
function recordRole(session: DocumentSession): RoleSnapshot[] {
  const snapshots: RoleSnapshot[] = [];
  session.subscribe(() => {
    snapshots.push({ status: session.connectionStatus, role: session.getRole() });
  });
  return snapshots;
}

describe('session role getter (§17.9)', () => {
  it('is null before the first successful join, while the session is already active', async () => {
    const session = await ctx().create({ documentId: 'role-before-join' });

    // Local-first: the session is usable with the network never opened (§10.1).
    expect(session.state).toBe('active');
    expect(session.connectionStatus).toBe('idle');
    // No join has succeeded, so there is nothing to report — not even a default.
    expect(session.getRole()).toBeNull();

    await startServer('role-before-join', 'commenter');
    session.startNetwork(server!.url, testSocketFactory);

    await waitFor(() => session.getRole() === 'commenter', 'the role from room-joined');
    expect(session.connectionStatus).toBe('connected');
    session.destroy();
  });

  it('reports whichever DocumentRole room-joined carried', async () => {
    // Every role in the frozen vocabulary round-trips unchanged. A viewer and an owner must
    // not collapse into the same answer: that difference is the entire point of the seam.
    for (const role of DOCUMENT_ROLES) {
      const documentId = `role-roundtrip-${role}`;
      await startServer(documentId, role);
      const session = await ctx().create({ documentId });
      session.startNetwork(server!.url, testSocketFactory);

      await waitFor(() => session.getRole() === role, `the ${role} role to arrive`);

      session.destroy();
      await server?.stop();
      server = undefined;
    }
  });

  it('is null again after an explicit disconnect, and the change is announced', async () => {
    await startServer('role-offline', 'editor');
    const session = await ctx().create({ documentId: 'role-offline' });
    const snapshots = recordRole(session);

    session.startNetwork(server!.url, testSocketFactory);
    await waitFor(() => session.getRole() === 'editor', 'the joined role');

    session.disconnect();
    expect(session.connectionStatus).toBe('offline');
    // The room this role described is gone. Reporting it while offline would be a stale
    // answer; §17.9 rule 2 makes it unknown again.
    expect(session.getRole()).toBeNull();

    // Announced through the EXISTING channel: `subscribe()` saw the role arrive …
    expect(snapshots.some((snapshot) => snapshot.role === 'editor')).toBe(true);
    // … and saw it become unknown again, with the offline status, without a second API.
    expect(
      snapshots.some((snapshot) => snapshot.role === null && snapshot.status === 'offline'),
    ).toBe(true);
    session.destroy();
  });

  it('is null while reconnecting, and the new join wins over the old role', async () => {
    const room = await startServer('role-reconnect', 'commenter');
    const session = await ctx().create({ documentId: 'role-reconnect' });
    session.startNetwork(room.url, testSocketFactory);
    await waitFor(() => session.getRole() === 'commenter', 'first join');

    // The server reports a different role for the next successful join.
    room.joinRole = 'viewer';
    room.dropAllConnections();

    // Between the socket dying and the new `room-joined`, the answer is UNKNOWN. This is
    // the window a reconnect cannot skip: the role is re-derived per join, never assumed.
    await waitFor(() => session.getRole() === null, 'the role to become unknown on reconnect');
    await waitFor(() => session.getRole() === 'viewer', "the reconnected join's role");

    // "Most recent successful join", not "last role we ever saw".
    expect(session.getRole()).not.toBe('commenter');
    session.destroy();
  });

  it('is null after a denied join', async () => {
    const room = await startServer('role-denied');
    room.rejectJoinWith = 'ROOM_NOT_FOUND';
    const session = await ctx().create({ documentId: 'role-denied' });
    const snapshots = recordRole(session);
    session.startNetwork(room.url, testSocketFactory);

    await waitFor(
      () => session.connectionStatus === 'reconnecting',
      'the non-fatal join rejection to schedule a retry',
    );
    expect(session.getRole()).toBeNull();
    // A denied join never became a successful join, so no fabricated role is ever published.
    expect(snapshots.every((snapshot) => snapshot.role === null)).toBe(true);
    session.destroy();
  });

  it('is null after destroy()', async () => {
    await startServer('role-destroyed', 'owner');
    const session = await ctx().create({ documentId: 'role-destroyed' });
    session.startNetwork(server!.url, testSocketFactory);
    await waitFor(() => session.getRole() === 'owner', 'the joined role');

    session.destroy();
    expect(session.state).toBe('destroyed');
    // §17.9 rule 2: a destroyed session is not a window on any role.
    expect(session.getRole()).toBeNull();
  });

  it('keeps the role through a non-fatal server error (a denied write is not a leave)', async () => {
    const room = await startServer('role-forbidden', 'viewer');
    const session = await ctx().create({ documentId: 'role-forbidden' });
    session.startNetwork(room.url, testSocketFactory);
    await waitFor(() => session.getRole() === 'viewer', 'the joined role');

    // `FORBIDDEN` is non-fatal and says only "you may not perform this mutation": the
    // client is still in the room with the role it was admitted with (§17.5).
    room.failAllWith('FORBIDDEN', 'sync mutation denied');
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(session.connectionStatus).toBe('connected');
    expect(session.getRole()).toBe('viewer');
    session.destroy();
  });

  it('announces a role change through the existing subscribe(), with no status change', async () => {
    const room = await startServer('role-subscribe', 'editor');
    const session = await ctx().create({ documentId: 'role-subscribe' });
    session.startNetwork(room.url, testSocketFactory);
    await waitFor(() => session.getRole() === 'editor', 'first join');

    // Subscribe AFTER the join: anything recorded from here on is a *later* change.
    const snapshots = recordRole(session);

    // A second client joining makes the server re-broadcast `room-joined` to this one. The
    // connection status does not change, so the only possible trigger is the role update
    // itself — which is what makes this test evidence for §17.9 rule 4 rather than a
    // status-change notification in disguise.
    room.joinRole = 'owner';
    const second = await ctx().create({ documentId: 'role-subscribe' });
    second.startNetwork(room.url, testSocketFactory);

    await waitFor(() => session.getRole() === 'owner', 'the re-broadcast role');
    expect(session.connectionStatus).toBe('connected');
    expect(
      snapshots.some(
        (snapshot) => snapshot.status === 'connected' && snapshot.role === 'owner',
      ),
    ).toBe(true);

    // There is exactly one subscription channel: no role-specific callback was added.
    expect((session as unknown as Record<string, unknown>).onRoleChange).toBeUndefined();
    second.destroy();
    session.destroy();
  });
});

describe('role validation (§17.9 rule 1)', () => {
  it('accepts every DocumentRole and nothing else', () => {
    for (const role of DOCUMENT_ROLES) {
      expect(parseRoomJoinedRole(role)).toBe(role);
    }

    // An unparseable or absent value is UNKNOWN. None of these may become `editor` or
    // `viewer`: the fallback is what the contract explicitly bans.
    for (const value of [
      undefined,
      null,
      '',
      'admin',
      'Editor',
      'viewer ',
      0,
      42,
      Number.NaN,
      true,
      ['viewer'],
      { role: 'viewer' },
      () => 'owner',
    ]) {
      expect(parseRoomJoinedRole(value)).toBeNull();
    }
  });

  it('keeps the role unknown when room-joined carries a non-DocumentRole value', async () => {
    const room = await startServer('role-invalid-value', 'admin');
    const session = await ctx().create({ documentId: 'role-invalid-value' });
    session.startNetwork(room.url, testSocketFactory);

    // The shared parser rejects the whole payload, so the join is never accepted and the
    // session reports UNKNOWN rather than the bogus string.
    await waitFor(
      () => (session.networkStatistics?.invalidFrames ?? 0) > 0,
      'the invalid room-joined payload to be rejected',
    );
    expect(session.getRole()).toBeNull();
    expect(session.connectionStatus).not.toBe('connected');
    session.destroy();
  });

  it('keeps the role unknown when room-joined carries no role at all', async () => {
    const room = await startServer('role-absent');
    // An explicit `undefined` (not omitted) is what makes the payload non-conforming: the
    // server's `JSON.stringify` drops the key, so the client sees a `room-joined` with no
    // `role` member — the "missing, never defaulted" case of §17.9 rule 1.
    room.joinRole = undefined;
    const session = await ctx().create({ documentId: 'role-absent' });
    session.startNetwork(room.url, testSocketFactory);

    await waitFor(
      () => (session.networkStatistics?.invalidFrames ?? 0) > 0,
      'the payload without a role to be rejected',
    );
    // A missing role is not "most permissive" and not "least permissive"; it is unknown.
    expect(session.getRole()).toBeNull();
    session.destroy();
  });
});

describe('the role is a getter, not state (§17.9 rule 3)', () => {
  it('is not written into awareness', async () => {
    await startServer('role-not-in-awareness', 'viewer');
    const session = await ctx().create({ documentId: 'role-not-in-awareness' });
    session.startNetwork(server!.url, testSocketFactory);
    await waitFor(() => session.getRole() === 'viewer', 'the joined role');

    // The local presence entry is still exactly the awareness contract, with no role field.
    const local = session.getLocalAwarenessState();
    expect(local).not.toBeNull();
    expect(Object.keys(local!).sort()).toEqual(['cursor', 'selection', 'updatedAt', 'user']);
    expect(JSON.stringify(local)).not.toContain('viewer');

    // No peer entry carries it either — this client wrote no such frame.
    for (const state of session.awareness.getStates().values()) {
      if (typeof state !== 'object' || state === null) continue;
      expect(Object.hasOwn(state, 'role')).toBe(false);
    }
    session.destroy();
  });

  it('is not persisted: reloading the same document does not restore a role', async () => {
    const documentId = 'role-not-persisted';
    await startServer(documentId, 'viewer');
    const first = await ctx().create({ documentId });
    first.startNetwork(server!.url, testSocketFactory);
    await waitFor(() => first.getRole() === 'viewer', 'the joined role');
    first.transact((text) => text.insert(0, 'persisted body'));
    await waitFor(() => first.text.toString() === 'persisted body', 'the body');
    first.destroy();

    // Same document, same IndexedDB replica, no network yet: the body comes back from
    // persistence, the role does not — because the role was never written anywhere.
    const reloaded = await ctx().create({ documentId });
    await waitFor(() => reloaded.text.toString() === 'persisted body', 'the restored body');
    expect(reloaded.getRole()).toBeNull();
    reloaded.destroy();
  });
});
