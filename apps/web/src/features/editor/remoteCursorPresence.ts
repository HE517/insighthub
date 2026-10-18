/**
 * Lifecycle of the remote-cursor overlay: when to repaint, and when to stop.
 *
 * ## Why this is not part of the CodeMirror extension
 *
 * `remoteCursorExtension.ts` owns the CodeMirror side (state field, decorations,
 * widgets) and therefore imports `@codemirror/view`, which needs a DOM. The part
 * that has a *lifetime* - the awareness subscription, the "repaint after the
 * current update, never during it" rule, and teardown - has no CodeMirror
 * dependency at all. Keeping it here makes it assertable in a Node test and keeps
 * the extension file down to "turn cursors into a decoration set".
 *
 * ## Why every repaint is deferred (DEFECT P0-3)
 *
 * A `ViewPlugin` constructor runs *inside* an update cycle: `EditorView` sets
 * `updateState = Updating` before it instantiates plugins, and `EditorView.update`
 * throws "Calls to EditorView.update are not allowed while an update is in
 * progress" whenever that state is not `Idle`. So
 *
 * ```ts
 * constructor(view) { view.dispatch({ ... }); }   // throws while mounting
 * ```
 *
 * killed the plugin before it rendered anything, which is exactly why no remote
 * caret ever appeared. The first paint and every awareness-driven paint are
 * therefore scheduled on a microtask - after the update that created (or
 * reconfigured) the plugin has finished, and before the browser paints the frame.
 * A timer would do the same, later and less predictably; a microtask is the
 * shortest deferral that leaves the update cycle.
 *
 * ## Why repaints are coalesced
 *
 * `y-protocols` emits `change` and then `update` for a single awareness change, and
 * the deferred first paint can land in the same turn as either. Dispatching per
 * event would send two or three identical effects for one cursor movement. The
 * `scheduled` flag collapses a turn into exactly one dispatch, and because the
 * payload is computed when the dispatch happens, that dispatch always carries the
 * current cursor list rather than a stale snapshot.
 *
 * ## Teardown
 *
 * `destroy()` unsubscribes both awareness events and marks the presence dead, so a
 * microtask queued before teardown cannot dispatch into a destroyed view. It is
 * idempotent: CodeMirror calls it once per plugin instance, but a reconfigure or a
 * double teardown must not throw.
 */
import type { CollaboratorInfo } from '@insighthub/shared';

import {
  collectRemoteCursors,
  observeAwareness,
  type AwarenessView,
  type RemoteCursor,
} from './remoteCursors.js';

/**
 * The minimal view-facing surface this module drives.
 *
 * Structural on purpose: the caller passes `EditorView` reads and writes, and no
 * CodeMirror type crosses this boundary, which is what keeps the module loadable
 * outside a DOM.
 */
export interface RemoteCursorRepaintTarget {
  /** Current document length, used to clamp peer offsets (a range outside throws). */
  documentLength(): number;
  /**
   * Present `cursors`. Called at most once per turn, and never from inside a
   * CodeMirror update cycle.
   */
  dispatch(cursors: readonly RemoteCursor[]): void;
}

export interface RemoteCursorPresenceOptions {
  /** Live awareness object: a binding input, never a source of display strings. */
  awareness: AwarenessView;
  /** The validated accessor (`session.getCollaborators`), read on every repaint. */
  getCollaborators(): readonly CollaboratorInfo[];
  /** This client's awareness id, so the local caret is never drawn twice. */
  localClientId: number;
  /** Where the recomputed cursors go. */
  repaint: RemoteCursorRepaintTarget;
  /**
   * Runs `task` after the current turn. Defaults to a microtask; injected by tests
   * so coalescing and cancellation can be asserted without waiting on the clock.
   */
  defer?(task: () => void): void;
}

export interface RemoteCursorPresence {
  /** Detach the awareness subscription. Idempotent; nothing is rendered after it. */
  destroy(): void;
  readonly destroyed: boolean;
}

export function createRemoteCursorPresence(
  options: RemoteCursorPresenceOptions,
): RemoteCursorPresence {
  const { awareness, getCollaborators, localClientId, repaint } = options;
  const defer = options.defer ?? deferToNextTurn;

  let destroyed = false;
  let scheduled = false;

  const run = (): void => {
    scheduled = false;
    // A repaint queued before teardown must not touch a view that is already gone.
    if (destroyed) return;
    repaint.dispatch(
      collectRemoteCursors(awareness, getCollaborators(), repaint.documentLength(), localClientId),
    );
  };

  const refresh = (): void => {
    if (destroyed || scheduled) return;
    scheduled = true;
    defer(run);
  };

  // Subscribe first, then arm the initial paint: an awareness event that lands in
  // the same turn only re-arms the flag, so the first frame still costs one paint.
  const unsubscribe = observeAwareness(awareness, refresh);
  refresh();

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
    },
    get destroyed(): boolean {
      return destroyed;
    },
  };
}

/**
 * Leave the current turn without leaving the current frame.
 *
 * `queueMicrotask` exists in every browser the app supports and in Node; the
 * `setTimeout` fallback keeps the module usable in an environment that lacks it
 * (it is only ever a deferral, never a debounce, so the delay is irrelevant).
 */
function deferToNextTurn(task: () => void): void {
  if (typeof queueMicrotask === 'function') queueMicrotask(task);
  else setTimeout(task, 0);
}
