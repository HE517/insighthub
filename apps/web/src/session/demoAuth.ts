/**
 * Demo authentication controls (development only).
 *
 * The demo server accepts `POST /api/session/bootstrap {demoUserId}` from a fixed roster and
 * issues an HttpOnly session. The production Clerk path is deliberately separate; nothing here
 * runs unless the web build has no Clerk publishable key.
 *
 * The `signedOut` flag only exists so a developer can leave the app and come back as another
 * roster identity to test permissions. It is a local UI gate, not a security boundary: the server
 * session is revoked with `DELETE /api/session`, and a reload without the flag simply bootstraps
 * again.
 */
import { apiUrl } from '../api.js';

const SIGNED_OUT_KEY = 'insighthub.demo.signedOut';
const USER_ID_KEY = 'insighthub.demo.userId';

export interface DemoIdentityChoice {
  readonly id: string;
  readonly name: string;
  readonly roleLabel: string;
}

/** The three identities the demo fixture seeds, with the role each has on `demo-document`. */
export const DEMO_IDENTITY_CHOICES: readonly DemoIdentityChoice[] = [
  { id: 'demo-ada', name: 'Ada Lovelace', roleLabel: '所有者' },
  { id: 'demo-grace', name: 'Grace Hopper', roleLabel: '编辑者' },
  { id: 'demo-linus', name: 'Linus Torvalds', roleLabel: '只读查看者' },
];

export function isDemoSignedOut(): boolean {
  try {
    return window.localStorage.getItem(SIGNED_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDemoSignedOut(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(SIGNED_OUT_KEY, '1');
    else window.localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    /* private mode / storage disabled: a reload simply bootstraps again */
  }
}

/**
 * The roster identity the user picked. The page bootstrap must use this; otherwise every reload
 * claims the default `demo-ada` again and silently undoes a switch to Grace/Linus.
 */
export function selectedDemoIdentity(): string {
  try {
    const stored = window.localStorage.getItem(USER_ID_KEY);
    return DEMO_IDENTITY_CHOICES.some((choice) => choice.id === stored)
      ? (stored as string)
      : 'demo-ada';
  } catch {
    return 'demo-ada';
  }
}

export function setSelectedDemoIdentity(demoUserId: string): void {
  try {
    window.localStorage.setItem(USER_ID_KEY, demoUserId);
  } catch {
    /* the explicit id is still used for this request */
  }
}

/** Claim one roster identity and reload; returns false when the server refused. */
export async function signInDemo(demoUserId: string): Promise<boolean> {
  try {
    const response = await fetch(apiUrl('/api/session/bootstrap'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoUserId }),
    });
    if (!response.ok) return false;
    setSelectedDemoIdentity(demoUserId);
    setDemoSignedOut(false);
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

/** Revoke the server session, leave the demo gate closed, then reload. */
export async function signOutDemo(): Promise<void> {
  try {
    await fetch(apiUrl('/api/session'), { method: 'DELETE', credentials: 'include' });
  } finally {
    setDemoSignedOut(true);
    window.location.reload();
  }
}
