/**
 * The dialog's pure model: which controls need a second confirmation, what that confirmation says,
 * and the small row helpers the view would otherwise re-derive.
 *
 * Keeping this out of `ShareDialog.tsx` is what makes the confirmation behaviour testable in the
 * Node gate (this workspace has no DOM): the view is rendered as static markup, and the state
 * transitions are plain functions here. The component owns only state and the calls.
 *
 * ## Confirmation policy
 *
 * `remove`, `transfer` and `leave` are destructive or irreversible from the user's point of view,
 * so each one goes through `members-confirm` first. Inviting and changing a role are not confirmed:
 * both are reversible through the same list, and a confirmation on every edit would train the user
 * to click through it.
 *
 * The owner's row intentionally has no role select and no remove button: the frozen API refuses
 * both (`409 owner_role_immutable` / `409 owner_requires_transfer`), and offering a control whose
 * only possible answer is an error is worse than explaining how ownership actually moves. That is
 * why the transfer entry lives on the owner row and picks its target inside the confirmation.
 */
import type { DocumentMember } from './membersApi.js';

/** A pending destructive action awaiting its second click. */
export type Confirmation =
  | { readonly kind: 'remove'; readonly member: DocumentMember }
  | { readonly kind: 'transfer'; readonly targetId: string | null }
  | { readonly kind: 'leave' };

export type ConfirmationKind = Confirmation['kind'];

/** The words the confirmation step renders. */
export interface ConfirmationCopy {
  readonly title: string;
  readonly detail: string;
  readonly confirmLabel: string;
}

/**
 * Every destructive action requires its second step.
 *
 * The function exists instead of a constant so a future action cannot be added without answering
 * the question; the switch is exhaustive.
 */
export function requiresConfirmation(kind: ConfirmationKind): boolean {
  switch (kind) {
    case 'remove':
    case 'transfer':
    case 'leave':
      return true;
  }
}

/** The confirmation's copy, built from the member it would affect (never from a stale guess). */
export function confirmationCopy(confirmation: Confirmation): ConfirmationCopy {
  switch (confirmation.kind) {
    case 'remove':
      return {
        title: '移除成员？',
        detail: `确定要移除 ${displayNameOf(confirmation.member)}（${confirmation.member.email}）吗？对方将立即失去本文档的访问权限。`,
        confirmLabel: '确认移除',
      };
    case 'transfer':
      return {
        title: '转让所有者？',
        detail: '转让后你会降级为编辑者，并且此操作无法撤销。请选择新的所有者。',
        confirmLabel: '确认转让',
      };
    case 'leave':
      return {
        title: '离开文档？',
        detail:
          '离开后你将失去本文档的访问权限，直到再次被邀请。' +
          '所有者必须先转让所有权，否则服务器会拒绝离开。',
        confirmLabel: '确认离开',
      };
  }
}

/**
 * Whether the confirm button may be pressed.
 *
 * A transfer needs a target; the other two are always complete once the member is known. The
 * server still validates every one of these (the UI never substitutes for it), but a disabled
 * button is a clearer answer than a request that can only fail.
 */
export function canConfirm(confirmation: Confirmation): boolean {
  if (confirmation.kind === 'transfer') return confirmation.targetId !== null;
  return true;
}

/** The owner row: the single member whose role is `owner` (the contract guarantees exactly one). */
export function isOwnerRow(member: DocumentMember, ownerId: string): boolean {
  return member.role === 'owner' || member.userId === ownerId;
}

/** Members who can receive ownership: everyone except the current owner. */
export function transferCandidates(
  members: readonly DocumentMember[],
  ownerId: string,
): readonly DocumentMember[] {
  return members.filter((member) => !isOwnerRow(member, ownerId));
}

/** A row's human name; an account with no display name falls back to its email. */
export function displayNameOf(member: DocumentMember): string {
  const name = member.name.trim();
  return name === '' ? member.email : name;
}

/**
 * The invite button is disabled only for an empty address. Format is the server's call: the copy
 * for `400 invalid_request` explains a bad address, and a client-side pattern would reject
 * addresses the server accepts.
 */
export function canSubmitInvite(email: string): boolean {
  return email.trim() !== '';
}
