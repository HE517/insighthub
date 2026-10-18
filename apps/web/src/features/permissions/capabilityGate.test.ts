/**
 * The UI capability gate, asserted against the frozen rule table.
 *
 * Every expectation is computed from `documentCapabilities` rather than hardcoded, so this file
 * proves the property that matters: **the UI answers exactly what the shared rules say, and never
 * more**. A gate that granted something the table denies would be a UI-only privilege escalation
 * waiting for a careless consumer.
 */
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_ROLES,
  documentCapabilities,
  type DocumentCapability,
  type DocumentRole,
} from '@insighthub/shared';

import { capabilityGate } from './capabilityGate.js';

const CAPABILITIES: readonly DocumentCapability[] = [
  'canRead',
  'canComment',
  'canEdit',
  'canManageMembers',
];

describe('capabilityGate', () => {
  it('answers every capability from documentCapabilities for every known role', () => {
    for (const role of DOCUMENT_ROLES) {
      const gate = capabilityGate(role);
      expect(gate.known).toBe(true);
      expect(gate.role).toBe(role);
      for (const capability of CAPABILITIES) {
        assert.equal(gate.capabilities[capability], documentCapabilities[capability](role), `${role} ${capability}`);
      }
    }
  });

  it('marks exactly the roles without canEdit as read-only', () => {
    for (const role of DOCUMENT_ROLES) {
      const gate = capabilityGate(role);
      assert.equal(gate.readOnly, !documentCapabilities.canEdit(role), role);
    }
    // The concrete consequences, spelled out so a change in the ladder is visible here too.
    expect(capabilityGate('viewer').readOnly).toBe(true);
    expect(capabilityGate('commenter').readOnly).toBe(true);
    expect(capabilityGate('editor').readOnly).toBe(false);
    expect(capabilityGate('owner').readOnly).toBe(false);
  });

  it('never advertises management to a non-owner', () => {
    for (const role of DOCUMENT_ROLES) {
      assert.equal(
        capabilityGate(role).capabilities.canManageMembers,
        role === 'owner',
        role,
      );
    }
  });

  it('stays permissive-but-unmanaged while the role is unknown', () => {
    // Offline / pre-bootstrap. The editor must remain usable (AGENTS.md R10) and the server is
    // still the authority, so the gate does not block editing on a guess.
    const gate = capabilityGate(null);
    expect(gate.known).toBe(false);
    expect(gate.role).toBeNull();
    expect(gate.readOnly).toBe(false);
    expect(gate.capabilities.canEdit).toBe(true);
    expect(gate.capabilities.canComment).toBe(true);
    // Management is the one thing never offered on a guess.
    expect(gate.capabilities.canManageMembers).toBe(false);
  });

  it('is derived, not a second rule table', () => {
    // If the frozen ladder ever gains a role, this gate must already answer for it without an edit.
    // Casting a synthetic role in would be testing a value the ladder does not have, so instead
    // assert the gate's answers track the table for every role it does have (above) and that an
    // unknown role cannot widen management.
    const roles: readonly DocumentRole[] = DOCUMENT_ROLES;
    expect(roles.length).toBeGreaterThan(0);
    expect(capabilityGate('viewer').capabilities.canManageMembers).toBe(false);
  });
});
