import { z } from 'zod';

/**
 * Document-scoped role. This is the RBAC vocabulary shared by:
 * - apps/server  -> request authorization
 * - apps/web     -> Permission UI (which buttons are enabled)
 *
 * Ordered from least to most privileged.
 */
export const DOCUMENT_ROLES = ['viewer', 'commenter', 'editor', 'owner'] as const;
export const documentRoleSchema = z.enum(DOCUMENT_ROLES);

export type DocumentRole = z.infer<typeof documentRoleSchema>;

/** Role ranking, used to answer "may this role do X?" from one place. */
const ROLE_RANK: Record<DocumentRole, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  owner: 3,
};

export function isDocumentRole(value: unknown): value is DocumentRole {
  return documentRoleSchema.safeParse(value).success;
}

export function roleRank(role: DocumentRole): number {
  return ROLE_RANK[role];
}

/** True when `role` is at least as privileged as `required`. */
export function hasAtLeastRole(role: DocumentRole, required: DocumentRole): boolean {
  return roleRank(role) >= roleRank(required);
}

/** Capability checks kept alongside the role vocabulary so both sides agree. */
export const documentCapabilities = {
  canRead: (role: DocumentRole) => hasAtLeastRole(role, 'viewer'),
  canComment: (role: DocumentRole) => hasAtLeastRole(role, 'commenter'),
  canEdit: (role: DocumentRole) => hasAtLeastRole(role, 'editor'),
  canManageMembers: (role: DocumentRole) => hasAtLeastRole(role, 'owner'),
} as const;

export type DocumentCapability = keyof typeof documentCapabilities;
