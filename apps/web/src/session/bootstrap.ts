/**
 * Client-side session bootstrap (M2 Phase 2).
 *
 * ## What this module does and does not do
 *
 * It asks the server for **who this client is** and keeps the answer. It does **not** mint an
 * identity, and it does **not** hold a token:
 *
 * ```text
 * POST /api/session/bootstrap { demoUserId }   ← the one place a client names an identity
 *   → 200 { userId, displayName, expiresAt }   ← identity only
 *   + Set-Cookie insighthub_session=…; HttpOnly  ← the token, which JS cannot read
 * ```
 *
 * The token never appears in a response body (`docs/CONTRACTS.md` §17.4) and is `HttpOnly`
 * (§17.2), so there is deliberately nothing here that could store it: no `localStorage`, no
 * `sessionStorage`, no module variable, no Redux slice. P2-9 is satisfied by the *absence* of a
 * place to put it.
 *
 * ## Why a failure is not an error
 *
 * `bootstrapSession` **never throws** and resolves `null` on any failure (refused, timeout,
 * offline, malformed body). The editor is usable from local state and must stay that way
 * (`AGENTS.md` R10, `docs/ARCHITECTURE.md` §2.1): with no server the app opens the document, and
 * the server refuses the unauthorized traffic when it comes back. That is the offline-first
 * contract, not an error path.
 */
import { postJson } from '../api.js';

/** What the server says about this session. Identity only — never a credential. */
export interface SessionIdentity {
  readonly userId: string;
  readonly displayName: string;
  /** ISO 8601. The server-side expiry; the client uses it for display only. */
  readonly expiresAt: string;
}

/**
 * The demo identity this client claims by default.
 *
 * A **claim**, not a credential (§17.0). The server owns the roster and answers `400` for any id
 * that is not in it, so this constant decides only *which* demo identity is claimed — never
 * whether the claim is valid, and never who the caller may be for authorization purposes.
 */
export const DEFAULT_DEMO_USER_ID = 'demo-ada';

export interface BootstrapOptions {
  /** Roster id to claim. Defaults to {@link DEFAULT_DEMO_USER_ID}. */
  readonly demoUserId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Claim a demo identity and let the server issue a session.
 *
 * Resolves the identity, or `null` when the server could not be asked. The session cookie is
 * stored by the **browser** (it is `HttpOnly`), which is why `credentials: 'include'` is
 * required here and only here.
 */
export async function bootstrapSession(
  options: BootstrapOptions = {},
): Promise<SessionIdentity | null> {
  const result = await postJson<unknown>('/api/session/bootstrap', {
    body: { demoUserId: options.demoUserId ?? DEFAULT_DEMO_USER_ID },
    credentials: 'include',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  if (!result.ok) return null;
  return parseSessionIdentity(result.data);
}

/**
 * Validate the bootstrap response before using it.
 *
 * The body is untrusted input like any other: it is about to become the display name other people
 * see next to a cursor (`apps/web/src/user.ts`), so a malformed field is rejected here rather than
 * published into awareness. Hand-written checks instead of a schema because `zod` is a shared/
 * server dependency and the web app does not (and must not, in this change) gain one.
 */
export function parseSessionIdentity(value: unknown): SessionIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const userId = record['userId'];
  const displayName = record['displayName'];
  const expiresAt = record['expiresAt'];
  if (typeof userId !== 'string' || userId.length === 0) return null;
  if (typeof displayName !== 'string' || displayName.length === 0) return null;
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) return null;
  // The awareness contract caps a name at 80 characters (`packages/shared/src/awareness-state.ts`);
  // truncating to that bound here keeps presence publishable instead of silently dropped.
  return { userId, displayName: displayName.slice(0, 80), expiresAt };
}
