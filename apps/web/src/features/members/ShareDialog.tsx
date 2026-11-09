/**
 * The document's **共享** dialog: member list, invite, role changes, ownership transfer and leave
 * (`docs/agent-governance/P0-2-MEMBERS.md` §UI).
 *
 * ## Who can see it
 *
 * The entry is rendered by `DocumentHeader` only when
 * `capabilityGate(session.getRole()).capabilities.canManageMembers` is true, i.e. only for the
 * owner. This component is also guarded at its mount site in `DocumentWorkspace`, so a stale flag
 * cannot leave it on screen after a demotion. That is an affordance decision, not security: the
 * server refuses every member-management call from a non-owner with `403 forbidden` / `404
 * not_found` (non-disclosure), and the dialog renders that real answer instead of pretending.
 *
 * ## Data flow (one authority)
 *
 * ```text
 * GET /members ──▶ this component's `state` (metadata only) ──▶ rows
 * every mutation ──▶ server ──▶ re-read GET /members ──▶ rows
 * ```
 *
 * The member list is server data, never optimistic. A role change, invite, removal or transfer is
 * shown only after the server accepted it and the follow-up read returned the new list. A `409`
 * additionally forces that re-read: the conflict means this client's copy was stale.
 *
 * No document text, no `Y.Text` and no collaboration session ever enters this component
 * (`AGENTS.md` R11). It touches only membership metadata, and it never renders a token.
 *
 * ## Lifecycle and cancellation (R9)
 *
 * Mount starts the first read. Closing, a document switch (the workspace remounts) and Escape all
 * abort both the in-flight read and the in-flight mutation; a late answer checks
 * `signal.aborted` **and** an `alive` ref, so it cannot write into a component that is gone or
 * overwrite a newer list. Mutations are serialised by `opAbortRef` ("one thing at a time"), and
 * every control is disabled while a request is pending.
 *
 * ## Confirmation
 *
 * `remove`, `transfer` and `leave` go through the `members-confirm` step (`membersDialog.ts` owns
 * the policy and the copy). For a transfer the confirmation also picks the target, which is why
 * the owner row has one "转让 Owner" entry: clicking it opens the picker, choosing a member and
 * confirming are the second step, and the `POST /owner` call happens only after both.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DocumentRole } from '@insighthub/shared';

import {
  isInviteRole,
  type DocumentMember,
  type InviteRole,
  changeMemberRole,
  fetchMembers,
  inviteMember,
  leaveDocument,
  removeMember,
  transferOwner,
} from './membersApi.js';
import {
  INVITE_ROLE_OPTIONS,
  describeMembersFailure,
  memberRoleLabel,
  type MembersFailureCopy,
} from './membersCopy.js';
import {
  canConfirm,
  canSubmitInvite,
  confirmationCopy,
  displayNameOf,
  isOwnerRow,
  transferCandidates,
  type Confirmation,
} from './membersDialog.js';

/** The dialog's three load states. `ready` is the only one that renders rows. */
export type MembersLoadState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly members: readonly DocumentMember[];
      readonly ownerId: string;
    }
  | { readonly kind: 'error'; readonly failure: MembersFailureCopy };

export interface ShareDialogProps {
  /** The document whose membership is being managed. Encoded into every request path. */
  readonly documentId: string;
  /**
   * The session's user id, used only for the "（你）" marker. It is never sent by this component:
   * `POST /leave` resolves "me" from the session server-side.
   */
  readonly currentUserId: string;
  /** Close the dialog. The workspace unmounts it, which aborts any in-flight request. */
  readonly onClose: () => void;
}

