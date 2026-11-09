/**
 * # P0-2 document member management (D-M1 = A email invitation, D-M2 = C transfer/leave)
 *
 * The frozen contract is `docs/agent-governance/P0-2-MEMBERS.md`; this file is its server-side
 * implementation. It composes three existing seams instead of adding a fourth rule table:
 *
 * ```text
 * actor identity (identity.ts) ─► AuthzService.authorizeDocument(…, 'canManageMembers')
 *                                       │ granted = Owner
 *                                       ▼
 *                              MembershipStore (one transaction per write)
 *                                       │
 *                                       ▼
 *                              MemberDirectory (email ⇄ userId, name/email for the list)
 * ```
 *
 * ## Why authorization is asked through `AuthzService`
 *
 * "Owner only" is not an `if (role === 'owner')` here. It is
 * `authorizeDocument(…, 'canManageMembers')`, the same decision core HTTP and the WebSocket use,
 * so `403` for a non-Owner member and `404` for a stranger come from the one rule table
 * (`packages/shared/src/permission.ts`) rather than from a second copy in a route handler.
 *
 * ## Why the store re-checks the actor
 *
 * The HTTP route authorizes before it parses the body (so a non-member always sees the same
 * `404` regardless of what it sent). Between that check and the write, a concurrent transfer or
 * removal can land. Every store write therefore re-reads `roleFor(documentId, actorUserId)` and
 * the owner count **inside** its `BEGIN IMMEDIATE` transaction; `MembershipWriteError` reports
 * the refusal against the state that actually committed.
 *
 * ## Why the directory is a separate object
 *
 * Two modes must resolve an address the same way:
 *
 * - **demo**: the fixed demo address book (`ada/grace/linus@insighthub.test`);
 * - **clerk**: the `app_user` table (`AppUserStore.findByEmail`, case-insensitive/trimmed).
 *
 * The member service only asks "who is this address" and "what do I show for this id"; it never
 * learns which mode is in use, and it never accepts a `userId` from an invite body.
 *
 * ## Real-time revocation is a callback, not an import
 *
 * The service must close a revoked user's live WebSocket **after** the row commits. It receives
 * {@link MemberServiceOptions.onMembershipChanged} instead of importing `rooms/**`, so the
 * authorization domain stays unaware of sockets and `index.ts` wires the registry in at the
 * composition root.
 */
import type { DocumentRole } from '@insighthub/shared';

import { findDemoIdentity, findDemoIdentityByEmail } from './demo-fixture.js';
import type { AuthzService } from './authz.js';
import type { AppUserStore } from './app-user.js';
import {
  MembershipWriteError,
  openMembershipStore,
  type AssignableMemberRole,
  type MembershipStore,
  isAssignableMemberRole,
} from './membership-store.js';

/** One member as the API returns it. `email` is `null` only for an unresolvable stale row. */
export interface MemberSummary {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string;
  readonly role: DocumentRole;
}

/** `GET …/members` body. Exactly one owner is guaranteed by the store's transaction. */
export interface MemberList {
  readonly members: readonly MemberSummary[];
  readonly ownerId: string;
}

/**
 * The frozen P0-2 error vocabulary.
 *
 * `user_not_found` is a *member* code, deliberately distinct from the HTTP non-disclosure
 * `not_found`: the latter answers "you cannot see this document", the former "the document is
 * yours but no registered user has that address". `member_not_found` is collapsed to the same
 * `404 not_found` used for an unknown target user (there is nothing to disclose about a row
 * that does not exist).
 */
export type MemberErrorCode =
  | 'unauthenticated'
  | 'not_found'
  | 'forbidden'
  | 'user_not_found'
  | 'already_owner'
  | 'owner_role_immutable'
  | 'owner_requires_transfer'
  | 'last_owner'
  | 'member_not_found'
  | 'invalid_role'
  | 'invalid_request'
  | 'internal_error';

/** One member operation's result. A refused operation never carries a partial value. */
export type MemberOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: MemberErrorCode };

