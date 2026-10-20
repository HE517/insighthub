/**
 * The visible read-only notice, rendered for the four role states.
 *
 * This is the "the notice appears / does not appear" half of A7 F1's UI evidence, asserted at
 * the **markup** level: `capabilityGate(role)` (the real gate) → `ReadOnlyNotice` (the real
 * component) → static markup. No DOM is needed for that, so it runs in this workspace's
 * `node` Vitest environment; the real browser rendering belongs to A6.
 *
 * The negative assertions are the point of the file:
 *
 * - `owner`/`editor` and the **unknown** role must produce **no** notice at all — an unknown
 *   role that says "read-only" would lock a user out of their own unsent text (§17.9, R10);
 * - the copy must never claim that anything was saved (`docs/DECISIONS.md` D-064 §1).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { DOCUMENT_ROLES } from '@insighthub/shared';

import { capabilityGate, type CapabilityGate } from './capabilityGate.js';
import { ReadOnlyNotice } from './ReadOnlyNotice.js';
import { READ_ONLY_NOTICE_TESTID, readOnlyNoticeFor } from './readOnlyNoticeCopy.js';

function markupFor(gate: CapabilityGate): string {
  return renderToStaticMarkup(createElement(ReadOnlyNotice, { gate }));
}

function markupForRole(role: CapabilityGate['role']): string {
  return markupFor(capabilityGate(role));
}

describe('read-only notice: no notice when editing is allowed', () => {
  for (const role of ['owner', 'editor'] as const) {
    it(`renders nothing for ${role}`, () => {
      const gate = capabilityGate(role);
      expect(gate.readOnly).toBe(false);
      expect(readOnlyNoticeFor(gate)).toBeNull();
      expect(markupFor(gate)).toBe('');
    });
  }

  it('renders nothing while the role is unknown', () => {
    // The case that must never regress: `getRole() === null` is "the server has not told us",
    // not "you are a viewer" (AGENTS.md R10, CONTRACTS §17.9 gating consequence).
    const gate = capabilityGate(null);
    expect(gate.readOnly).toBe(false);
    expect(readOnlyNoticeFor(gate)).toBeNull();
    expect(markupForRole(null)).toBe('');
  });
});

describe('read-only notice: shown for a known role without canEdit', () => {
  it('renders a visible, honest notice for viewer', () => {
    const gate = capabilityGate('viewer');
    expect(gate.readOnly).toBe(true);

    const html = markupFor(gate);
    expect(html).toContain(`data-testid="${READ_ONLY_NOTICE_TESTID}"`);
    expect(html).toContain('role="status"');
    // The wording CONTRACTS §17.9 requires, in some capitalisation.
    expect(html).toMatch(/read-only for your role/i);
    // The role is named, so the user can tell why.
    expect(html).toContain('viewer');
    // It must not claim a save happened, or imply one.
    expect(html).not.toMatch(/saved|saving/i);
    // Nor may it claim the role change reaches the UI immediately (D-066 §5).
    expect(html).not.toMatch(/immediately|instant/i);
  });

  it('matches the capability table for every role, not a hardcoded list', () => {
    // If the ladder ever gains a role, this loop already knows the expected answer.
    for (const role of DOCUMENT_ROLES) {
      const gate = capabilityGate(role);
      const model = readOnlyNoticeFor(gate);
      if (gate.readOnly) {
        expect(model).not.toBeNull();
        expect(markupForRole(role)).toMatch(/read-only for your role/i);
      } else {
        expect(model).toBeNull();
        expect(markupForRole(role)).toBe('');
      }
    }
  });

  it('refuses to produce read-only copy for an unknown role, even if a gate says so', () => {
    // Defence in depth on the one invariant that must not depend on the gate being unchanged:
    // `readOnlyNoticeFor` itself will not turn "we have not been told" into "you may not type".
    const contradictory: CapabilityGate = {
      role: null,
      known: false,
      capabilities: {
        canRead: true,
        canComment: true,
        canEdit: false,
        canManageMembers: false,
      },
      readOnly: true,
    };

    expect(readOnlyNoticeFor(contradictory)).toBeNull();
    expect(markupFor(contradictory)).toBe('');
  });
});
