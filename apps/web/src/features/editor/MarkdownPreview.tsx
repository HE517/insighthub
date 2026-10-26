/**
 * Preview mode: a read-only rendering of the document's `Y.Text`.
 *
 * ## Source of truth
 *
 * The only input is `session.doc.getText(DOCUMENT_TEXT_KEY)` — the same `Y.Text` the editor
 * writes to (`apps/web/src/features/editor/CollaborativeMarkdownEditor.tsx`). Preview adds
 * **no** Redux field, no second document model and no copy of the body anywhere durable
 * (`AGENTS.md` R11). The string held in `sourceRef` is a *render snapshot*: it is replaced
 * only from `Y.Text`, never written back, and it exists so the debounced re-render has
 * something to hand React. There is no path from this component to `insert`, `delete` or
 * `transact` (the feed has no write method at all).
 *
 * ## Updates while visible
 *
 * Subscription is tied to this component's lifetime, and this component is mounted **only**
 * in preview mode. Entering preview therefore renders once immediately (the initial
 * snapshot), then `previewFeed` debounces `Y.Text` changes by 400 ms. Switching back to
 * edit unmounts the component, which clears the pending timer and detaches the observer —
 * no hidden preview re-renders behind the editor.
 *
 * `data-state` is `rendering` from the moment a new snapshot is accepted until the renderer
 * reports that it committed; it is never used as a live region and carries no document text.
 *
 * ## Lazy chunk
 *
 * The renderer is `React.lazy`-loaded, so `react-markdown` + `remark-gfm` live in their own
 * chunk. The `Suspense` fallback is a static, silent line of text: a screen reader is not
 * told the whole document changed (and the preview is not an `aria-live` region at all).
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { DOCUMENT_TEXT_KEY, type CollaborativeSession } from '@insighthub/shared';

import { createPreviewFeed, PREVIEW_DEBOUNCE_MS } from './previewFeed.js';

/** The one lazy boundary. Everything `react-markdown` needs is inside this module. */
const MarkdownPreviewRenderer = lazy(() => import('./MarkdownPreviewRenderer.js'));

export interface MarkdownPreviewProps {
  /** An `active` session. The caller narrows `CollaborativeSessionResult` first. */
  session: CollaborativeSession;
  /** Debounce override for tests/tools; production uses `PREVIEW_DEBOUNCE_MS` (400 ms). */
  debounceMs?: number;
}

type RenderPhase = 'rendering' | 'ready';

export function MarkdownPreview({
  session,
  debounceMs = PREVIEW_DEBOUNCE_MS,
}: MarkdownPreviewProps) {
  // `Y.Text` is the document. `getText` is a keyed lookup, not a copy.
  const text = session.doc.getText(DOCUMENT_TEXT_KEY);

  /**
   * The current render snapshot. Initialised from `Y.Text` during render (an idempotent
   * ref initialisation, not a mirror that anything else can write): the first paint must
   * show the document instead of an empty frame that is replaced a tick later.
   *
   * The parent keys this component by `session.localClientId`, so a different replica is a
   * different component instance. The guard below only covers a caller that ignores that.
   */
  const sourceRef = useRef<string | null>(null);
  const sessionRef = useRef(session);
  if (sessionRef.current !== session || sourceRef.current === null) {
    sessionRef.current = session;
    sourceRef.current = text.toString();
  }
  const source = sourceRef.current ?? '';

  /** A render counter: the snapshot itself lives in the ref, only the "redraw" does not. */
  const [, requestRender] = useState(0);
  const [phase, setPhase] = useState<RenderPhase>('rendering');

  useEffect(() => {
    const feed = createPreviewFeed({
      text,
      debounceMs,
      onSnapshot: (markdown) => {
        if (markdown === sourceRef.current) return;
        sourceRef.current = markdown;
        setPhase('rendering');
        requestRender((revision) => revision + 1);
      },
    });
    feed.activate();
    return () => feed.deactivate();
  }, [text, debounceMs]);

  // The renderer calls this after it has committed the snapshot. Stable identity so the
  // renderer's effect only depends on `source`.
  const markReady = useCallback(() => setPhase('ready'), []);

  return (
    <section
      className="markdown-preview"
      data-testid="markdown-preview"
      data-state={phase}
      aria-label="Markdown preview"
    >
      <Suspense
        fallback={
          <p className="markdown-preview__loading" data-testid="markdown-preview-loading">
            Rendering preview…
          </p>
        }
      >
        <MarkdownPreviewRenderer source={source} onRendered={markReady} />
      </Suspense>
    </section>
  );
}