/** The member-management surface the HTTP layer consumes. */
export interface MemberService {
  /** Owner-only member list; `ownerId` is the single owner row. */
  list(documentId: string, actorUserId: string): Promise<MemberOutcome<MemberList>>;
  /** Resolve an email, then invite (or re-role) that member. Never assigns `owner`. */
  invite(
    documentId: string,
    actorUserId: string,
    email: string,
    role: AssignableMemberRole,
  ): Promise<MemberOutcome<MemberSummary>>;
  /** Change a non-Owner member's role. */
  changeRole(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
    role: AssignableMemberRole,
  ): Promise<MemberOutcome<MemberSummary>>;
  /** Remove a non-Owner member and revoke their live access. */
  remove(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<MemberOutcome<void>>;
  /** Atomically promote one member and demote the current Owner. */
  transferOwner(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<MemberOutcome<{ readonly ownerId: string }>>;
  /** The caller leaves; an Owner must transfer first. */
  leave(documentId: string, actorUserId: string): Promise<MemberOutcome<void>>;
  close(): void;
}

export interface MemberServiceOptions {
  /** Directory holding `insighthub.db` (the same file the membership table lives in). */
  readonly dataPath: string;
  /** The decision core; `canManageMembers` is what makes a caller an Owner. */
  readonly authz: AuthzService;
  /**
   * The Clerk directory. Absent in demo mode; present in clerk mode (`app_user`).
   *
   * It is still consulted for `describe()` in demo mode when a caller supplies one, which is
   * harmless (the table is empty there) and keeps the wiring identical in both modes.
   */
  readonly appUsers?: AppUserStore | null;
  /**
   * Whether the fixed demo address book is part of the directory.
   *
   * `true` only when `AUTH_MODE=demo` (or the test harness's demo default). In clerk mode a
   * real registered address must be the only thing an invite can resolve, so the demo mailbox
   * is deliberately not addressable.
   */
  readonly demoEmails: boolean;
  /**
   * Called **after** a membership write commits, with the affected user ids, so live sockets
   * can be closed. Must not throw; a failure here cannot un-commit the row.
   */
  readonly onMembershipChanged?: (documentId: string, userIds: readonly string[]) => void;
}

/** One resolved directory entry. */
interface DirectoryUser {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string;
}

/**
 * The email/user-id directory used by the member service.
 *
 * Demo identities are always described (their ids are fixed and cannot collide with a UUID), so
 * a seeded demo membership still renders a name in clerk mode. **Finding by email** is gated by
 * {@link MemberServiceOptions.demoEmails}: only demo mode may address a demo mailbox.
 */
class MemberDirectory {
  readonly #appUsers: AppUserStore | null;
  readonly #demoEmails: boolean;

  constructor(appUsers: AppUserStore | null, demoEmails: boolean) {
    this.#appUsers = appUsers;
    this.#demoEmails = demoEmails;
  }

  async findByEmail(email: string): Promise<DirectoryUser | null> {
    if (this.#demoEmails) {
      const demo = findDemoIdentityByEmail(email);
      if (demo !== null) return { userId: demo.userId, email: demo.email, name: demo.displayName };
    }
    const store = this.#appUsers;
    if (store === null) return null;
    const row = await store.findByEmail(email);
    if (row === null || row.email === null) return null;
    return {
      userId: row.id,
      email: row.email,
      name: row.displayName ?? row.email,
    };
  }

  async describe(userId: string): Promise<DirectoryUser | null> {
    const demo = findDemoIdentity(userId);
    if (demo !== null) return { userId: demo.userId, email: demo.email, name: demo.displayName };
    const store = this.#appUsers;
    if (store === null) return null;
    const row = await store.findById(userId);
    if (row === null) return null;
    return {
      userId: row.id,
      email: row.email,
      name: row.displayName ?? row.email ?? row.id,
    };
  }
}

class Members implements MemberService {
  readonly #store: MembershipStore;
  readonly #authz: AuthzService;
  readonly #directory: MemberDirectory;
  readonly #onMembershipChanged: (documentId: string, userIds: readonly string[]) => void;

  constructor(
    store: MembershipStore,
    authz: AuthzService,
    directory: MemberDirectory,
    onMembershipChanged: (documentId: string, userIds: readonly string[]) => void,
  ) {
    this.#store = store;
    this.#authz = authz;
    this.#directory = directory;
    this.#onMembershipChanged = onMembershipChanged;
  }

  async list(documentId: string, actorUserId: string): Promise<MemberOutcome<MemberList>> {
    const access = await this.#requireOwner(documentId, actorUserId);
    if (!access.ok) return access;

    const rows = this.#store.rowsForDocument(documentId);
    const members: MemberSummary[] = [];
    for (const row of rows) {
      const described = await this.#directory.describe(row.userId);
      members.push({
        userId: row.userId,
        email: described?.email ?? null,
        name: described?.name ?? row.userId,
        role: row.role,
      });
    }

    const ownerId = rows.find((row) => row.role === 'owner')?.userId;
    // The caller is the Owner, so the store's `assertSingleOwner` invariant guarantees this.
    // Reaching here without one means the table was written outside this class; answering 500
    // is the honest reading of a document whose permission state cannot be described.
    if (ownerId === undefined) {
      throw new Error(`document ${documentId} has no owner membership`);
    }
    return { ok: true, value: { members, ownerId } };
  }

  async invite(
    documentId: string,
    actorUserId: string,
    email: string,
    role: AssignableMemberRole,
  ): Promise<MemberOutcome<MemberSummary>> {
    const access = await this.#requireOwner(documentId, actorUserId);
    if (!access.ok) return access;
    if (!isAssignableMemberRole(role)) return { ok: false, code: 'invalid_role' };

    const target = await this.#directory.findByEmail(email);
    if (target === null) {
      // One answer for "no such user" and "not invitable" (P0-2): the endpoint must not become a
      // registered-email oracle.
      return { ok: false, code: 'user_not_found' };
    }
    if (target.userId === actorUserId) {
      // The actor is the Owner; inviting themselves is the only way an invite could name the
      // owner, and ownership only moves through `transferOwner`.
      return { ok: false, code: 'already_owner' };
    }

    // A no-op invite (same role) must not disconnect the member's live socket.
    const previousRole = this.#store.roleFor(documentId, target.userId);
    try {
      const row = this.#store.invite(documentId, actorUserId, target.userId, role);
      if (previousRole !== row.role) this.#notify(documentId, [target.userId]);
      return {
        ok: true,
        value: { userId: row.userId, email: target.email, name: target.name, role: row.role },
      };
    } catch (error) {
      return this.#refuse(error);
    }
  }

  async changeRole(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
    role: AssignableMemberRole,
  ): Promise<MemberOutcome<MemberSummary>> {
    const access = await this.#requireOwner(documentId, actorUserId);
    if (!access.ok) return access;
    if (!isAssignableMemberRole(role)) return { ok: false, code: 'invalid_role' };

    // Captured before the write: only an actual effective change should close a socket.
    const previousRole = this.#store.roleFor(documentId, targetUserId);
    try {
      const row = this.#store.changeRole(documentId, actorUserId, targetUserId, role);
      if (previousRole !== row.role) this.#notify(documentId, [targetUserId]);
      const described = await this.#directory.describe(row.userId);
      return {
        ok: true,
        value: {
          userId: row.userId,
          email: described?.email ?? null,
          name: described?.name ?? row.userId,
          role: row.role,
        },
      };
    } catch (error) {
      return this.#refuse(error);
    }
  }

  async remove(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<MemberOutcome<void>> {
    const access = await this.#requireOwner(documentId, actorUserId);
    if (!access.ok) return access;
    try {
      this.#store.remove(documentId, actorUserId, targetUserId);
    } catch (error) {
      return this.#refuse(error);
    }
    // After commit: the next HTTP request already sees no membership; the live socket must not
    // keep writing between now and its next frame.
    this.#notify(documentId, [targetUserId]);
    return { ok: true, value: undefined };
  }

  async transferOwner(
    documentId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<MemberOutcome<{ readonly ownerId: string }>> {
    const access = await this.#requireOwner(documentId, actorUserId);
    if (!access.ok) return access;
    try {
      const row = this.#store.transferOwner(documentId, actorUserId, targetUserId);
      // Both sides changed capability: the old Owner is now an editor and the target is now the
      // Owner. Their clients learned the old role at `room-joined`, so both rejoin.
      this.#notify(documentId, [actorUserId, targetUserId]);
      return { ok: true, value: { ownerId: row.userId } };
    } catch (error) {
      return this.#refuse(error);
    }
  }

  async leave(documentId: string, actorUserId: string): Promise<MemberOutcome<void>> {
    // Any member may leave, so this asks `canRead` rather than the Owner-only capability. A
    // stranger still gets the same non-disclosure `404`.
    const access = await this.#authorize(documentId, actorUserId, 'canRead');
    if (!access.ok) return access;
    try {
      this.#store.leave(documentId, actorUserId);
    } catch (error) {
      return this.#refuse(error);
    }
    // The caller's own socket loses the room immediately.
    this.#notify(documentId, [actorUserId]);
    return { ok: true, value: undefined };
  }

  close(): void {
    this.#store.close();
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  async #requireOwner(documentId: string, actorUserId: string): Promise<MemberOutcome<null>> {
    return await this.#authorize(documentId, actorUserId, 'canManageMembers');
  }

  async #authorize(
    documentId: string,
    actorUserId: string,
    capability: 'canManageMembers' | 'canRead',
  ): Promise<MemberOutcome<null>> {
    const decision = await this.#authz.authorizeDocument(documentId, actorUserId, capability);
    switch (decision.kind) {
      case 'granted':
        return { ok: true, value: null };
      case 'unauthenticated':
        return { ok: false, code: 'unauthenticated' };
      case 'not_found':
        return { ok: false, code: 'not_found' };
      case 'forbidden':
        return { ok: false, code: 'forbidden' };
      default: {
        const never: never = decision;
        throw new Error(`unhandled document access decision: ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * Translate a store refusal into the member vocabulary; rethrow anything else.
   *
   * A raw SQLite failure (a trigger, disk error, locked database) is **not** a domain refusal:
   * it must reach the HTTP error handler as `500 internal_error`, and — because the store's
   * transaction rolled back — with no partial membership change.
   */
  #refuse(error: unknown): MemberOutcome<never> {
    if (!(error instanceof MembershipWriteError)) throw error;
    switch (error.code) {
      case 'not_found':
        return { ok: false, code: 'not_found' };
      case 'forbidden':
        return { ok: false, code: 'forbidden' };
      case 'member_not_found':
        // A row that is not there is indistinguishable from a user who is not there.
        return { ok: false, code: 'not_found' };
      case 'already_owner':
        return { ok: false, code: 'already_owner' };
      case 'owner_role_immutable':
        return { ok: false, code: 'owner_role_immutable' };
      case 'owner_requires_transfer':
        return { ok: false, code: 'owner_requires_transfer' };
      case 'last_owner':
        return { ok: false, code: 'last_owner' };
      case 'invalid_role':
        return { ok: false, code: 'invalid_role' };
      case 'invariant_violation':
        // Never a 409: the request was not refused by a rule, the table is in a state the
        // contract says cannot happen. 500 is the honest answer and invites an operator.
        return { ok: false, code: 'internal_error' };
      default: {
        const never: never = error.code;
        throw new Error(`unhandled membership write refusal: ${JSON.stringify(never)}`);
      }
    }
  }

  #notify(documentId: string, userIds: readonly string[]): void {
    if (userIds.length === 0) return;
    try {
      this.#onMembershipChanged(documentId, userIds);
    } catch {
      // The row is committed; a socket-cleanup fault must not turn a successful write into a
      // 500. The per-frame authorization gate still refuses the old capability, so the worst
      // case is a stale connection until it closes on its own.
    }
  }
}

/**
 * Open the member service and its own membership read/write connection.
 *
 * A second connection (rather than reaching into `AuthzService`'s) is deliberate: the decision
 * core's handle is opened for synchronous checks, and keeping the write path explicit means the
 * member service cannot accidentally widen the decision core's interface. SQLite's WAL mode
 * supports it, and both use the same busy timeout.
 */
export async function createMemberService(
  options: MemberServiceOptions,
): Promise<MemberService> {
  const store = await openMembershipStore(options.dataPath);
  const directory = new MemberDirectory(options.appUsers ?? null, options.demoEmails);
  return new Members(
    store,
    options.authz,
    directory,
    options.onMembershipChanged ?? (() => undefined),
  );
}