export function ShareDialog({ documentId, currentUserId, onClose }: ShareDialogProps) {
  const [state, setState] = useState<MembersLoadState>({ kind: 'loading' });
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InviteRole>('viewer');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<MembersFailureCopy | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  /** `false` from unmount on; late promises never write state. */
  const aliveRef = useRef(true);
  const loadAbortRef = useRef<AbortController | null>(null);
  const opAbortRef = useRef<AbortController | null>(null);
  /** The latest `onClose`, so the Escape handler never closes over a stale prop. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const closeDialog = useCallback((): void => {
    onCloseRef.current();
  }, []);

  /**
   * Read the list. `silent` keeps the current rows on screen while re-reading, which is what a
   * post-mutation refresh wants; a non-silent read is the initial load and may show the loading
   * state. A silent failure keeps the last known list (the operation's own error explains why).
   */
  const load = useCallback(
    (options: { readonly silent?: boolean } = {}): void => {
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      if (options.silent !== true) setState({ kind: 'loading' });

      void fetchMembers(documentId, { signal: controller.signal }).then(
        (data) => {
          if (!aliveRef.current || controller.signal.aborted) return;
          loadAbortRef.current = null;
          setState({ kind: 'ready', members: data.members, ownerId: data.ownerId });
        },
        (error: unknown) => {
          if (!aliveRef.current || controller.signal.aborted) return;
          loadAbortRef.current = null;
          if (options.silent === true) return;
          const copy = describeMembersFailure(error);
          if (copy === null) return;
          setState({ kind: 'error', failure: copy });
        },
      );
    },
    [documentId],
  );

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => {
      aliveRef.current = false;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      opAbortRef.current?.abort();
      opAbortRef.current = null;
    };
  }, [load]);

  // Focus the dialog when it opens; the workspace returns focus to the "共享" button on close.
  useEffect(() => {
    document.querySelector<HTMLElement>('[data-testid="members-panel"]')?.focus();
  }, []);

  // Escape cancels the confirmation first (the safer of the two), then closes the dialog.
  const confirmationRef = useRef(confirmation);
  confirmationRef.current = confirmation;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (confirmationRef.current !== null) {
        setConfirmation(null);
        return;
      }
      closeDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeDialog]);

  /**
   * Run one mutation: disable the controls, clear the previous error, and map a real failure.
   *
   * Returns `true` only when the call succeeded. An `aborted` failure (dialog closed / document
   * switched) resolves `false` and is deliberately not shown. The second mutation is refused while
   * one is in flight — `opAbortRef` is the guard that survives a double click in the same tick.
   */
  const execute = useCallback(
    async (operation: (signal: AbortSignal) => Promise<void>): Promise<boolean> => {
      if (opAbortRef.current !== null) return false;
      const controller = new AbortController();
      opAbortRef.current = controller;
      setPending(true);
      setFailure(null);
      try {
        await operation(controller.signal);
        return true;
      } catch (error) {
        if (!aliveRef.current) return false;
        const copy = describeMembersFailure(error);
        if (copy === null) return false;
        setFailure(copy);
        // A 409 means this client's membership snapshot may be stale: re-read it (task rule).
        if (copy.refresh) load({ silent: true });
        return false;
      } finally {
        if (opAbortRef.current === controller) opAbortRef.current = null;
        if (aliveRef.current) setPending(false);
      }
    },
    [load],
  );

  const submitInvite = useCallback((): void => {
    if (pending || !canSubmitInvite(inviteEmail)) return;
    const email = inviteEmail.trim();
    const role = inviteRole;
    void (async () => {
      const ok = await execute((signal) => inviteMember(documentId, { email, role }, { signal }));
      if (!ok || !aliveRef.current) return;
      setInviteEmail('');
      load({ silent: true });
    })();
  }, [documentId, execute, inviteEmail, inviteRole, load, pending]);

  const changeRole = useCallback(
    (member: DocumentMember, role: DocumentRole): void => {
      if (pending || role === member.role || !isInviteRole(role)) return;
      void (async () => {
        const ok = await execute((signal) =>
          changeMemberRole(documentId, member.userId, role, { signal }),
        );
        if (ok && aliveRef.current) load({ silent: true });
      })();
    },
    [documentId, execute, load, pending],
  );

  const requestRemove = useCallback(
    (member: DocumentMember): void => {
      if (pending) return;
      setFailure(null);
      setConfirmation({ kind: 'remove', member });
    },
    [pending],
  );

  const requestTransfer = useCallback((): void => {
    if (pending) return;
    setFailure(null);
    setConfirmation({ kind: 'transfer', targetId: null });
  }, [pending]);

  const requestLeave = useCallback((): void => {
    if (pending) return;
    setFailure(null);
    setConfirmation({ kind: 'leave' });
  }, [pending]);

  const setTransferTarget = useCallback((userId: string): void => {
    setConfirmation((current) =>
      current !== null && current.kind === 'transfer'
        ? { ...current, targetId: userId === '' ? null : userId }
        : current,
    );
  }, []);

  const cancelConfirm = useCallback((): void => {
    if (pending) return;
    setConfirmation(null);
  }, [pending]);

  const confirm = useCallback((): void => {
    if (confirmation === null || pending || !canConfirm(confirmation)) return;
    const action = confirmation;
    void (async () => {
      if (action.kind === 'remove') {
        const ok = await execute((signal) =>
          removeMember(documentId, action.member.userId, { signal }),
        );
        if (!ok || !aliveRef.current) return;
        setConfirmation(null);
        load({ silent: true });
        return;
      }

      if (action.kind === 'transfer') {
        const targetId = action.targetId;
        if (targetId === null) return;
        const ok = await execute((signal) => transferOwner(documentId, targetId, { signal }));
        if (!ok || !aliveRef.current) return;
        setConfirmation(null);
        // The caller is no longer the owner, so this Owner-only surface is over. Closing is the
        // visible confirmation; the server closes the collaboration socket with 1008.
        closeDialog();
        return;
      }

      const ok = await execute((signal) => leaveDocument(documentId, { signal }));
      if (!ok || !aliveRef.current) return;
      setConfirmation(null);
      closeDialog();
    })();
  }, [closeDialog, confirmation, documentId, execute, load, pending]);

  return (
    <ShareDialogView
      documentId={documentId}
      currentUserId={currentUserId}
      state={state}
      inviteEmail={inviteEmail}
      inviteRole={inviteRole}
      pending={pending}
      failure={failure}
      confirmation={confirmation}
      onInviteEmailChange={setInviteEmail}
      onInviteRoleChange={setInviteRole}
      onInvite={submitInvite}
      onChangeRole={changeRole}
      onRequestRemove={requestRemove}
      onRequestTransfer={requestTransfer}
      onRequestLeave={requestLeave}
      onConfirm={confirm}
      onCancelConfirm={cancelConfirm}
      onTransferTargetChange={setTransferTarget}
      onRefresh={() => load()}
      onClose={closeDialog}
    />
  );
}

