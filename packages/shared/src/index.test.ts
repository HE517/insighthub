import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import * as shared from './index.js';

/**
 * The two version constants are the only numbers in this repository that every agent must
 * change **deliberately**. A test that pins them is the difference between "the bump was
 * reviewed" and "the bump happened inside a feature commit nobody re-read".
 *
 * `docs/CONTRACTS.md` §13 / §17.8 and `AGENTS.md` §6 require a bump when the shared surface
 * changes and a decision record when it breaks. This file does not prove the record exists;
 * it proves the number moved, which is what makes the record checkable.
 */
describe('shared contract version', () => {
  it('is 6 after M2 Phase 2 added RoomJoinedPayload.role', () => {
    // 2: M1-A0 (binary data plane, awareness, CollaborativeSession, error vocabulary)
    // 3: M2-P0-2 step 1 (presence write seam)
    // 4: M2-P0-2 step 3 (awareness narrowed to AwarenessBinding)
    // 5: M2 Phase 2 (FORBIDDEN — a closed vocabulary grew, CONTRACTS §17.6)
    // 6: M2 Phase 2 (RoomJoinedPayload.role — a payload gained a required field, §5.2/§17.8)
    expect(shared.SHARED_CONTRACT_VERSION).toBe(6);
  });

  it('keeps PROTOCOL_VERSION at 2: no framing or payload change', () => {
    // §17.6: `FORBIDDEN` rides inside the existing `error` message, so the wire protocol
    // is untouched. Bumping this would falsely claim a wire change.
    expect(shared.PROTOCOL_VERSION).toBe(2);
  });

  it('re-exports the new code through the package barrel', () => {
    // Both apps import from `@insighthub/shared` (AGENTS.md R1). A code that exists only
    // in `errors.ts` and not through the barrel would be unusable by A3.
    expect(shared.WS_ERROR_CODES.FORBIDDEN).toBe('FORBIDDEN');
    assert.equal(shared.isFatalErrorCode(shared.WS_ERROR_CODES.FORBIDDEN), false);
  });
});
