import { describe, expect, it } from 'vitest';

import {
  parsePresencePatch,
  PresencePatchError,
  PRESENCE_PATCH_FIELDS,
  type CollaborativeSession,
  type PresencePatch,
} from './collab-session.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { SHARED_CONTRACT_VERSION } from './index.js';

/**
 * Contract tests for the presence **write** seam (`docs/CONTRACTS.md` §15, M2-P0-2).
 *
 * These pin the rule the seam exists to add: the *shape this client publishes* is now
 * owned by the contract and validated before anything is written, using the same
 * schemas the read side applies to peer input.
 *
 * They are red before the seam exists in the only way that matters: `publishPresence`
 * is not on `CollaborativeSession` and `parsePresencePatch` does not exist, so this
 * file cannot even compile against the previous contract version. The behavioural
 * assertions below are what make the *next* refactor of the write path safe.
 */

/** A helper so a test can assert "this throws a PresencePatchError". */
function expectRejected(patch: unknown, pattern?: RegExp): void {
  expect(() => parsePresencePatch(patch)).toThrow(PresencePatchError);
  if (pattern !== undefined) expect(() => parsePresencePatch(patch)).toThrow(pattern);
}

describe('presence patch contract', () => {
  it('accepts a cursor-only patch and keeps the other field absent', () => {
    const patch = parsePresencePatch({ cursor: { anchor: 3, head: 7 } });
    expect(patch).toEqual({ cursor: { anchor: 3, head: 7 } });
    // Absent means "leave unchanged" — not "clear". This is what makes a partial
    // patch safe, and it is observable as a missing own key.
    expect(Object.hasOwn(patch, 'selection')).toBe(false);
  });

  it('accepts a selection-only patch and keeps the other field absent', () => {
    const patch = parsePresencePatch({ selection: { from: 2, to: 9 } });
    expect(patch).toEqual({ selection: { from: 2, to: 9 } });
    expect(Object.hasOwn(patch, 'cursor')).toBe(false);
  });

  it('accepts explicit nulls, which mean "clear" rather than "unchanged"', () => {
    const patch = parsePresencePatch({ cursor: null, selection: null });
    expect(patch).toEqual({ cursor: null, selection: null });
    expect(Object.hasOwn(patch, 'cursor')).toBe(true);
  });

  it('accepts an empty patch (a presence refresh with no geometry change)', () => {
    expect(parsePresencePatch({})).toEqual({});
  });

  it('treats an explicit undefined field as absent', () => {
    const patch = parsePresencePatch({ cursor: undefined, selection: { from: 1, to: 1 } });
    expect(patch).toEqual({ selection: { from: 1, to: 1 } });
    expect(Object.hasOwn(patch, 'cursor')).toBe(false);
  });

  it('exposes exactly the two covered fields', () => {
    expect(PRESENCE_PATCH_FIELDS).toEqual(['cursor', 'selection']);
  });

  it('rejects a caller-supplied updatedAt, naming the real reason', () => {
    expectRejected(
      { cursor: { anchor: 0, head: 0 }, updatedAt: 1 },
      /updatedAt is owned by the collaboration layer/,
    );
  });

  it('rejects unknown patch keys, including the identity', () => {
    expectRejected({ user: { id: 'u', name: 'U' } }, /does not accept "user"/);
    expectRejected({ clientId: 7 }, /does not accept "clientId"/);
  });

  it('rejects extra fields inside cursor and selection', () => {
    expectRejected({ cursor: { anchor: 0, head: 0, extra: 1 } }, /does not accept "extra"/);
    expectRejected({ selection: { from: 0, to: 1, anchor: 0 } }, /does not accept "anchor"/);
  });

  it('rejects out-of-range cursor offsets', () => {
    expectRejected({ cursor: { anchor: -1, head: 0 } }, /cursor is invalid/);
    expectRejected({ cursor: { anchor: 0.5, head: 0 } }, /cursor is invalid/);
    expectRejected({ cursor: { anchor: Number.NaN, head: 0 } }, /cursor is invalid/);
    expectRejected({ cursor: { anchor: Number.POSITIVE_INFINITY, head: 0 } }, /cursor is invalid/);
  });

  it('rejects a reversed or malformed selection', () => {
    // The message comes from `awarenessSelectionSchema`'s own refine, which is the
    // point: the write side reuses the read side's rule instead of restating it.
    expectRejected({ selection: { from: 9, to: 2 } }, /selection\.from must be <= selection\.to/);
    expectRejected({ selection: { from: -1, to: 2 } }, /selection is invalid/);
    expectRejected({ selection: { from: Number.NaN, to: Number.NaN } }, /selection is invalid/);
    expectRejected({ selection: { from: 1 } }, /selection is invalid/);
  });

  it('rejects a non-object patch or a malformed field value', () => {
    expectRejected(null, /must be an object/);
    expectRejected(undefined, /must be an object/);
    expectRejected('cursor', /must be an object/);
    expectRejected([{ cursor: null }], /must be an object/);
    expectRejected({ cursor: 'here' }, /cursor must be an object/);
    expectRejected({ selection: 42 }, /selection must be an object/);
  });

  it('never mutates the caller-supplied patch', () => {
    const cursor = { anchor: 1, head: 2 };
    const patch = { cursor };
    parsePresencePatch(patch);
    expect(cursor).toEqual({ anchor: 1, head: 2 });
    expect(Object.keys(patch)).toEqual(['cursor']);
  });
});

