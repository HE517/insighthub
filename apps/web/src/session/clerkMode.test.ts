/**
 * Mode selection: the one switch that decides whether this build is the demo app or Clerk
 * (`docs/CONTRACTS.md` §18.6; M4 B2 acceptance 1).
 *
 * The "no key" cases are the important ones: the 68 browser scenarios depend on an absent key
 * meaning "the pre-M4 application", so a blank or malformed value must not creep into a mode.
 */
import { describe, expect, it } from 'vitest';

import { resolveAppMode } from './clerkMode.js';

const PLACEHOLDER_KEY = 'pk_test_placeholder-not-a-real-clerk-key';

describe('resolveAppMode', () => {
  it('keeps the demo application when no key is configured', () => {
    expect(resolveAppMode({})).toEqual({ kind: 'demo' });
    expect(resolveAppMode({ VITE_CLERK_PUBLISHABLE_KEY: undefined })).toEqual({ kind: 'demo' });
  });

  it('treats blank and non-string values as "not configured"', () => {
    // A `.env` line such as `VITE_CLERK_PUBLISHABLE_KEY=` is a typo, not a request for a login
    // wall that nobody can pass.
    expect(resolveAppMode({ VITE_CLERK_PUBLISHABLE_KEY: '' })).toEqual({ kind: 'demo' });
    expect(resolveAppMode({ VITE_CLERK_PUBLISHABLE_KEY: '   ' })).toEqual({ kind: 'demo' });
    expect(resolveAppMode({ VITE_CLERK_PUBLISHABLE_KEY: 42 })).toEqual({ kind: 'demo' });
    expect(resolveAppMode({ VITE_CLERK_PUBLISHABLE_KEY: null })).toEqual({ kind: 'demo' });
  });

  it('enables Clerk mode for a non-blank key, trimmed', () => {
    expect(resolveAppMode({ VITE_CLERK_PUBLISHABLE_KEY: PLACEHOLDER_KEY })).toEqual({
      kind: 'clerk',
      publishableKey: PLACEHOLDER_KEY,
    });
    expect(resolveAppMode({ VITE_CLERK_PUBLISHABLE_KEY: `  ${PLACEHOLDER_KEY}  ` })).toEqual({
      kind: 'clerk',
      publishableKey: PLACEHOLDER_KEY,
    });
  });
});
