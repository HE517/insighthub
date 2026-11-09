/**
 * The member-management HTTP client (`docs/agent-governance/P0-2-MEMBERS.md`).
 *
 * ## The six frozen calls
 *
 * ```text
 * GET    /api/documents/:id/members            → { members, ownerId }
 * POST   /api/documents/:id/members            { email, role }        → member
 * PATCH  /api/documents/:id/members/:userId    { role }               → member
 * DELETE /api/documents/:id/members/:userId                           → (2xx)
 * POST   /api/documents/:id/owner              { userId }             → owner moved
 * POST   /api/documents/:id/leave                                     → 204
 * ```
 *
 * Every call takes an `AbortSignal` (`AGENTS.md` R9) and every failure is a typed
 * {@link MembersApiError}. The HTTP layer (`api.ts`) is the only place that touches `fetch`; this
 * module never parses a transport error itself, it maps the shared {@link ApiError} into the
 * vocabulary the dialog copy understands.
 *
 * ## What this module does not decide
 *
 * - **No permission decision.** Only an owner may call these endpoints; the UI hides the entry
 *   for everyone else, but the server is the authority (`docs/ARCHITECTURE.md` §8.2). A `403` is
 *   a normal answer here, not an assertion failure.
 * - **No optimistic member list.** Mutations resolve with the server's status and the dialog
 *   re-reads `GET /members` afterwards, so the list is always something the server actually said.
 *   The success bodies are deliberately not parsed: the frozen contract lets a mutation return
 *   "the updated member", and rendering that single row would be a second source of truth for a
 *   list that also has to reflect removals and owner transfers.
 * - **No error wording.** `membersCopy.ts` owns the Chinese copy; this module owns only the typed
 *   `status`/`code` pair it is built from.
 */
import { isDocumentRole, type DocumentRole } from '@insighthub/shared';

import { deleteJson, getJson, patchJson, postJson, type ApiError } from '../../api.js';

/**
 * The roles an owner may *assign*. `owner` is deliberately absent: ownership moves only through
 * `POST /owner`, never through an invite or a role edit (`P0-2-MEMBERS.md` §API).
 */
export const INVITE_ROLES = ['viewer', 'commenter', 'editor'] as const;

export type InviteRole = (typeof INVITE_ROLES)[number];

export function isInviteRole(value: unknown): value is InviteRole {
  return value === 'viewer' || value === 'commenter' || value === 'editor';
}

/** One row of `GET /members`. Never includes a token, a secret or a credential. */
export interface DocumentMember {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: DocumentRole;
}

/** The `GET /members` body: the members plus the id of the one owner. */
export interface DocumentMembers {
  readonly members: readonly DocumentMember[];
  readonly ownerId: string;
}

/** Why a members call produced no usable answer. */
export type MembersApiFailure = 'http' | 'network' | 'timeout' | 'aborted' | 'malformed';

/**
 * A failed members call.
 *
 * `status` and `code` are the server's real answer (`404` + `user_not_found`, `409` +
 * `last_owner`, …). They are carried unchanged so the copy layer maps the *response the server
 * actually sent*, never a guess derived from the operation the UI attempted.
 */
export class MembersApiError extends Error {
  readonly kind: MembersApiFailure;
  readonly status?: number;
  readonly code?: string;

  constructor(kind: MembersApiFailure, message: string, status?: number, code?: string) {
    super(message);
    this.name = 'MembersApiError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
  }
}

/** Options shared by every members request. The signal is required, not optional (R9). */
export interface MembersRequestOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

