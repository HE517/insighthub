/**
 * The mapping from Clerk's hash routes to the surface the gate mounts.
 */
import { describe, expect, it } from 'vitest';

import { authSurfaceFor } from './authSurface.js';

describe('authSurfaceFor', () => {
  it('maps Clerk sign-up hashes to the sign-up surface', () => {
    expect(authSurfaceFor('#/sign-up')).toBe('sign-up');
    expect(authSurfaceFor('#/signUp')).toBe('sign-up');
    expect(authSurfaceFor('#sign-up')).toBe('sign-up');
    expect(authSurfaceFor('#/sign-up/verify-email-address')).toBe('sign-up');
  });

  it('defaults everything else to sign-in', () => {
    expect(authSurfaceFor('')).toBe('sign-in');
    expect(authSurfaceFor('#/sign-in')).toBe('sign-in');
    expect(authSurfaceFor('#/factor-one')).toBe('sign-in');
    expect(authSurfaceFor('#/some/other/route')).toBe('sign-in');
  });
});