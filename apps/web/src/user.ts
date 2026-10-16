/**
 * The local identity published through Yjs awareness.
 *
 * M2 owns real authentication; until then the client presents a stable-per-tab
 * demo identity so two browser tabs appear as two distinct collaborators rather
 * than overwriting one another. The per-tab suffix is what makes the M1
 * acceptance criterion ("two browsers show each other's edits") observable.
 *
 * No secret, token or credential is involved — this is a display name and a
 * random id (AGENTS.md R4).
 */
import type { CollaborativeSessionOptions } from '@insighthub/shared';

/** A per-tab suffix so two tabs on one machine are two collaborators. */
const TAB_SUFFIX = Math.random().toString(36).slice(2, 6);

export const demoUser: CollaborativeSessionOptions['user'] = {
  id: `local-${TAB_SUFFIX}`,
  name: `You (${TAB_SUFFIX})`,
};