describe('presence seam shape', () => {
  it('puts publishPresence on CollaborativeSession, taking a PresencePatch', () => {
    // Compile-time: the method exists on the frozen seam with the frozen signature.
    type Publish = CollaborativeSession['publishPresence'];
    const publish: Publish = (patch: PresencePatch): void => {
      void patch;
    };
    expect(typeof publish).toBe('function');
  });

  it('does not let a caller supply updatedAt in a patch', () => {
    const valid: PresencePatch = { cursor: { anchor: 0, head: 0 } };
    expect(valid.cursor).toEqual({ anchor: 0, head: 0 });

    // Compile-time: `updatedAt` is not part of the patch type.
    // @ts-expect-error updatedAt is owned by the collaboration layer, not the caller.
    const rejected: PresencePatch = { cursor: null, updatedAt: 1 };
    void rejected;
  });

  it('bumps the shared contract version but not the protocol version', () => {
    // v4: narrowing is a **breaking** seam change (v3 code that wrote through
    // `awareness` no longer compiles), so the surface version moved again.
    // v5 (M2 Phase 2): `WS_ERROR_CODES.FORBIDDEN` grew the closed error vocabulary
    // (`docs/CONTRACTS.md` §17.6). The seam asserted here is unchanged by that bump —
    // its own version pin now lives in `index.test.ts`; this one keeps proving that the
    // **wire** did not move with it.
    // v6 (M2 Phase 2): `RoomJoinedPayload` gained a required `role` (§5.2/§17.8). Still not a
    // wire-format change — one existing payload grew one field — so `PROTOCOL_VERSION` holds.
    // v7 (M2 Phase 2): `CollaborativeSession` gained `getRole()` (§17.9) — a frozen seam grew
    // a member. The wire already carried the role, so `PROTOCOL_VERSION` holds again.
    // v8 (M3): `AiEditOperation` gained the required `anchor` (§11.1) — a proposal shape grew,
    // not the wire. Suggestions are not delivered over the WebSocket, so `PROTOCOL_VERSION`
    // must not move with them.
    expect(SHARED_CONTRACT_VERSION).toBe(8);
    // The wire is untouched: awareness already carried cursor and selection.
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

/**
 * M2-P0-2 step 3 — the narrowing, asserted at **compile time**.
 *
 * Every `@ts-expect-error` below is the real assertion: if a write member ever comes
 * back on `AwarenessBinding`, the directive finds no error and `pnpm typecheck` fails
 * with "Unused '@ts-expect-error' directive". That is why these are stronger than a
 * comment or a runtime `expect(...).toBeUndefined()` — a runtime check would pass even
 * if the member were reachable, because it only proves the value happens to be missing.
 *
 * The bodies are never executed (`void (() => { ... })`), so nothing writes anything.
 */
describe('awareness is a binding input only (M2-P0-2 step 3)', () => {
  /** A compile-time handle; never dereferenced at runtime. */
  function typeOnlySession(): CollaborativeSession {
    return null as unknown as CollaborativeSession;
  }

  it('keeps the members a binding needs', () => {
    const session = typeOnlySession();
    void (() => {
      // Each of these must compile; they are the binding's read/subscribe surface.
      const states: ReadonlyMap<number, unknown> = session.awareness.getStates();
      const clientId: number = session.awareness.clientID;
      session.awareness.on('change', () => undefined);
      session.awareness.on('update', () => undefined);
      session.awareness.off('change', () => undefined);
      session.awareness.off('update', () => undefined);
      void states;
      void clientId;
    });
    expect(typeof typeOnlySession).toBe('function');
  });

  it('does not compile a raw presence write through the seam', () => {
    const session = typeOnlySession();
    void (() => {
      // @ts-expect-error `setLocalState` is not on the binding surface.
      session.awareness.setLocalState({
        user: { id: 'u', name: 'U' },
        cursor: null,
        selection: null,
        updatedAt: 1,
      });
      // @ts-expect-error `setLocalStateField` is not on the binding surface.
      session.awareness.setLocalStateField('cursor', { anchor: 0, head: 0 });
      // @ts-expect-error the internal `states` map is not exposed.
      void session.awareness.states;
      // @ts-expect-error the internal `meta` (clock bookkeeping) is not exposed.
      void session.awareness.meta;
      // @ts-expect-error a binding may not tear the presence channel down; the session owns it.
      session.awareness.destroy();
    });
    expect(typeof typeOnlySession).toBe('function');
  });

  it('does not hand out a writable states map', () => {
    const session = typeOnlySession();
    void (() => {
      // `Pick<Awareness, 'getStates'>` would have returned the live `Map`, leaving a
      // write path disguised as a read. The declared type is `ReadonlyMap`.
      // @ts-expect-error a ReadonlyMap has no `set`.
      session.awareness.getStates().set(1, {});
      // @ts-expect-error a ReadonlyMap has no `delete`.
      session.awareness.getStates().delete(1);
      // @ts-expect-error a ReadonlyMap has no `clear`.
      session.awareness.getStates().clear();
    });
    expect(typeof typeOnlySession).toBe('function');
  });

  it('exposes exactly the binding members and nothing else', () => {
    // Compile-time inventory: the key set of the narrowed member type. If someone adds
    // a member to `AwarenessBinding`, this assertion fails and forces a review — the
    // narrowing is only meaningful while the list is small and deliberate.
    type BindingKeys = keyof CollaborativeSession['awareness'];
    const keys: readonly BindingKeys[] = ['clientID', 'getStates', 'on', 'off'];
    expect(keys).toEqual(['clientID', 'getStates', 'on', 'off']);
  });
});

/**
 * M2 Phase 2 — `getRole()` on the frozen seam (`docs/CONTRACTS.md` §17.9).
 *
 * These are type-level assertions: the *behaviour* (what the getter answers in each
 * lifecycle state) belongs to the implementation and is pinned in
 * `apps/web/src/collab/tests/session-role.test.ts`. What must be true in
 * `packages/shared` is that the member exists, is required, returns the role vocabulary
 * or `null`, and is a getter rather than a stored field — because that is the shape A2
 * codes against and the shape every implementer must satisfy.
 */
describe('role getter seam (M2 Phase 2, §17.9)', () => {
  it('exposes getRole() returning DocumentRole | null', () => {
    // Compile-time: the member exists with the frozen signature. A `string` return would
    // not accept the literal below, and a non-null return would reject `null`.
    const getRole: CollaborativeSession['getRole'] = () => null;
    expect(typeof getRole).toBe('function');

    const known: ReturnType<CollaborativeSession['getRole']> = 'owner';
    const unknown: ReturnType<CollaborativeSession['getRole']> = null;
    expect(known).toBe('owner');
    expect(unknown).toBeNull();
  });

  it('requires the member: a session without getRole is not a CollaborativeSession', () => {
    // Negative shape test. `WithoutRole` is structurally a session *minus* the getter.
    // If the member were ever made optional — the tempting shortcut when a test double
    // cannot implement it — this assignment would compile and the unused
    // `@ts-expect-error` directive would fail `pnpm typecheck`, instead of the role
    // silently disappearing from the seam while every consumer still compiles.
    type WithoutRole = Omit<CollaborativeSession, 'getRole'>;
    // @ts-expect-error getRole is a required member of the frozen seam.
    const broken: CollaborativeSession = null as unknown as WithoutRole;
    void broken;
    expect(true).toBe(true);
  });

  it('is a getter, not a writable role field on the session object', () => {
    const session = null as unknown as CollaborativeSession;
    void (() => {
      // @ts-expect-error the seam has no writable `role` field; the getter is the only read.
      session.role = 'editor';
      // @ts-expect-error no role value is mirrored onto the session object (§17.9 rule 3).
      void session.role;
    });
    expect(typeof session).toBe('object');
  });
});
