/**
 * The `New document` click, as a DOM-free state machine (M4 B12.5, `docs/DECISIONS.md` D-084 #7).
 *
 * ## What one click does, in order
 *
 * ```text
 * run()
 *   → POST /api/documents                      (one request, never two)
 *   → 201 { documentId }
 *       → refreshDirectory()                   (the list is server truth; the new doc must appear)
 *       → selectDocument(documentId)           (the existing switch path — see below)
 *     failure
 *       → onFailure(error)                     (no refresh, no switch)
 * ```
 *
 * The switch is the **same** path the directory rows use (`documentActions.documentSelected`),
 * which `App.tsx` keys `DocumentWorkspace` on. That is what closes the AI panel: the workspace is
 * remounted for the new `documentId` and the panel lives inside it (`docs/CONTRACTS.md` §5.4 —
 * one socket, one room). No new route and no new action is introduced.
 *
 * ## Why this is a function and not inline in the component
 *
 * `AGENTS.md` R5/D-084 #6 require the double-click semantics to be provable without a browser: the
 * panel's effects cannot run in the Node gate. This module takes its three effects as
 * dependencies, so a test can call `run()` twice while the first is pending and count the
 * requests, assert the refresh-runs-before-switch order, and assert that a failure never switches.
 *
 * The guard is a real second line of defence, not a duplicate of the disabled button: a double
 * click can land twice in the same tick, before React has re-rendered the button as disabled.
 *
 * ## Cancellation (R9)
 *
 * Each `run()` creates one `AbortController` and hands its signal to `create`, which forwards it
 * to `fetch`. `abort()` is called by the directory on unmount, so a pending creation cannot resolve
 * into a component that is gone — and an aborted run reports nothing (`ignored`), because a
 * cancelled request is not a failure.
 */
import type { CreatedDocument } from './documentCreation.js';

/** What one `run()` settled as. `ignored` = already pending, or cancelled. */
export type NewDocumentRunOutcome = 'created' | 'failed' | 'ignored';

export interface NewDocumentFlowDependencies {
  /** The HTTP call. Receives the run's `AbortSignal`; rejects with a typed `DocumentCreateError`. */
  readonly create: (signal: AbortSignal) => Promise<CreatedDocument>;
  /** Reload `GET /api/documents`. Runs **before** the switch, so the server list is already fresh. */
  readonly refreshDirectory: () => void;
  /** Switch the workspace through the existing `documentSelected` action. */
  readonly selectDocument: (documentId: string) => void;
  /** `true` before the request, `false` when it settled(aborted); drives `disabled`. */
  readonly onPendingChange: (pending: boolean) => void;
  /** Receives the raw failure; the caller maps it to copy (`newDocumentCopy.ts`). */
  readonly onFailure: (error: unknown) => void;
}

export interface NewDocumentFlow {
  /** Idempotent while pending: a second call while the first is in flight does nothing. */
  run(): Promise<NewDocumentRunOutcome>;
  /** Cancel the in-flight request (unmount). Idempotent, and never reports a failure. */
  abort(): void;
}

export function createNewDocumentFlow(deps: NewDocumentFlowDependencies): NewDocumentFlow {
  let inFlight = false;
  let controller: AbortController | null = null;

  return {
    async run(): Promise<NewDocumentRunOutcome> {
      if (inFlight) return 'ignored';
      inFlight = true;
      const request = new AbortController();
      controller = request;
      deps.onPendingChange(true);
      try {
        const created = await deps.create(request.signal);
        if (request.signal.aborted) return 'ignored';
        // The list first, then the switch: the directory has already been asked to re-read the
        // server's list when the workspace remounts (which also closes the panel, by design).
        deps.refreshDirectory();
        deps.selectDocument(created.documentId);
        return 'created';
      } catch (error) {
        // A cancelled request is the normal outcome of closing the panel; it must not become an
        // error message about a document the user never asked to stop creating.
        if (request.signal.aborted) return 'ignored';
        deps.onFailure(error);
        return 'failed';
      } finally {
        inFlight = false;
        if (controller === request) controller = null;
        deps.onPendingChange(false);
      }
    },

    abort(): void {
      controller?.abort();
    },
  };
}