export interface ShareDialogViewProps {
  readonly documentId: string;
  readonly currentUserId: string;
  readonly state: MembersLoadState;
  readonly inviteEmail: string;
  readonly inviteRole: InviteRole;
  /** `true` while a mutation is in flight; every mutating control is disabled. */
  readonly pending: boolean;
  /** The last mutation failure, or `null`. Rendered as `members-error`. */
  readonly failure: MembersFailureCopy | null;
  /** The pending destructive action, or `null`. Rendered as `members-confirm`. */
  readonly confirmation: Confirmation | null;
  readonly onInviteEmailChange: (email: string) => void;
  readonly onInviteRoleChange: (role: InviteRole) => void;
  readonly onInvite: () => void;
  readonly onChangeRole: (member: DocumentMember, role: DocumentRole) => void;
  readonly onRequestRemove: (member: DocumentMember) => void;
  readonly onRequestTransfer: () => void;
  readonly onRequestLeave: () => void;
  readonly onConfirm: () => void;
  readonly onCancelConfirm: () => void;
  readonly onTransferTargetChange: (userId: string) => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}

/**
 * The pure view, exported for the Node markup test (`renderToStaticMarkup`).
 *
 * Contract surface: `members-panel`, `members-loading`, `members-load-error`, `members-list`,
 * `members-row` (`data-user-id`, `data-role`, `data-owner`), `members-name`, `members-email`,
 * `members-role`, `members-role-select`, `members-remove`, `members-transfer`, `members-leave`,
 * `members-invite-email`, `members-invite-role`, `members-invite-submit`, `members-error`,
 * `members-confirm` (`data-confirm-action`), `members-confirm-submit`, `members-confirm-cancel`,
 * `members-transfer-target`, `members-refresh`, `members-close`.
 */
