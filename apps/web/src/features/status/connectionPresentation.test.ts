/**
 * Tests for the offline/connection presentation policy.
 *
 * A2 acceptance criterion 5 is "offline state is visible and editing stays
 * enabled". The policy that guarantees it is pure data, so it is asserted here
 * rather than only being eyeballed in a browser.
 */
import { describe, expect, it } from 'vitest';

import { CONNECTION_STATUSES, canEditWhile, type ConnectionStatus } from '@insighthub/shared';

import {
  CONNECTION_PRESENTATION,
  offlineNoticeText,
  presenceMayBeStale,
} from './connectionPresentation.js';

describe('connection presentation', () => {
  it('covers every wire status', () => {
    for (const status of CONNECTION_STATUSES) {
      expect(CONNECTION_PRESENTATION[status]).toBeDefined();
      expect(CONNECTION_PRESENTATION[status].label.length).toBeGreaterThan(0);
    }
  });

  it('describes offline as a normal, local-only editing state', () => {
    expect(CONNECTION_PRESENTATION.offline.localOnlyEdits).toBe(true);
    expect(offlineNoticeText('offline')).toContain('editing continues');
  });

  it('shows no notice when edits are being shared', () => {
    expect(offlineNoticeText('connected')).toBeNull();
    expect(offlineNoticeText('idle')).toBeNull();
  });

  it('treats reconnecting and error as local-only too, never as a silent state', () => {
    for (const status of ['reconnecting', 'error'] as ConnectionStatus[]) {
      expect(CONNECTION_PRESENTATION[status].localOnlyEdits).toBe(true);
      expect(offlineNoticeText(status)).not.toBeNull();
    }
  });

  it('marks presence as possibly stale whenever the channel is down', () => {
    expect(presenceMayBeStale('offline')).toBe(true);
    expect(presenceMayBeStale('reconnecting')).toBe(true);
    expect(presenceMayBeStale('error')).toBe(true);
    expect(presenceMayBeStale('connected')).toBe(false);
    expect(presenceMayBeStale('connecting')).toBe(false);
  });

  it('claims local-only edits for every status where they cannot be shared', () => {
    // `canEditWhile` is the shared predicate for "may an edit have no server
    // acknowledgement". Every status it excludes must be visible in the UI —
    // staying silent about a full disconnect is how a user loses trust in R10.
    for (const status of CONNECTION_STATUSES) {
      if (!canEditWhile(status)) {
        expect(CONNECTION_PRESENTATION[status].localOnlyEdits).toBe(true);
      }
    }
    // and `reconnecting` is local-only as well, even though the shared helper
    // still allows edits, because nothing is being delivered right now.
    expect(canEditWhile('reconnecting')).toBe(true);
    expect(CONNECTION_PRESENTATION.reconnecting.localOnlyEdits).toBe(true);
  });

  it('never gates editing on the connection status', () => {
    // `docs/CONTRACTS.md` §10.1: a session becomes active from local state, so no
    // status may render the editor read-only. The presentation table has no field
    // that could disable it, and no status is marked as unusable.
    for (const status of CONNECTION_STATUSES) {
      const presentation = CONNECTION_PRESENTATION[status];
      expect(presentation).not.toHaveProperty('disabled');
      expect(presentation.label.toLowerCase()).not.toContain('read-only');
    }
  });
});