function documentPath(documentId: string, suffix: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}${suffix}`;
}

function abortError(operation: string): MembersApiError {
  return new MembersApiError('aborted', `${operation} was aborted before it started.`);
}

/**
 * Map the shared transport error onto the members vocabulary.
 *
 * `http` keeps the status and the frozen server code; the copy layer is what turns the pair into
 * Chinese, so no status is interpreted here.
 */
function apiError(error: ApiError): MembersApiError {
  switch (error.kind) {
    case 'aborted':
      return new MembersApiError('aborted', error.message);
    case 'timeout':
      return new MembersApiError('timeout', error.message);
    case 'network':
      return new MembersApiError('network', error.message);
    case 'http':
      return new MembersApiError('http', error.message, error.status, error.code);
  }
}

async function expectData(
  result: Promise<{ ok: true; data: unknown } | { ok: false; error: ApiError }>,
): Promise<unknown> {
  const response = await result;
  if (!response.ok) throw apiError(response.error);
  return response.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a `GET /members` body before it becomes UI state.
 *
 * Hand-written checks rather than a Zod schema: the web app has no `zod` dependency, and the
 * frozen body is four string fields per row plus `ownerId`. A malformed answer is `malformed`,
 * never an empty list — "the server said nobody is a member" and "the server's answer was
 * unreadable" are different states.
 */
export function parseDocumentMembers(value: unknown): DocumentMembers | null {
  if (!isRecord(value)) return null;
  const ownerId = value['ownerId'];
  const rawMembers = value['members'];
  if (typeof ownerId !== 'string' || ownerId === '') return null;
  if (!Array.isArray(rawMembers)) return null;

  const members: DocumentMember[] = [];
  for (const raw of rawMembers) {
    if (!isRecord(raw)) return null;
    const userId = raw['userId'];
    const email = raw['email'];
    const name = raw['name'];
    const role = raw['role'];
    if (typeof userId !== 'string' || userId === '') return null;
    if (typeof email !== 'string' || email === '') return null;
    // A display name may legitimately be empty (an account with no name); the email is then the
    // name the dialog falls back to, so only the type is enforced here.
    if (typeof name !== 'string') return null;
    if (!isDocumentRole(role)) return null;
    members.push({ userId, email, name, role });
  }

  return { members, ownerId };
}

/** Read the member list. Only the owner may; the server answers 403/404 for anyone else. */
export async function fetchMembers(
  documentId: string,
  options: MembersRequestOptions,
): Promise<DocumentMembers> {
  if (options.signal.aborted) throw abortError('GET /members');
  const data = await expectData(
    getJson<unknown>(documentPath(documentId, '/members'), {
      // Session-bearing read: the httpOnly cookie has to travel even if the API is proxied
      // (`docs/CONTRACTS.md` §17.2).
      credentials: 'include',
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
  const members = parseDocumentMembers(data);
  if (members === null) {
    throw new MembersApiError(
      'malformed',
      'GET /members answered 200 without a readable { members, ownerId } body.',
    );
  }
  return members;
}

/**
 * Invite an already-registered user by email, or update their role if they are already a member.
 *
 * The client cannot invite an owner and cannot invite itself by protocol: the server answers
 * `404 user_not_found` for an unknown email and `409 already_owner` for the owner's own email.
 */
export async function inviteMember(
  documentId: string,
  input: { readonly email: string; readonly role: InviteRole },
  options: MembersRequestOptions,
): Promise<void> {
  if (options.signal.aborted) throw abortError('POST /members');
  await expectData(
    postJson<unknown>(documentPath(documentId, '/members'), {
      body: { email: input.email, role: input.role },
      credentials: 'include',
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
}

/** Change an existing member's role. The owner's role is immutable (409 `owner_role_immutable`). */
export async function changeMemberRole(
  documentId: string,
  userId: string,
  role: InviteRole,
  options: MembersRequestOptions,
): Promise<void> {
  if (options.signal.aborted) throw abortError('PATCH /members/:userId');
  await expectData(
    patchJson<unknown>(documentPath(documentId, `/members/${encodeURIComponent(userId)}`), {
      body: { role },
      credentials: 'include',
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
}

/** Remove a member. The owner cannot be removed (409 `owner_requires_transfer`). */
export async function removeMember(
  documentId: string,
  userId: string,
  options: MembersRequestOptions,
): Promise<void> {
  if (options.signal.aborted) throw abortError('DELETE /members/:userId');
  await expectData(
    deleteJson<unknown>(documentPath(documentId, `/members/${encodeURIComponent(userId)}`), {
      credentials: 'include',
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
}

/**
 * Transfer ownership to another current member.
 *
 * The server performs the demotion/promotion in one transaction; this client only names the
 * target and then re-reads the list. No local "two owners" state exists at any point.
 */
export async function transferOwner(
  documentId: string,
  userId: string,
  options: MembersRequestOptions,
): Promise<void> {
  if (options.signal.aborted) throw abortError('POST /owner');
  await expectData(
    postJson<unknown>(documentPath(documentId, '/owner'), {
      body: { userId },
      credentials: 'include',
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
}

/**
 * Leave the document as its current user.
 *
 * No body and no user id: the server resolves "me" from the session. An owner is refused with
 * `409 last_owner` until ownership is transferred.
 */
export async function leaveDocument(
  documentId: string,
  options: MembersRequestOptions,
): Promise<void> {
  if (options.signal.aborted) throw abortError('POST /leave');
  await expectData(
    postJson<unknown>(documentPath(documentId, '/leave'), {
      credentials: 'include',
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
  );
}