export function ShareDialogView({
  documentId,
  currentUserId,
  state,
  inviteEmail,
  inviteRole,
  pending,
  failure,
  confirmation,
  onInviteEmailChange,
  onInviteRoleChange,
  onInvite,
  onChangeRole,
  onRequestRemove,
  onRequestTransfer,
  onRequestLeave,
  onConfirm,
  onCancelConfirm,
  onTransferTargetChange,
  onRefresh,
  onClose,
}: ShareDialogViewProps) {
  const ready = state.kind === 'ready' ? state : null;
  const confirmationDetails = confirmation === null ? null : confirmationCopy(confirmation);
  const candidates = ready === null ? [] : transferCandidates(ready.members, ready.ownerId);
  const inviteDisabled = pending || ready === null || !canSubmitInvite(inviteEmail);

  return (
    <div className="members-overlay">
      <section
        id="members-panel"
        className="members-panel"
        data-testid="members-panel"
        data-state={state.kind}
        role="dialog"
        aria-modal="true"
        aria-labelledby="members-title"
        aria-busy={pending}
        tabIndex={-1}
      >
        <header className="members-panel__head">
          <div className="members-panel__heading">
            <h2 id="members-title" className="members-panel__title">
              共享文档
            </h2>
            <p className="members-panel__subtitle">
              <code className="members-panel__doc-id">{documentId}</code>
              <span> · 只有所有者可以邀请、移除成员或转让所有权</span>
            </p>
          </div>
          <div className="members-panel__head-actions">
            <button
              type="button"
              className="members-button"
              data-testid="members-refresh"
              title="重新读取成员列表"
              disabled={pending || state.kind === 'loading'}
              onClick={onRefresh}
            >
              刷新
            </button>
            <button
              type="button"
              className="members-button members-button--ghost"
              data-testid="members-close"
              title="关闭共享面板"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </header>

        {failure === null ? null : (
          <div
            className="members-error"
            data-testid="members-error"
            data-members-error={failure.kind}
            role="alert"
          >
            <strong className="members-error__title">{failure.title}</strong>
            <span className="members-error__detail">{failure.detail}</span>
          </div>
        )}

        <form
          className="members-invite"
          onSubmit={(event) => {
            event.preventDefault();
            onInvite();
          }}
        >
          <label className="members-field members-field--grow">
            <span className="members-field__label">邀请成员</span>
            <input
              className="members-input"
              data-testid="members-invite-email"
              type="email"
              name="email"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              placeholder="邮箱，例如 grace@insighthub.test"
              value={inviteEmail}
              disabled={pending || ready === null}
              onChange={(event) => onInviteEmailChange(event.target.value)}
            />
          </label>
          <label className="members-field">
            <span className="members-field__label">角色</span>
            <select
              className="members-select"
              data-testid="members-invite-role"
              value={inviteRole}
              disabled={pending || ready === null}
              onChange={(event) => {
                const next = event.target.value;
                if (isInviteRole(next)) onInviteRoleChange(next);
              }}
            >
              {INVITE_ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="members-button members-button--primary"
            data-testid="members-invite-submit"
            disabled={inviteDisabled}
          >
            {pending ? '处理中…' : '邀请'}
          </button>
        </form>

        <p className="members-hint">
          只能邀请已注册的 InsightHub 用户；已是成员的邮箱会直接更新为所选角色。
        </p>

        {state.kind === 'loading' ? (
          <p className="members-loading" data-testid="members-loading" role="status">
            正在加载成员…
          </p>
        ) : null}

        {state.kind === 'error' ? (
          <div
            className="members-error"
            data-testid="members-load-error"
            data-members-error={state.failure.kind}
            role="alert"
          >
            <strong className="members-error__title">{state.failure.title}</strong>
            <span className="members-error__detail">{state.failure.detail}</span>
          </div>
        ) : null}

        {ready === null ? null : (
          <ul className="members-list" data-testid="members-list">
            {ready.members.map((member) => {
              const owner = isOwnerRow(member, ready.ownerId);
              const you = member.userId === currentUserId;
              return (
                <li
                  key={member.userId}
                  className="members-row"
                  data-testid="members-row"
                  data-user-id={member.userId}
                  data-role={member.role}
                  data-owner={owner ? 'true' : undefined}
                >
                  <div className="members-row__identity">
                    <strong className="members-row__name" data-testid="members-name">
                      {displayNameOf(member)}
                      {you ? <span className="members-row__you">（你）</span> : null}
                    </strong>
                    <span className="members-row__email" data-testid="members-email">
                      {member.email}
                    </span>
                  </div>

                  <span className="members-role" data-testid="members-role" data-role={member.role}>
                    {memberRoleLabel(member.role)}
                  </span>

                  {owner ? (
                    /*
                      The owner's row has no role select and no remove button: both are refused by
                      the frozen API. Ownership moves only by transfer, so that is the one control
                      this row offers.
                    */
                    <button
                      type="button"
                      className="members-button members-button--transfer"
                      data-testid="members-transfer"
                      title="把所有权转让给另一位成员"
                      disabled={pending}
                      onClick={onRequestTransfer}
                    >
                      转让 Owner
                    </button>
                  ) : (
                    <div className="members-row__actions">
                      <select
                        className="members-select"
                        data-testid="members-role-select"
                        data-role={member.role}
                        aria-label={`修改 ${displayNameOf(member)} 的角色`}
                        value={member.role}
                        disabled={pending}
                        onChange={(event) => {
                          const next = event.target.value;
                          if (isInviteRole(next)) onChangeRole(member, next);
                        }}
                      >
                        {INVITE_ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="members-button members-button--danger"
                        data-testid="members-remove"
                        title={`移除 ${displayNameOf(member)}`}
                        disabled={pending}
                        onClick={() => onRequestRemove(member)}
                      >
                        移除
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <footer className="members-panel__foot">
          <span className="members-hint">
            离开后需要重新被邀请才能访问。所有者必须先转让所有权。
          </span>
          <button
            type="button"
            className="members-button members-button--danger"
            data-testid="members-leave"
            title="离开本文档"
            disabled={pending || ready === null}
            onClick={onRequestLeave}
          >
            离开文档
          </button>
        </footer>

        {confirmation === null || confirmationDetails === null ? null : (
          <div
            className="members-confirm"
            data-testid="members-confirm"
            data-confirm-action={confirmation.kind}
            role="alertdialog"
            aria-labelledby="members-confirm-title"
          >
            <h3 id="members-confirm-title" className="members-confirm__title">
              {confirmationDetails.title}
            </h3>
            <p className="members-confirm__detail">{confirmationDetails.detail}</p>

            {confirmation.kind === 'transfer' ? (
              <label className="members-field">
                <span className="members-field__label">新所有者</span>
                <select
                  className="members-select"
                  data-testid="members-transfer-target"
                  value={confirmation.targetId ?? ''}
                  disabled={pending}
                  onChange={(event) => onTransferTargetChange(event.target.value)}
                >
                  <option value="">请选择一位成员…</option>
                  {candidates.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {`${displayNameOf(member)}（${member.email}）`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="members-confirm__actions">
              <button
                type="button"
                className="members-button members-button--ghost"
                data-testid="members-confirm-cancel"
                disabled={pending}
                onClick={onCancelConfirm}
              >
                取消
              </button>
              <button
                type="button"
                className="members-button members-button--danger"
                data-testid="members-confirm-submit"
                disabled={pending || !canConfirm(confirmation)}
                onClick={onConfirm}
              >
                {pending ? '处理中…' : confirmationDetails.confirmLabel}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
