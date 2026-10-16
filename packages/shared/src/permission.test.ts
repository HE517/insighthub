import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_ROLES,
  documentCapabilities,
  hasAtLeastRole,
  isDocumentRole,
  roleRank,
} from './permission.js';

describe('document role contract', () => {
  it('exposes a stable, ordered role vocabulary', () => {
    expect(DOCUMENT_ROLES).toEqual(['viewer', 'commenter', 'editor', 'owner']);
    expect(roleRank('viewer')).toBeLessThan(roleRank('owner'));
  });

  it('gates capabilities by minimum role', () => {
    expect(documentCapabilities.canRead('viewer')).toBe(true);
    expect(documentCapabilities.canComment('viewer')).toBe(false);
    expect(documentCapabilities.canEdit('commenter')).toBe(false);
    expect(documentCapabilities.canEdit('editor')).toBe(true);
    expect(documentCapabilities.canManageMembers('editor')).toBe(false);
    expect(documentCapabilities.canManageMembers('owner')).toBe(true);
  });

  it('never grants a capability to an unknown role string', () => {
    expect(isDocumentRole('admin')).toBe(false);
    expect(isDocumentRole('editor')).toBe(true);
  });

  it('compares roles instead of relying on callers hardcoding names', () => {
    expect(hasAtLeastRole('owner', 'editor')).toBe(true);
    expect(hasAtLeastRole('viewer', 'commenter')).toBe(false);
    expect(hasAtLeastRole('editor', 'editor')).toBe(true);
  });
});
