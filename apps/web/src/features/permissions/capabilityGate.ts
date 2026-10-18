/**
 * The **UI** view of a role's capabilities — and nothing more.
 *
 * ## What this is
 *
 * `documentCapabilities` (`packages/shared/src/permission.ts`) is the single rule table for "may
 * this role read / comment / edit / manage". This module composes those four answers into the flags
 * the UI needs, so the components never compare role names themselves:
 *
 * ```text
 * role ──documentCapabilities──▶ CapabilityGate ──▶ which controls to render
 * ```
 *
 * ## What this is NOT
 *
 * **Not a security boundary.** `docs/ARCHITECTURE.md` §8.2 and `docs/CONTRACTS.md` §17 make the
 * server the only authority; a browser can always lie about what it renders. This gate exists so a
 * viewer is not shown an editing affordance the server would reject anyway — and the server still
 * rejects it, because the WS/HTTP decision does not consult anything the client sent.
 *
 * ## The unknown-role rule
 *
 * `role === null` means "the server has not told us" (offline, or no session yet). In that state the
 * gate must **not** become a blocker: `AGENTS.md` R10 makes editing a first-class offline state, so
 * the editor stays usable and the server refuses unauthorized traffic when it returns. Management
 * is the exception — it is never shown optimistically, because there is no management UI in Phase 2
 * and offering one on a guess is how a "you may not do that" appears out of nowhere.
 */
import {
  documentCapabilities,
  type DocumentCapability,
  type DocumentRole,
} from '@insighthub/shared';

export interface CapabilityGate {
  /** The server-decided role, or `null` when unknown. Display only. */
  readonly role: DocumentRole | null;
  /** `true` when a role is known, i.e. when the answers below came from the server. */
  readonly known: boolean;
  /** The four frozen questions, answered through `documentCapabilities`. */
  readonly capabilities: Readonly<Record<DocumentCapability, boolean>>;
  /** `true` when a **known** role may not edit; `false` while the role is unknown. */
  readonly readOnly: boolean;
}

/**
 * Build the gate for one role.
 *
 * For a known role every flag is `documentCapabilities[...](role)` — no second table, no
 * `role === 'editor'` comparison. That is the whole point of the module: one rule source, so the
 * UI cannot drift from the server's answer when the ladder changes.
 */
export function capabilityGate(role: DocumentRole | null): CapabilityGate {
  if (role === null) {
    // Unknown: allow what editing needs, never advertise management. See the header.
    return {
      role: null,
      known: false,
      capabilities: {
        canRead: true,
        canComment: true,
        canEdit: true,
        canManageMembers: false,
      },
      readOnly: false,
    };
  }

  const capabilities: Record<DocumentCapability, boolean> = {
    canRead: documentCapabilities.canRead(role),
    canComment: documentCapabilities.canComment(role),
    canEdit: documentCapabilities.canEdit(role),
    canManageMembers: documentCapabilities.canManageMembers(role),
  };

  return {
    role,
    known: true,
    capabilities,
    readOnly: !capabilities.canEdit,
  };
}
