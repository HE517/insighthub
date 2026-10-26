/**
 * The preview's read-only feed: one debounced reader of `Y.Text`.
 *
 * ## Why this is a separate, DOM-free module
 *
 * Preview mode must not duplicate the editor's binding. It needs exactly three things:
 *
 * 1. read the current text from the **one** source of truth;
 * 2. be told when that text changed, but only while the preview is visible;
 * 3. coalesce a burst of changes into one re-render (400 ms debounce).
 *
 * Keeping that in a plain object — not in a component — makes the rules testable in this
 * workspace's `node` Vitest environment, where no DOM exists. `MarkdownPreview.tsx` is the
 * thin React wrapper around it.
 *
 * ## Direction of data (one way, always)
 *
 * ```
 * Y.Text ──observe──► previewFeed ──debounce 400ms──► onSnapshot(text) ──► renderer
 * ```
 *
 * There is no second arrow. The feed never calls `insert`, `delete`, `transact` or anything
 * else that writes: it holds a `Y.Text` only to read `toString()` and to observe it. The
 * preview therefore cannot change the document (`AGENTS.md` R11).
 *
 * ## Subscription lifetime
 *
 * `activate()` is called when the preview becomes visible. It attaches the observer **and**
 * emits one snapshot immediately, so entering preview renders once without waiting for an
 * edit. `deactivate()` clears a pending timer and detaches the observer, so a hidden preview
 * costs nothing and can never re-render behind the editor. The React wrapper deactivates on
 * unmount (i.e. when the user switches back to edit).
 *
 * A debounce is deliberately *not* applied to the entry snapshot: the first paint must show
 * the document, not a 400 ms blank.
 */
import type * as Y from 'yjs';

/** V1 update policy: a burst of edits re-renders once, 400 ms after the last change. */
export const PREVIEW_DEBOUNCE_MS = 400;

export interface PreviewFeedOptions {
  /**
   * The document's `Y.Text` (`session.doc.getText(DOCUMENT_TEXT_KEY)`). Read-only input:
   * the feed never writes to it.
   */
  readonly text: Y.Text;
  /** Called with the current Markdown whenever a render is due. */
  readonly onSnapshot: (markdown: string) => void;
  /**
   * Debounce window for edits that arrive while visible. Defaults to
   * `PREVIEW_DEBOUNCE_MS`; tests inject a smaller value only when they do not use timers.
   */
  readonly debounceMs?: number;
}

export interface PreviewFeed {
  /** Idempotent: attaches the observer and emits the first snapshot synchronously. */
  activate(): void;
  /** Idempotent: cancels a pending re-render and detaches the observer. */
  deactivate(): void;
  /** Whether the feed currently observes `Y.Text` (diagnostics and tests). */
  readonly active: boolean;
}

export function createPreviewFeed({
  text,
  onSnapshot,
  debounceMs = PREVIEW_DEBOUNCE_MS,
}: PreviewFeedOptions): PreviewFeed {
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  /**
   * Every change restarts the window, so a continuous typist is rendered once when they
   * pause — not once per keystroke. The observer is detached by `deactivate`, so this
   * cannot fire for a hidden preview; the `active` check is belt-and-braces.
   */
  const onTextChange = (): void => {
    if (!active) return;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (!active) return;
      onSnapshot(text.toString());
    }, debounceMs);
  };

  return {
    get active(): boolean {
      return active;
    },

    activate(): void {
      if (active) return;
      active = true;
      text.observe(onTextChange);
      // Render once now: the preview must not open empty while waiting for an edit.
      onSnapshot(text.toString());
    },

    deactivate(): void {
      if (!active) return;
      active = false;
      cancel();
      text.unobserve(onTextChange);
    },
  };
}
