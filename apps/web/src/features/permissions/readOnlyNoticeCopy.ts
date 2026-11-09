/**
 * The copy shown when a **known** role may not edit — and the rule that it is never
 * shown for an unknown one.
 *
 * ## Why the module is named `…Copy`
 *
 * It pairs with the `ReadOnlyNotice.tsx` component, and TypeScript's module resolution is
 * case-insensitive on Windows: `readOnlyNotice.ts` and `ReadOnlyNotice.tsx` collide
 * (`TS1149`). A name that differs by more than capitalisation is not cosmetic — it is what
 * keeps this file the single place the wording lives.
 *
 * ## Why this is a module and not a string inside the component
 *
 * The wording is a contract obligation, not styling:
 *
 * - `docs/CONTRACTS.md` §17.9 requires the read-only state to be **said** ("read-only for
 *   your role"), so a viewer is never left guessing why the editor ignores keystrokes;
 * - the same section forbids implying that a save happened, and `docs/DECISIONS.md` D-064 §1
 *   forbids any claim that UI gating is what stops a write — the server does, at every
 *   enforcement point (§17.5);
 * - D-066 §5 forbids claiming that a role change reaches the UI immediately. The copy
 *   therefore says what the *current* report means and nothing about timing.
 *
 * Keeping the text in one exported function also makes it testable without a DOM: the
 * markup test asserts exactly this model, and no component carries a second copy.
 */
import type { CapabilityGate } from './capabilityGate.js';
import { roleLabel } from './roleLabels.js';

/** `data-testid` of the notice, shared by the component and the tests. */
export const READ_ONLY_NOTICE_TESTID = 'read-only-notice';

export interface ReadOnlyNoticeModel {
  /** Short, honest headline. Always states *why* editing is unavailable. */
  readonly title: string;
  /** One sentence: what the editor does, and what is therefore not written. */
  readonly detail: string;
}

/**
 * The notice for a gate, or `null` when nothing should be shown.
 *
 * `null` is the answer for a role that may edit **and** for an unknown role, on purpose:
 *
 * | gate | notice |
 * | --- | --- |
 * | `owner` / `editor` | `null` — editing works; there is nothing to explain |
 * | `viewer` / `commenter` | "Read-only for your role" |
 * | unknown (`role === null`) | `null` — an unknown role must never be presented as read-only |
 *
 * The `role === null` branch is unreachable through `capabilityGate` today (`readOnly` is
 * `false` there), and it is kept deliberately: it is the one place where a future change to
 * the gate could turn "the server has not told us" into "you may not type", which is exactly
 * the regression `docs/CONTRACTS.md` §17.9 and `AGENTS.md` R10 forbid.
 */
export function readOnlyNoticeFor(gate: CapabilityGate): ReadOnlyNoticeModel | null {
  if (gate.readOnly !== true) return null;
  if (gate.role === null) return null;

  return {
    title: '你的角色为只读',
    detail:
      `你在本文档中的角色是“${roleLabel(gate.role)}”，不包含编辑权限。` +
      '此编辑器已禁用输入，不会向文档写入任何更改。',
  };
}
