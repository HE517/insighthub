/**
 * The Markdown renderer used by preview mode — **the only file that imports the Markdown
 * renderer dependency**, and therefore the only file whose code lands in the lazy chunk.
 *
 * ## Why it is a separate module
 *
 * `MarkdownPreview.tsx` loads this module with `React.lazy(() => import(...))`, so
 * `react-markdown`, `remark-gfm` and their ~90 transitive packages are split into their own
 * chunk and never enter the initial bundle. The editor must stay as light as it was before
 * preview existed (`docs/DECISIONS.md` D-086 §3 measured the bundle; this V1 keeps the
 * promise by construction).
 *
 * ## Safety model (no HTML, no images, no dangerous URLs)
 *
 * - **Raw HTML is not parsed.** There is no `rehype-raw`, no
 *   `dangerouslySetInnerHTML`, and no sanitizer to get wrong: `react-markdown` turns raw
 *   HTML nodes into text, and React escapes that text. `<script>`, `<iframe>` and
 *   `<img onerror=…>` can therefore only ever appear as literal characters.
 * - **Images are not rendered.** `![alt](url)` becomes a text placeholder carrying the alt
 *   text; no `<img>` is created, so previewing a document can never issue an outbound
 *   request (no tracking pixel, no mixed content, no 404 noise).
 * - **Links are allowlisted by protocol.** Only `http:`, `https:` and `mailto:` survive
 *   (relative URLs and `#fragments` too); a `javascript:` target is dropped and the link
 *   label is rendered as plain text. Surviving links get `rel="noopener noreferrer"` and
 *   deliberately **no** `target="_blank"` — preview must not spawn a browsing context.
 *
 * ## Why the component reports `onRendered`
 *
 * The container shows `data-state="rendering"` until the content has actually committed. An
 * effect in this module fires after commit, which is the only honest moment to say
 * "the preview you are looking at is the current snapshot".
 */
import { useEffect, useRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Protocols a preview link may use. Anything else is dropped, not "sanitised later". */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Base used only to classify relative URLs; it is never navigated to. */
const CLASSIFICATION_BASE = 'https://insighthub.invalid/';

/**
 * `urlTransform` for `react-markdown`. Returns the URL unchanged when it is relative or uses
 * an allowlisted protocol, otherwise the empty string, which the link renderer treats as
 * "not a link".
 *
 * This is stricter than `react-markdown`'s default (which also allows `irc:`/`xmpp:`): the
 * product has no use for those, and a closed list is easier to audit.
 */
export function safePreviewUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') return '';
  // A fragment is same-document navigation and has no protocol to check.
  if (trimmed.startsWith('#')) return trimmed;
  try {
    const parsed = new URL(trimmed, CLASSIFICATION_BASE);
    if (!SAFE_PROTOCOLS.has(parsed.protocol)) return '';
    return trimmed;
  } catch {
    return '';
  }
}

interface PreviewLinkProps {
  href?: string | undefined;
  title?: string | undefined;
  children?: ReactNode;
}

/**
 * One link renderer for the whole preview.
 *
 * `href === ''` means `safePreviewUrl` refused the target. The label is kept (so the reader
 * still sees the text) but it is not clickable: a blocked `javascript:` URL must not leave a
 * focusable anchor with an empty href either.
 */
function PreviewLink({ href, title, children }: PreviewLinkProps) {
  if (href === undefined || href === '') {
    return <span className="markdown-preview__link-blocked">{children}</span>;
  }
  return (
    <a href={href} title={title} rel="noopener noreferrer">
      {children}
    </a>
  );
}

interface PreviewImageProps {
  alt?: string | undefined;
  title?: string | undefined;
}

/**
 * Images are reduced to their alt text. No `src` is ever placed in the DOM, so the browser
 * cannot fetch it. `data-image-alt` keeps the original alt queryable for tests and tooling.
 */
function PreviewImage({ alt, title }: PreviewImageProps) {
  const label = alt === undefined || alt.trim() === '' ? '[image]' : `[image: ${alt}]`;
  return (
    <span className="markdown-preview__image" data-image-alt={alt ?? ''} title={title}>
      {label}
    </span>
  );
}

/**
 * Only `a` and `img` are overridden. Everything else (`h1`–`h6`, `p`, `strong`, `em`, `ul`,
 * `ol`, `blockquote`, `code`, `pre`, `table`, …) is rendered by `react-markdown` as the
 * semantic element it already is; the design tokens are applied by `styles.css`.
 */
const components: Components = {
  a: PreviewLink,
  img: PreviewImage,
};

export interface MarkdownPreviewRendererProps {
  /** The Markdown snapshot. Comes from `Y.Text` through the debounced preview feed. */
  source: string;
  /** Called after the snapshot has committed — drives `data-state="ready"`. */
  onRendered?: (() => void) | undefined;
}

export default function MarkdownPreviewRenderer({
  source,
  onRendered,
}: MarkdownPreviewRendererProps) {
  // Held in a ref so an inline callback from the container cannot make this effect re-run on
  // every parent render (and so `source` is the only dependency that matters).
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  useEffect(() => {
    onRenderedRef.current?.();
  }, [source]);

  return (
    <div className="markdown-preview__body" data-testid="markdown-preview-content">
      {source.trim() === '' ? (
        <p className="markdown-preview__empty">This document is empty.</p>
      ) : (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={safePreviewUrl}
          components={components}
        >
          {source}
        </ReactMarkdown>
      )}
    </div>
  );
}
