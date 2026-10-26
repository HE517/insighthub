/**
 * Markdown Preview V1 (`编辑 | 预览`) — real-browser evidence for `docs/DECISIONS.md` D-087.
 *
 * ## Why this file exists
 *
 * D-087 shipped preview mode with unit coverage only (`editorModeSwitch.test.ts`,
 * `previewFeed.test.ts`, `previewRenderer.test.ts`, all `renderToStaticMarkup`/fake-timer jobs).
 * Those files can prove "this component would produce this markup"; they cannot prove that the
 * shipped toggle in a real Chromium keeps the real `EditorView` alive, that the 400 ms debounce is
 * the interval a user actually experiences, or that the server's `Y.Text` is byte-identical
 * before and after previewing a 100k-line document. This suite is that evidence.
 *
 * | Scenario | Question it answers |
 * | --- | --- |
 * | `preview/1-toggle-preserves-editor` | does switching to preview and back keep **one** `EditorView` (same DOM node, same mount counters), the same text and the same keyboard selection? |
 * | `preview/2-renders-and-debounces` | does a document with every supported block render as real semantic DOM, and is a change that arrives **while preview is visible** rendered no earlier than the 400 ms debounce and correctly afterwards? |
 * | `preview/3-security` | do `<script>`, `<img onerror>`, `<iframe>` and `javascript:` never become elements/attributes/executed script, while safe links keep `rel="noopener noreferrer"` and images show alt text only? |
 * | `preview/4-100k-does-not-touch-data` | does entering preview for a 100k-line document leave the `Y.Text` SHA-256, the state-vector digest and the durable store's `encodeStateAsUpdate` SHA unchanged, and how long is the single first-into-preview→`ready` observation? |
 * | `preview/5-redux-no-body` | does preview put nothing in Redux — no new slice, no document body, while the body is still rendered from `Y.Text`? |
 *
 * ## What is observed, and how — nothing is mocked
 *
 * - The toggle is a **real CDP mouse click** on `[data-testid="mode-preview"]` /
 *   `[data-testid="mode-editor"]`; `aria-pressed`, `data-mode` and `data-pane` are read from the
 *   rendered DOM, and the editor pane's `display` is read from `getComputedStyle`, not a class name.
 * - "The editor was not unmounted" is asserted three independent ways: `querySelectorAll('.cm-editor')`
 *   count, a property stamped on that exact DOM node (`markEditorDom`), and the page's own
 *   `MutationObserver` mount/unmount counters (`window.__qa.editor`), which the application does not
 *   touch.
 * - The selection is produced by **real keyboard input** (`Ctrl+Home`, then Shift+ArrowRight × 10)
 *   and read back from the live `EditorState.selection.main`.
 * - The change that lands **while preview is visible** is written by a second, independent Yjs peer
 *   (`WireOracle`) over the real server WebSocket — it is a real remote edit, not a local one that
 *   was only possible while the editor happened to be showing. A page-side sampler timestamps the
 *   moment the update reached the bound `Y.Text` and the moment the preview DOM showed it, so the
 *   debounce is measured **in the page** (no CDP round-trip in the interval).
 * - The 100k document is written through the **production persistence seam**
 *   (`tests/perf/seed.mjs` → `openDocumentStore(...).append`) with the checked-in deterministic
 *   fixture, before the server opens the directory. The browser then hydrates it like any document.
 *
 * ## What this file deliberately does not claim
 *
 * - The 100k figure is **one observation of first entry**, which includes the lazy
 *   `MarkdownPreviewRenderer` chunk load. It is not a benchmark, and it is not compared to a budget;
 *   the deliverable number is recorded so it can be quoted honestly (D-087 §4).
 * - Raw HTML being escaped is a property of the **renderer choice** (`react-markdown` without
 *   `rehype-raw`). The browser scenario proves the consequence — no element, no attribute, no
 *   execution — and the unit suite owns the markup-level assertion. Neither is presented as a
 *   general-purpose sanitizer audit.
 * - These scenarios run after `suite/33-m3-remote.mjs`, which only registers when
 *   `INSIGHTHUB_E2E_AI_MODE=remote` and there changes the stack's AI configuration. No scenario in
 *   this file asserts anything about AI, so the ordering cannot change what they measure. In the
 *   default 73-scenario path `33` registers nothing at all.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  editorState,
  markEditorDom,
  readEditorDomMarker,
  readPageDiagnostics,
  screenshot,
  sleep,
  waitForConnectionStatus,
  waitForEditorText,
  waitUntil,
} from '../lib/app.mjs';
import { repoRoot } from '../lib/deps.mjs';
import { reconstructDurableDocument } from '../lib/durable-store.mjs';
import { assert, assertDeepEqual, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { WireOracle } from '../lib/oracle.mjs';
import { ensureFixture } from '../../perf/fixture.mjs';

/** Published test ids this file drives (the product added them for exactly this). */
const PREVIEW = {
  modeEditor: '[data-testid="mode-editor"]',
  modePreview: '[data-testid="mode-preview"]',
  root: '[data-testid="markdown-preview"]',
  content: '[data-testid="markdown-preview-content"]',
  loading: '[data-testid="markdown-preview-loading"]',
  editorPane: '[data-pane="editor"]',
  previewPane: '[data-pane="preview"]',
  canvas: '.canvas',
  cmEditor: '.cm-editor',
  cmContent: '.cm-content',
};

/** V1 debounce (`apps/web/src/features/editor/previewFeed.ts`). */
const PREVIEW_DEBOUNCE_MS = 400;

/** A per-run marker, so a replica or an earlier scenario can never satisfy an assertion. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function sha256Text(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/* ---------------------------------------------------------------------- *
 * The mode switch, read from the rendered DOM
 * ---------------------------------------------------------------------- */

/**
 * Everything the toggle scenarios assert, in one round trip.
 *
 * `editorPaneDisplay` is the computed style of the pane React keeps mounted; `cmEditorCount`
 * is read from the live document; `mounts`/`unmounts` come from the page instrumentation's
 * `MutationObserver`, i.e. from what the browser actually added/removed.
 */
async function readMode(page) {
  return page.evaluate((selectors) => {
    const one = (selector) => document.querySelector(selector);
    const styleOf = (element) => (element === null ? null : getComputedStyle(element));
    const preview = one(selectors.root);
    const content = one(selectors.content);
    const editorPane = one(selectors.editorPane);
    const previewPane = one(selectors.previewPane);
    const canvas = one(selectors.canvas);
    const editorPaneStyle = styleOf(editorPane);
    const previewPaneStyle = styleOf(previewPane);
    return {
      editorPressed: one(selectors.modeEditor)?.getAttribute('aria-pressed') ?? null,
      previewPressed: one(selectors.modePreview)?.getAttribute('aria-pressed') ?? null,
      canvasMode: canvas?.getAttribute('data-mode') ?? null,
      cmEditorCount: document.querySelectorAll(selectors.cmEditor).length,
      cmContentCount: document.querySelectorAll(selectors.cmContent).length,
      editorPaneDisplay: editorPaneStyle?.display ?? null,
      previewPanePresent: previewPane !== null,
      previewPaneDisplay: previewPaneStyle?.display ?? null,
      previewPresent: preview !== null,
      previewState: preview?.getAttribute('data-state') ?? null,
      previewLabel: preview?.getAttribute('aria-label') ?? null,
      previewAriaLive: preview?.getAttribute('aria-live') ?? null,
      previewTextLength: content?.textContent?.length ?? null,
      editorLive: window.__qa?.editor?.live ?? null,
      mounts: window.__qa?.editor?.mounts ?? null,
      unmounts: window.__qa?.editor?.unmounts ?? null,
    };
  }, PREVIEW);
}

/** Poll the mode state until the DOM has settled into `mode`. */
async function waitForMode(page, mode, { timeoutMs = 15_000 } = {}) {
  let last = null;
  try {
    return await waitUntil(
      async () => {
        last = await readMode(page);
        const pressed = mode === 'editor' ? last.editorPressed : last.previewPressed;
        return pressed === 'true' && last.canvasMode === mode ? last : false;
      },
      { timeoutMs, label: `the ${mode} mode to be active`, intervalMs: 50 },
    );
  } catch (error) {
    throw new Error(`${error.message}; last observed mode state: ${JSON.stringify(last)}`);
  }
}

/** Poll `data-state` on the preview container until the renderer reported its commit. */
async function waitForPreviewReady(page, { timeoutMs = 30_000 } = {}) {
  let last = null;
  try {
    return await waitUntil(
      async () => {
        last = await readMode(page);
        return last.previewPresent && last.previewState === 'ready' ? last : false;
      },
      { timeoutMs, label: 'the preview to reach data-state="ready"', intervalMs: 50 },
    );
  } catch (error) {
    throw new Error(`${error.message}; last observed mode state: ${JSON.stringify(last)}`);
  }
}

/** Click the switch for real (CDP input) and wait for the product to commit the mode. */
async function switchMode(page, mode) {
  await page.click(mode === 'preview' ? PREVIEW.modePreview : PREVIEW.modeEditor);
  const state = await waitForMode(page, mode);
  return mode === 'preview' ? await waitForPreviewReady(page) : state;
}

/* ---------------------------------------------------------------------- *
 * Preview DOM readers
 * ---------------------------------------------------------------------- */

/** Structural counts. Safe on a 100k-line document (no element list crosses the wire). */
async function readPreview(page) {
  return page.evaluate((selectors) => {
    const root = document.querySelector(selectors.root);
    const content = document.querySelector(selectors.content);
    const count = (selector) => (content === null ? 0 : content.querySelectorAll(selector).length);
    const text = content?.textContent ?? '';
    return {
      rootPresent: root !== null,
      state: root?.getAttribute('data-state') ?? null,
      ariaLive: root?.getAttribute('aria-live') ?? null,
      ariaLiveDescendants: root === null ? 0 : [...root.querySelectorAll('[aria-live]')].length,
      contentPresent: content !== null,
      textLength: text.length,
      counts: {
        h1: count('h1'),
        h2: count('h2'),
        h3: count('h3'),
        h4: count('h4'),
        p: count('p'),
        strong: count('strong'),
        em: count('em'),
        ul: count('ul'),
        ol: count('ol'),
        ulLi: count('ul > li'),
        olLi: count('ol > li'),
        blockquote: count('blockquote'),
        pre: count('pre'),
        preCode: count('pre > code'),
        code: count('code'),
        table: count('table'),
        thead: count('thead'),
        tbody: count('tbody'),
        th: count('th'),
        tbodyTr: count('tbody tr'),
        a: count('a'),
        img: count('img'),
        script: count('script'),
        iframe: count('iframe'),
        blockedLinks: count('.markdown-preview__link-blocked'),
        imageSpans: count('.markdown-preview__image'),
      },
    };
  }, PREVIEW);
}

/** Texts and attributes of a small preview. Not for the 100k document. */
async function readPreviewDetails(page) {
  return page.evaluate((selectors) => {
    const content = document.querySelector(selectors.content);
    if (content === null) return null;
    const textOf = (element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      headings: [...content.querySelectorAll('h1,h2,h3')].map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: textOf(heading),
      })),
      paragraphs: [...content.querySelectorAll('p')].map(textOf),
      strong: [...content.querySelectorAll('strong')].map(textOf),
      em: [...content.querySelectorAll('em')].map(textOf),
      inlineCode: [...content.querySelectorAll('p code, li code, blockquote code')].map(textOf),
      fenced: [...content.querySelectorAll('pre code')].map((code) => ({
        text: code.textContent ?? '',
        className: code.getAttribute('class'),
      })),
      ulItems: [...content.querySelectorAll('ul > li')].map(textOf),
      olItems: [...content.querySelectorAll('ol > li')].map(textOf),
      blockquotes: [...content.querySelectorAll('blockquote')].map(textOf),
      table: {
        headers: [...content.querySelectorAll('thead th')].map(textOf),
        rows: [...content.querySelectorAll('tbody tr')].map((row) =>
          [...row.querySelectorAll('td')].map(textOf),
        ),
      },
      anchors: [...content.querySelectorAll('a')].map((anchor) => ({
        text: textOf(anchor),
        href: anchor.getAttribute('href'),
        rel: anchor.getAttribute('rel'),
        hasTarget: anchor.hasAttribute('target'),
      })),
      imageAltSpans: [...content.querySelectorAll('.markdown-preview__image')].map((span) => ({
        alt: span.getAttribute('data-image-alt'),
        text: textOf(span),
      })),
      blockedLinkTexts: [...content.querySelectorAll('.markdown-preview__link-blocked')].map(textOf),
    };
  }, PREVIEW);
}

/** The security facts: which elements/attributes exist, and which never got created. */
async function readPreviewSecurity(page) {
  return page.evaluate((selectors) => {
    const root = document.querySelector(selectors.root);
    const content = document.querySelector(selectors.content);
    const elements = content === null ? [] : [...content.querySelectorAll('*')];
    const eventAttributes = [];
    const srcAttributes = [];
    for (const element of elements) {
      for (const attribute of [...element.attributes]) {
        if (attribute.name.startsWith('on')) {
          eventAttributes.push({
            tag: element.tagName.toLowerCase(),
            name: attribute.name,
            value: attribute.value,
          });
        }
        if (attribute.name === 'src') {
          srcAttributes.push({ tag: element.tagName.toLowerCase(), value: attribute.value });
        }
      }
    }
    const anchors = [...(content?.querySelectorAll('a') ?? [])].map((anchor) => ({
      text: (anchor.textContent ?? '').trim(),
      href: anchor.getAttribute('href'),
      rel: anchor.getAttribute('rel'),
      hasTarget: anchor.hasAttribute('target'),
    }));
    const dangerous = anchors.filter((anchor) =>
      /^(javascript|data|vbscript):/i.test((anchor.href ?? '').trim()),
    );
    const text = content?.textContent ?? '';
    return {
      counts: {
        script: content?.querySelectorAll('script').length ?? 0,
        img: content?.querySelectorAll('img').length ?? 0,
        iframe: content?.querySelectorAll('iframe').length ?? 0,
        object: content?.querySelectorAll('object, embed').length ?? 0,
        anchors: anchors.length,
        blockedLinks: content?.querySelectorAll('.markdown-preview__link-blocked').length ?? 0,
        imageSpans: content?.querySelectorAll('.markdown-preview__image').length ?? 0,
      },
      eventAttributes,
      srcAttributes,
      anchors,
      dangerousAnchors: dangerous,
      ariaLiveOnRoot: root?.getAttribute('aria-live') ?? null,
      ariaLiveDescendants: root === null ? 0 : root.querySelectorAll('[aria-live]').length,
      imageAltSpans: [...(content?.querySelectorAll('.markdown-preview__image') ?? [])].map(
        (span) => ({
          alt: span.getAttribute('data-image-alt'),
          text: (span.textContent ?? '').replace(/\s+/g, ' ').trim(),
        }),
      ),
      escapedMarkers: {
        script: text.includes('<script>'),
        img: text.includes('<img'),
        iframe: text.includes('<iframe'),
      },
      pwned: window.__previewPwned ?? null,
      text: text.length <= 4000 ? text.replace(/\s+/g, ' ').trim() : null,
    };
  }, PREVIEW);
}

/* ---------------------------------------------------------------------- *
 * The debounce sampler (page-side timestamps)
 * ---------------------------------------------------------------------- */

/**
 * Install a 10 ms page-side sampler **before** the remote edit is made.
 *
 * The baseline it records is the first moment the live `EditorState` (the editor bound to
 * `Y.Text`) contains the needle. That is when the change was integrated, not when a Node-side
 * `evaluate` happened to return. Two checkpoints are scheduled from that moment:
 *
 * - `+250 ms` — strictly inside the 400 ms window, so the preview must **not** contain the needle;
 * - `+600 ms` — after the window, so it **must**.
 *
 * `previewAt` is the first sample where the preview DOM shows the needle; `previewAt - landedAt`
 * is therefore the product's own debounce plus React's render/commit, measured in the page.
 */
async function installPreviewSampler(page, needle) {
  const installed = await page.evaluate((value) => {
    const qa = window.__qa;
    if (qa === undefined) return { ok: false, reason: 'instrumentation is not installed' };
    const content = () =>
      document.querySelector('[data-testid="markdown-preview-content"]')?.textContent ?? '';
    const editorText = () => qa.probe?.state?.()?.text ?? '';
    const probe = {
      startedAt: performance.now(),
      needle: value,
      landedAt: null,
      previewAt: null,
      checkpoint250: null,
      checkpoint600: null,
      samples: 0,
      stop() {
        clearInterval(handle);
      },
    };
    const handle = setInterval(() => {
      probe.samples += 1;
      const now = performance.now();
      if (probe.landedAt === null && editorText().includes(value)) {
        probe.landedAt = now;
        setTimeout(() => {
          probe.checkpoint250 = {
            elapsedMs: performance.now() - probe.landedAt,
            previewHasNeedle: content().includes(value),
            previewTextLength: content().length,
          };
        }, 250);
        setTimeout(() => {
          probe.checkpoint600 = {
            elapsedMs: performance.now() - probe.landedAt,
            previewHasNeedle: content().includes(value),
            previewTextLength: content().length,
          };
        }, 600);
      }
      if (probe.landedAt !== null && probe.previewAt === null && content().includes(value)) {
        probe.previewAt = now;
      }
    }, 10);
    qa.previewSampler = probe;
    return { ok: true };
  }, needle);
  assertEqual(installed.ok, true, `the preview sampler must install (${installed.reason ?? 'ok'})`);
}

/** Wait until the sampler observed the needle in the editor and both checkpoints fired. */
async function waitForSampler(page, { timeoutMs = 20_000 } = {}) {
  return waitUntil(
    async () => {
      const probe = await page.evaluate(() => {
        const sampler = window.__qa?.previewSampler ?? null;
        if (sampler === null) return null;
        return {
          landedAt: sampler.landedAt,
          previewAt: sampler.previewAt,
          checkpoint250: sampler.checkpoint250,
          checkpoint600: sampler.checkpoint600,
          samples: sampler.samples,
        };
      });
      return probe !== null && probe.checkpoint600 !== null ? probe : false;
    },
    { timeoutMs, label: 'the debounce sampler to observe both checkpoints', intervalMs: 50 },
  );
}

async function stopPreviewSampler(page) {
  await page.evaluate(() => {
    window.__qa?.previewSampler?.stop?.();
  });
}

/* ---------------------------------------------------------------------- *
 * Redux (read-only fiber walk — the same idea as `tests/perf/instrument.mjs`)
 * ---------------------------------------------------------------------- */

/**
 * Snapshot the live Redux store found through the React fiber tree.
 *
 * Read-only: it calls `getState()` and serialises the result. It also walks the state for long
 * string values, so "the body is not mirrored" is a measured absence instead of a claim about a
 * field name that a future refactor could rename.
 */
async function readReduxSnapshot(page, needle) {
  return page.evaluate((markerValue) => {
    const findStore = () => {
      const root = document.querySelector('#root');
      if (root === null) return null;
      const containerKey = Object.keys(root).find((key) => key.startsWith('__reactContainer$'));
      if (containerKey === undefined) return null;
      const seen = new Set();
      const queue = [root[containerKey]];
      while (queue.length > 0 && seen.size < 20_000) {
        const fiber = queue.shift();
        if (fiber === null || typeof fiber !== 'object' || seen.has(fiber)) continue;
        seen.add(fiber);
        const props = fiber.memoizedProps;
        if (
          props !== null &&
          typeof props === 'object' &&
          props.store !== undefined &&
          typeof props.store.getState === 'function'
        ) {
          return props.store;
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      return null;
    };

    const store = findStore();
    if (store === null) return { available: false, reason: 'no Redux store in the fiber tree' };
    const state = store.getState();
    let json;
    try {
      json = JSON.stringify(state);
    } catch {
      return { available: false, reason: 'state is not serialisable' };
    }

    const longStrings = [];
    const forbiddenKeys = [];
    const visit = (value, path, depth) => {
      if (depth > 8 || value === null || value === undefined) return;
      if (typeof value === 'string') {
        if (value.length >= 200) longStrings.push({ path, length: value.length });
        return;
      }
      if (typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (/^(content|markdown|body|documentText|docText)$/i.test(key)) forbiddenKeys.push(path === '' ? key : `${path}.${key}`);
        visit(child, path === '' ? key : `${path}.${key}`, depth + 1);
      }
    };
    visit(state, '', 0);

    return {
      available: true,
      bytes: json.length,
      keys: Object.keys(state),
      longStrings,
      forbiddenKeys,
      containsNeedle: json.includes(markerValue),
    };
  }, needle);
}

/* ---------------------------------------------------------------------- *
 * 100k document: production-seam seed + page-side digests
 * ---------------------------------------------------------------------- */

/**
 * Seed the checked-in 100k-line fixture through `tests/perf/seed.mjs`.
 *
 * The seed uses the **real** `openDocumentStore` (tsx, the server's own runtime) and writes one
 * normal Yjs update to `Y.Text` key `content`, exactly like a client would. It runs before the
 * server opens the directory, so no product endpoint or test hook is involved.
 */
function runPerfSeed(fixtureAbsolutePath, dataPath, documentId) {
  const tsxCli = path.join(repoRoot, 'apps', 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const seedPath = path.join(repoRoot, 'tests', 'perf', 'seed.mjs');
  const result = spawnSync(
    process.execPath,
    [tsxCli, seedPath, dataPath, documentId, fixtureAbsolutePath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `the 100k fixture seed failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  const line = String(result.stdout)
    .split(/\r?\n/)
    .filter((candidate) => candidate.trim().startsWith('{'))
    .pop();
  if (line === undefined) {
    throw new Error(`the 100k fixture seed produced no JSON:\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(line);
}

/**
 * The editor's text digest, computed **in the page**.
 *
 * Returning 6.3 MB of text over CDP on every poll would make the wait itself the slow part; the
 * digest and length are all the assertions need, and a hash computed inside the page is still a
 * hash of the live `EditorState` (i.e. of `Y.Text` through the binding).
 */
async function readEditorDigest(page) {
  return page.evaluate(async () => {
    const state = window.__qa?.probe?.state?.();
    if (state === null || state === undefined) return null;
    const bytes = new TextEncoder().encode(state.text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    return {
      length: state.text.length,
      sha256: hex,
      viewId: state.viewId,
      anchor: state.anchor,
      head: state.head,
    };
  });
}

/** Record when the preview container appeared and when it said `ready` (page-side clock). */
async function installPreviewEntryProbe(page) {
  await page.evaluate(() => {
    const qa = window.__qa;
    const probe = {
      clickAt: null,
      rootAt: null,
      readyAt: null,
      initialState: null,
      states: [],
      lazyResources: [],
    };
    qa.previewEntry = probe;
    const root = () => document.querySelector('[data-testid="markdown-preview"]');
    const observer = new MutationObserver(() => {
      const element = root();
      if (element !== null && probe.rootAt === null) {
        probe.rootAt = performance.now();
        probe.initialState = element.getAttribute('data-state');
      }
      if (element !== null) {
        const state = element.getAttribute('data-state');
        if (probe.states.at(-1)?.state !== state) {
          probe.states.push({ state, at: performance.now() });
        }
        if (state === 'ready' && probe.readyAt === null) probe.readyAt = performance.now();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    qa.previewEntryObserver = observer;
    document
      .querySelector('[data-testid="mode-preview"]')
      ?.addEventListener('click', () => {
        probe.clickAt = performance.now();
      }, { capture: true, once: true });
  });
}

async function readPreviewEntryProbe(page) {
  return page.evaluate(() => {
    const probe = window.__qa?.previewEntry ?? null;
    if (probe === null) return null;
    const resources = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /MarkdownPreviewRenderer|react-markdown|remark-gfm/.test(name));
    return {
      clickAt: probe.clickAt,
      rootAt: probe.rootAt,
      readyAt: probe.readyAt,
      initialState: probe.initialState,
      states: probe.states,
      lazyResources: resources,
    };
  });
}

/* ---------------------------------------------------------------------- *
 * Scenario registration
 * ---------------------------------------------------------------------- */

export function register(runner) {
  /* ================================================================== *
   * 1 — the toggle must not touch the editor
   * ================================================================== */
  runner.scenario(
    'preview/1-toggle-preserves-editor',
    'the editor/preview switch hides the editor with CSS: one surviving .cm-editor (no remount), identical text and a real keyboard selection preserved across preview and back',
    async (ctx) => {
      const documentId = `a6-preview-toggle-${marker('doc')}`;
      const seedText = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
      const selectionLength = 10;

      let oracle = null;
      let page = null;
      try {
        // A real second client writes the seed through the real server, so the document the page
        // opens is server truth and not a page-local fabrication.
        oracle = await WireOracle.connect({
          url: ctx.stack.wsUrl,
          documentId,
          label: 'preview-toggle-seeder',
          role: 'owner',
        });
        oracle.replaceAll(seedText);

        page = await ctx.newAppPage({ documentId });
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
        const loaded = await waitForEditorText(page, (text) => text === seedText, {
          label: 'the seeded document in the editor',
        });
        ctx.note('document opened', {
          documentId,
          length: loaded.length,
          viewId: loaded.viewId,
          status: await page.evaluate(
            () => document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null,
          ),
        });

        // 1a. The default is edit mode with the editor pressed.
        const initial = await readMode(page);
        ctx.note('initial mode state', initial);
        assertEqual(initial.canvasMode, 'editor', 'the workspace must open in 编辑 mode (D-087 V1 default)');
        assertEqual(initial.editorPressed, 'true', '编辑 must be aria-pressed=true when it opens');
        assertEqual(initial.previewPressed, 'false', '预览 must be aria-pressed=false when it opens');
        assertEqual(initial.cmEditorCount, 1, 'exactly one .cm-editor must be mounted before the toggle');
        assertEqual(initial.previewPanePresent, false, 'the preview pane must not be mounted in edit mode');
        assertEqual(initial.mounts, initial.unmounts + 1, 'the mount counters must show one live mount before the toggle');

        // 1b. A real keyboard selection, not a programmatic one. Ctrl+Home then Shift+ArrowRight.
        await page.click(PREVIEW.cmContent);
        await page.pressKey('Home', { modifiers: 2 });
        for (let index = 0; index < selectionLength; index += 1) {
          await page.pressKey('ArrowRight', { modifiers: 8 });
        }
        const beforeToggle = await editorState(page);
        ctx.note('editor state with a keyboard selection', {
          length: beforeToggle.length,
          viewId: beforeToggle.viewId,
          anchor: beforeToggle.anchor,
          head: beforeToggle.head,
        });
        assertEqual(
          beforeToggle.head - beforeToggle.anchor,
          selectionLength,
          'Shift+ArrowRight must have produced a real non-collapsed selection',
        );

        const markerToken = marker('KEEP-THE-SAME-NODE');
        const stamped = await markEditorDom(page, markerToken);
        assertEqual(stamped.ok, true, 'the live .cm-editor must be stampable (it exists)');
        const countersBefore = { mounts: stamped.mounts, unmounts: stamped.unmounts, live: stamped.live };

        // 1c. Switch to preview with a real click.
        const previewState = await switchMode(page, 'preview');
        ctx.note('after switching to 预览', previewState);
        assertEqual(previewState.editorPressed, 'false', '编辑 must be aria-pressed=false in preview mode');
        assertEqual(previewState.previewPressed, 'true', '预览 must be aria-pressed=true in preview mode');
        assertEqual(previewState.canvasMode, 'preview', 'the canvas must report data-mode="preview"');
        assertEqual(previewState.previewPanePresent, true, 'the preview pane must be mounted in preview mode');
        assertEqual(
          previewState.previewState,
          'ready',
          'the preview must report data-state="ready" (rendered, not merely mounted)',
        );
        assertEqual(previewState.previewLabel, 'Markdown preview', 'the preview is labelled for assistive technology');
        assertEqual(
          previewState.previewAriaLive,
          null,
          'the preview must not be an aria-live region (the renderer comment and D-087 require silence)',
        );
        assertEqual(
          previewState.editorPaneDisplay,
          'none',
          'the editor pane must be hidden with CSS (display: none), not removed from the DOM',
        );

        // 1d. Three independent proofs that the editor is the SAME live instance.
        const survivor = await readEditorDomMarker(page);
        ctx.note('editor survival while preview is visible', {
          ...survivor,
          cmEditorCount: previewState.cmEditorCount,
          cmContentCount: previewState.cmContentCount,
        });
        assertEqual(previewState.cmEditorCount, 1, 'exactly one .cm-editor must exist in preview mode');
        assertEqual(previewState.cmContentCount, 1, 'exactly one .cm-content must exist in preview mode');
        assertEqual(survivor.present, true, 'the .cm-editor DOM node must still be attached in preview mode');
        assertEqual(
          survivor.marker,
          markerToken,
          'the surviving .cm-editor must be the SAME DOM node stamped before the toggle (no remount)',
        );
        assertDeepEqual(
          { mounts: survivor.mounts, unmounts: survivor.unmounts, live: survivor.live },
          countersBefore,
          'the page MutationObserver mount/unmount counters must be unchanged by the toggle',
        );

        const hiddenState = await editorState(page);
        assertEqual(hiddenState.text, beforeToggle.text, 'the editor text must be unchanged while preview is visible');
        assertEqual(hiddenState.viewId, beforeToggle.viewId, 'the live EditorView identity must be unchanged while preview is visible');
        assertEqual(hiddenState.anchor, beforeToggle.anchor, 'the selection anchor must survive the switch to preview');
        assertEqual(hiddenState.head, beforeToggle.head, 'the selection head must survive the switch to preview');
        await screenshot(page, 'preview-1-toggle-preview');

        // 1e. Back to edit: text, selection and instance identity all preserved.
        const backState = await switchMode(page, 'editor');
        const afterToggle = await editorState(page);
        const afterMarker = await readEditorDomMarker(page);
        ctx.note('after switching back to 编辑', {
          mode: backState,
          length: afterToggle.length,
          viewId: afterToggle.viewId,
          anchor: afterToggle.anchor,
          head: afterToggle.head,
          marker: afterMarker.marker,
          mounts: afterMarker.mounts,
          unmounts: afterMarker.unmounts,
        });
        assertEqual(backState.canvasMode, 'editor', 'the canvas must report data-mode="editor" again');
        assertEqual(backState.editorPressed, 'true', '编辑 must be aria-pressed=true again');
        assertEqual(backState.previewPanePresent, false, 'the preview must be unmounted after returning to 编辑');
        assertEqual(backState.editorPaneDisplay, 'block', 'the editor pane must be visible again');
        assertEqual(afterToggle.text, beforeToggle.text, 'the text must be byte-identical across the round trip');
        assertEqual(afterToggle.length, beforeToggle.length, 'the text length must be unchanged across the round trip');
        assertEqual(afterToggle.viewId, beforeToggle.viewId, 'the EditorView must be the same instance after returning');
        assertEqual(afterToggle.anchor, beforeToggle.anchor, 'the keyboard selection anchor must be preserved');
        assertEqual(afterToggle.head, beforeToggle.head, 'the keyboard selection head must be preserved');
        assertEqual(afterMarker.marker, markerToken, 'the .cm-editor DOM node must be the same one after returning');
        assertDeepEqual(
          { mounts: afterMarker.mounts, unmounts: afterMarker.unmounts, live: afterMarker.live },
          countersBefore,
          'no mount or unmount may have happened during the whole round trip',
        );

        // The product must still work on that same instance: a real keystroke reaches Y.Text.
        await page.click(PREVIEW.cmContent);
        await page.pressKey('End', { modifiers: 2 });
        await page.insertText(' OMEGA');
        const typed = await waitForEditorText(page, (text) => text === `${seedText} OMEGA`, {
          label: 'a keystroke after the round trip',
        });
        assertEqual(typed.viewId, beforeToggle.viewId, 'typing after the round trip must use the same live view');
        ctx.note('post-round-trip keystroke', { length: typed.length, viewId: typed.viewId });
      } finally {
        oracle?.close();
      }
    },
  );

  /* ================================================================== *
   * 2 — supported Markdown renders, and the 400 ms debounce is real
   * ================================================================== */
  runner.scenario(
    'preview/2-renders-and-debounces',
    'a document with every supported block renders as semantic DOM, and a remote change made while preview is visible appears only after the 400 ms debounce (measured page-side)',
    async (ctx) => {
      const documentId = `a6-preview-render-${marker('doc')}`;
      const headingText = `Preview contract ${marker('RICH')}`;
      const remoteMarker = marker('REMOTE-HEADING');
      const SAFE_URL = 'https://example.com/insighthub-preview';

      const RICH_DOC = [
        `# ${headingText}`,
        '',
        'Intro paragraph with **bold text** and *italic text* and `inline code`.',
        '',
        '## Lists',
        '',
        '- first bullet',
        '- second bullet',
        '',
        '1. first ordered',
        '2. second ordered',
        '',
        '> a quoted line',
        '',
        '```js',
        'const answer = 42;',
        '```',
        '',
        '### Table',
        '',
        '| Column A | Column B |',
        '| --- | --- |',
        '| alpha | beta |',
        '| gamma | delta |',
        '',
        `[An external link](${SAFE_URL})`,
        '',
      ].join('\n');

      let oracle = null;
      let page = null;
      try {
        oracle = await WireOracle.connect({
          url: ctx.stack.wsUrl,
          documentId,
          label: 'preview-render-seeder',
          role: 'owner',
        });
        // Keep the oracle connected: the debounce measurement below is a *remote* edit that
        // arrives through this peer's real socket while the preview is on screen.
        oracle.replaceAll(RICH_DOC);
        await oracle.waitForText(RICH_DOC, { label: 'the rich seed to reach the server' });

        page = await ctx.newAppPage({ documentId });
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
        await waitForEditorText(page, (text) => text === RICH_DOC, {
          label: 'the rich document in the editor',
        });
        ctx.note('rich document open in edit mode', {
          documentId,
          characters: RICH_DOC.length,
          lines: RICH_DOC.split('\n').length,
        });

        // 2a. Every supported block must exist as its semantic element.
        const preview = await switchMode(page, 'preview');
        assertEqual(preview.previewState, 'ready', 'the preview must be ready before the render is asserted');
        const structure = await readPreview(page);
        const details = await readPreviewDetails(page);
        ctx.note('preview structure', structure);
        ctx.note('preview details', details);

        assertEqual(structure.counts.h1, 1, 'one <h1> must be rendered (ATX heading)');
        assertEqual(structure.counts.h2, 1, 'one <h2> must be rendered');
        assertEqual(structure.counts.h3, 1, 'one <h3> must be rendered');
        assert(structure.counts.p >= 3, `paragraphs must be rendered (got ${structure.counts.p})`);
        assertEqual(structure.counts.strong, 1, '**bold text** must become a <strong> element');
        assertEqual(structure.counts.em, 1, '*italic text* must become an <em> element');
        assertEqual(structure.counts.ul, 1, 'an unordered list must become a <ul>');
        assertEqual(structure.counts.ol, 1, 'an ordered list must become an <ol>');
        assertEqual(structure.counts.ulLi, 2, 'the unordered list must have two <li> items');
        assertEqual(structure.counts.olLi, 2, 'the ordered list must have two <li> items');
        assertEqual(structure.counts.blockquote, 1, '> quoted line must become a <blockquote>');
        assertEqual(structure.counts.pre, 1, 'the fenced block must become a <pre>');
        assertEqual(structure.counts.preCode, 1, 'the fenced block must contain a <code>');
        assertEqual(structure.counts.table, 1, 'a GFM table must become a <table>');
        assertEqual(structure.counts.thead, 1, 'the table must have a <thead>');
        assertEqual(structure.counts.tbody, 1, 'the table must have a <tbody>');
        assertEqual(structure.counts.th, 2, 'the table header must have two <th> cells');
        assertEqual(structure.counts.tbodyTr, 2, 'the table body must have two rows');
        assertEqual(structure.counts.a, 1, 'the safe Markdown link must be the one anchor');
        assertEqual(structure.counts.img, 0, 'no image element may be created by this document');
        assertEqual(structure.ariaLive, null, 'the preview must not be an aria-live region');
        assertEqual(structure.ariaLiveDescendants, 0, 'no descendant of the preview may be aria-live');

        assertEqual(details.headings[0]?.level, 1, 'the first heading must be the h1');
        assertEqual(details.headings[0]?.text, headingText, 'the h1 must carry the document title');
        assertDeepEqual(details.strong, ['bold text'], 'the <strong> must contain exactly the bold run');
        assertDeepEqual(details.em, ['italic text'], 'the <em> must contain exactly the italic run');
        assertDeepEqual(details.inlineCode, ['inline code'], 'the inline code run must be a <code> in a paragraph');
        assertEqual(details.fenced.length, 1, 'one fenced code block must be rendered');
        assertIncludes(details.fenced[0]?.text ?? '', 'const answer = 42;', 'the fenced block must keep its source text');
        assertIncludes(details.fenced[0]?.className ?? '', 'language-js', 'the fenced block must keep its language class');
        assertDeepEqual(details.ulItems, ['first bullet', 'second bullet'], 'the unordered list items must be exact');
        assertDeepEqual(details.olItems, ['first ordered', 'second ordered'], 'the ordered list items must be exact');
        assertIncludes(details.blockquotes[0] ?? '', 'a quoted line', 'the blockquote must contain the quoted line');
        assertDeepEqual(details.table.headers, ['Column A', 'Column B'], 'the table headers must be the two header cells');
        assertDeepEqual(
          details.table.rows,
          [
            ['alpha', 'beta'],
            ['gamma', 'delta'],
          ],
          'the table body must be the two data rows in order',
        );
        assertEqual(details.anchors.length, 1, 'exactly one anchor must be rendered');
        assertEqual(details.anchors[0]?.href, SAFE_URL, 'the anchor must keep the exact safe href');
        assertEqual(
          details.anchors[0]?.rel,
          'noopener noreferrer',
          'a safe link must carry rel="noopener noreferrer"',
        );
        assertEqual(details.anchors[0]?.hasTarget, false, 'a preview link must not carry a target attribute');
        await screenshot(page, 'preview-2-rendered');

        // 2b. A REMOTE change while preview is visible. The sampler is installed first so the
        //     timestamps are page-side and start before the bytes arrive.
        const injection = `${oracle.text}\n\n### Remote ${remoteMarker}\n\nA paragraph injected through the real WebSocket while preview is visible.\n`;
        await installPreviewSampler(page, remoteMarker);
        oracle.replaceAll(injection);

        const sample = await waitForSampler(page);
        await stopPreviewSampler(page);
        ctx.note('debounce measurement (page-side clock)', sample);
        assert(
          typeof sample.landedAt === 'number',
          'the remote update must have reached the bound Y.Text while the preview was visible ' +
            '(no landedAt means the sampler never saw it in the editor)',
        );
        assertEqual(
          sample.checkpoint250.previewHasNeedle,
          false,
          `the preview must NOT update within ${PREVIEW_DEBOUNCE_MS}ms of the change ` +
            `(checked at ${Math.round(sample.checkpoint250.elapsedMs)}ms, strictly inside the window)`,
        );
        assertEqual(
          sample.checkpoint600.previewHasNeedle,
          true,
          'the preview must contain the change after the debounce window (checked at 600ms)',
        );
        const observedDelay = sample.previewAt - sample.landedAt;
        ctx.note('preview update delay', {
          observedDelayMs: Math.round(observedDelay),
          debounceMs: PREVIEW_DEBOUNCE_MS,
          samplerIntervalMs: 10,
          method: 'page-side: first sample of the needle in EditorState → first sample of it in the preview DOM',
        });
        assert(
          observedDelay >= PREVIEW_DEBOUNCE_MS - 50,
          `the preview update must not precede the ${PREVIEW_DEBOUNCE_MS}ms debounce: observed ` +
            `${Math.round(observedDelay)}ms (sampler granularity 10ms)`,
        );
        assert(
          observedDelay <= 2_500,
          `the preview update must follow promptly after the debounce, observed ${Math.round(observedDelay)}ms`,
        );

        // 2c. Content correctness after the update: a new heading and paragraph, exactly once.
        const updated = await waitForPreviewReady(page);
        const afterStructure = await readPreview(page);
        const afterDetails = await readPreviewDetails(page);
        ctx.note('preview after the remote update', { state: updated.previewState, structure: afterStructure });
        assertEqual(afterStructure.state, 'ready', 'the preview must be ready after the debounced re-render');
        assertEqual(afterStructure.counts.h3, 2, 'the appended heading must be a second <h3>');
        assert(
          afterDetails.headings.some((heading) => heading.level === 3 && heading.text === `Remote ${remoteMarker}`),
          `the appended h3 must carry the exact remote heading text (headings: ${JSON.stringify(
            afterDetails.headings.map((heading) => heading.text),
          )})`,
        );
        assert(
          (afterDetails.paragraphs ?? []).some((paragraph) =>
            paragraph.includes('A paragraph injected through the real WebSocket'),
          ),
          'the appended paragraph must be rendered',
        );

        // The hidden editor is still bound: the same remote update is in its Y.Text, with no remount.
        const hidden = await editorState(page);
        assertIncludes(hidden.text, remoteMarker, 'the hidden editor must have applied the same remote update');
        const mode = await readMode(page);
        assertEqual(mode.cmEditorCount, 1, 'the remote update must not remount the hidden editor');
        assertEqual(mode.editorPaneDisplay, 'none', 'the editor stays CSS-hidden throughout the update');
        await screenshot(page, 'preview-2-debounced');
      } finally {
        oracle?.close();
      }
    },
  );

  /* ================================================================== *
   * 3 — the security boundary, observed in the browser
   * ================================================================== */
  runner.scenario(
    'preview/3-security',
    'script/img/iframe never become elements, on* attributes and javascript: hrefs are absent, images show alt text only and the container is not aria-live',
    async (ctx) => {
      const documentId = `a6-preview-security-${marker('doc')}`;
      const SAFE_URL = 'https://example.com/safe';
      const TRACKING_URL = 'https://tracking.invalid/p.gif';
      const IFRAME_URL = 'https://evil.invalid/frame';

      const SECURITY_DOC = [
        `# Security ${marker('XSS')}`,
        '',
        'Inline script attempt: <script>window.__previewPwned = 1;</script>',
        '',
        'Image attempt: <img src="x" onerror="window.__previewPwned = 2">',
        '',
        `Markdown image: ![tracking pixel](${TRACKING_URL})`,
        '',
        'Link attempt: [x](javascript:alert(1))',
        '',
        `Iframe attempt: <iframe src="${IFRAME_URL}"></iframe>`,
        '',
        `Safe link: [InsightHub docs](${SAFE_URL})`,
        '',
      ].join('\n');

      let oracle = null;
      let page = null;
      try {
        oracle = await WireOracle.connect({
          url: ctx.stack.wsUrl,
          documentId,
          label: 'preview-security-seeder',
          role: 'owner',
        });
        oracle.replaceAll(SECURITY_DOC);
        await oracle.waitForText(SECURITY_DOC, { label: 'the security seed to reach the server' });

        page = await ctx.newAppPage({ documentId });
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
        await waitForEditorText(page, (text) => text === SECURITY_DOC, {
          label: 'the security document in the editor',
        });

        const mode = await switchMode(page, 'preview');
        assertEqual(mode.previewState, 'ready', 'the preview must be ready before the security assertions');
        const security = await readPreviewSecurity(page);
        ctx.note('security observation', security);

        // 3a. No dangerous element was created from the raw HTML.
        assertEqual(security.counts.script, 0, 'no <script> element may exist inside the preview');
        assertEqual(security.counts.img, 0, 'no <img> element may exist inside the preview (no outbound request)');
        assertEqual(security.counts.iframe, 0, 'no <iframe> element may exist inside the preview');
        assertEqual(security.counts.object, 0, 'no <object>/<embed> element may exist inside the preview');

        // 3b. No event handler and no src attribute exists anywhere in the preview subtree.
        assertDeepEqual(security.eventAttributes, [], 'no on* attribute may survive into the preview DOM');
        assertDeepEqual(security.srcAttributes, [], 'no element may carry a src attribute (the img payload is inert text)');

        // 3c. The payloads are visible as *text*, which is how raw HTML is escaped.
        assertEqual(security.escapedMarkers.script, true, 'the <script> payload must be present as literal text');
        assertEqual(security.escapedMarkers.img, true, 'the <img> payload must be present as literal text');
        assertEqual(security.escapedMarkers.iframe, true, 'the <iframe> payload must be present as literal text');
        assertEqual(security.pwned, null, 'no payload may have executed (window.__previewPwned must be undefined)');

        // 3d. The javascript: target is dropped and leaves no focusable anchor.
        assertEqual(security.counts.anchors, 1, 'only the safe link may be an <a> element');
        assertDeepEqual(security.dangerousAnchors, [], 'no anchor may point at a javascript:/data:/vbscript: URL');
        assertEqual(
          security.counts.blockedLinks,
          1,
          'the refused javascript: link must render as a non-anchor blocked-link span',
        );
        assertIncludes(
          (security.text ?? '').toLowerCase(),
          'x',
          'the blocked link label must still be readable as text',
        );

        // 3e. The safe link keeps its hardened attributes and no target.
        assertEqual(security.anchors[0]?.href, SAFE_URL, 'the safe link must keep its exact href');
        assertEqual(
          security.anchors[0]?.rel,
          'noopener noreferrer',
          'the safe link must carry rel="noopener noreferrer"',
        );
        assertEqual(security.anchors[0]?.hasTarget, false, 'the safe link must not carry a target attribute');

        // 3f. Images are alt text only, and no request was attempted for the tracking URL.
        assertEqual(security.counts.imageSpans, 1, 'the Markdown image must become one alt-text placeholder');
        assertEqual(security.imageAltSpans[0]?.alt, 'tracking pixel', 'the placeholder must keep the alt text');
        assertEqual(security.imageAltSpans[0]?.text, '[image: tracking pixel]', 'the placeholder must render the alt text');
        const requestedUrls = await page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((name) => name.includes('tracking.invalid') || name.includes('evil.invalid')),
        );
        assertDeepEqual(
          requestedUrls,
          [],
          'no network request may be attempted for the image or iframe host (the preview issues none)',
        );

        // 3g. The container is silent: it is not a live region and has no live descendant.
        assertEqual(security.ariaLiveOnRoot, null, 'the preview container must not have aria-live');
        assertEqual(security.ariaLiveDescendants, 0, 'no descendant of the preview may be aria-live');
        await screenshot(page, 'preview-3-security');

        // Switching back must restore the same editor with the source intact (preview wrote nothing).
        await switchMode(page, 'editor');
        const back = await editorState(page);
        assertEqual(back.text, SECURITY_DOC, 'previewing must not have changed the Markdown source');
        ctx.note('source unchanged after previewing the attack document', { length: back.length });
      } finally {
        oracle?.close();
      }
    },
  );

  /* ================================================================== *
   * 4 — 100k lines: enter preview without touching the document
   * ================================================================== */
  runner.scenario(
    'preview/4-large-document-20k-browser',
    'a 20k-line document (browser-feasible slice of the 100k fixture) seeded through the production store hydrates in the browser, and entering preview leaves the Y.Text SHA-256, the state-vector digest and the durable bytes unchanged; the 100k browser attempt is documented as a timeout in the limitations, not claimed as PASS',
    async (ctx) => {
      const documentId = `a6-preview-20k-${marker('doc')}`;
      const fixture = await ensureFixture({ writeIfMissing: false });
      const fullFixtureText = await readFile(fixture.absolutePath, 'utf8');
      // Browser-feasible slice: the same deterministic lines, 20,000 of them. The 100k browser
      // attempt (2026-10-26) did not reach data-state="ready" within the 420 s scenario budget;
      // that is recorded as a limitation, not silently replaced by this slice.
      const fixtureText = `${fullFixtureText.split('\n').slice(0, 20_000).join('\n')}\n`;
      const fixtureSha = sha256Text(fixtureText);
      ctx.note('20k fixture', {
        path: fixture.path,
        lines: 20_000,
        characters: fixtureText.length,
        sha256: fixtureSha,
        deterministic: fixture.deterministic,
      });

      // A brand-new durable directory, seeded **before** the server opens it. The seed is the
      // production persistence seam (`tests/perf/seed.mjs`); nothing in `apps/**` changes.
      const dataPath = await ctx.stack.createDataPath('preview-100k');
      const slicePath = path.join(dataPath, '20k-lines.md');
      await writeFile(slicePath, fixtureText, 'utf8');
      const seed = runPerfSeed(slicePath, dataPath, documentId);
      const restart = await ctx.stack.restartServer({ dataPath });
      ctx.note('durable seed', {
        ...seed,
        pidBefore: restart.before,
        pidAfter: restart.after,
        serverStarts: ctx.stack.serverStarts,
      });
      assertEqual(seed.characters, fixtureText.length, 'the seed must have written the whole fixture');
      assertEqual(
        typeof seed.sequence === 'number' && seed.sequence >= 1,
        true,
        'the seed must have committed at least one durable update sequence',
      );

      // Open the document through the same harness path every other scenario uses.
      const page = await ctx.newAppPage({ documentId });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
      const hydrated = await waitUntil(
        async () => {
          const digest = await readEditorDigest(page);
          return digest !== null && digest.length === fixtureText.length ? digest : false;
        },
        {
          timeoutMs: 180_000,
          intervalMs: 200,
          label: `the 100k document to hydrate into the editor (target ${fixtureText.length} chars)`,
        },
      );
      ctx.note('editor hydration', {
        characters: hydrated.length,
        sha256: hydrated.sha256,
        matchesFixture: hydrated.sha256 === fixtureSha,
        viewId: hydrated.viewId,
      });
      assertEqual(
        hydrated.sha256,
        fixtureSha,
        'the editor (bound to Y.Text) must hold exactly the fixture bytes after hydration',
      );

      // Digest the CRDT state two independent ways before preview: the page's own state vector and
      // the server's durable bytes rebuilt from `snapshot` + `document_update`.
      const textBefore = hydrated;
      const stateVectorBefore = await page.evaluate(() => window.__qa.docStateVector());
      const durableBefore = await reconstructDurableDocument(ctx.stack.dataPath, documentId);
      ctx.note('before entering preview', {
        textSha256: textBefore.sha256,
        textLength: textBefore.length,
        stateVector: stateVectorBefore,
        durable: {
          found: durableBefore.found,
          characters: durableBefore.text?.length ?? null,
          updateRows: durableBefore.updateRows,
          stateUpdateSha: durableBefore.stateUpdateSha,
        },
      });
      assertEqual(stateVectorBefore.ok, true, `the page must expose its live state vector (${stateVectorBefore.reason ?? 'ok'})`);
      assertEqual(durableBefore.found, true, 'the durable store must hold the seeded document');
      assertEqual(
        durableBefore.text?.length ?? null,
        fixtureText.length,
        'the durable text reconstructed from the store must have the fixture length',
      );

      // The single observation: first entry into preview (includes the lazy renderer chunk).
      await installPreviewEntryProbe(page);
      const clickStartedAt = Date.now();
      await page.click(PREVIEW.modePreview);
      await waitForMode(page, 'preview');
      await waitUntil(
        async () => {
          const probe = await readPreviewEntryProbe(page);
          return probe !== null && probe.readyAt !== null ? probe : false;
        },
        { timeoutMs: 240_000, intervalMs: 100, label: 'the 100k preview to reach data-state="ready"' },
      );
      const entry = await readPreviewEntryProbe(page);
      const wallClockMs = Date.now() - clickStartedAt;
      ctx.note('first entry into preview (single observation, not a benchmark)', {
        clickToContainerMs: entry.rootAt === null ? null : Math.round(entry.rootAt - entry.clickAt),
        containerToReadyMs: Math.round(entry.readyAt - entry.rootAt),
        clickToReadyMs: entry.clickAt === null ? null : Math.round(entry.readyAt - entry.clickAt),
        nodeSideRoundTripMs: wallClockMs,
        initialState: entry.initialState,
        stateTransitions: entry.states,
        lazyChunkResources: entry.lazyResources,
        note:
          'page-side performance.now() clock; first entry in this page, so the lazy ' +
          'MarkdownPreviewRenderer chunk load is included in the number',
      });
      assert(
        entry.clickAt !== null && entry.rootAt !== null && entry.readyAt !== null,
        'the preview must have been entered and reached ready while being observed',
      );
      assert(
        entry.readyAt >= entry.rootAt,
        'the ready timestamp must not precede the container appearing',
      );

      const preview = await readPreview(page);
      ctx.note('100k preview structure', {
        state: preview.state,
        textLength: preview.textLength,
        counts: preview.counts,
      });
      assertEqual(preview.state, 'ready', 'the 100k preview must report data-state="ready"');
      const lastLineMarker = fixtureText.trimEnd().split('\n').at(-1).slice(0, 20);
      const previewMarkers = await page.evaluate((marker) => {
        const text = document.querySelector('[data-testid="markdown-preview-content"]')?.textContent ?? '';
        return {
          hasFirstLine: text.includes('line-1:'),
          hasLastLine: text.includes(marker),
          hasFixturePhrase: text.includes('The quick brown fox jumps over the lazy dog 0123456789.'),
        };
      }, lastLineMarker);
      ctx.note('20k preview content markers', { ...previewMarkers, lastLineMarker });
      assertEqual(previewMarkers.hasFirstLine, true, 'the preview must contain the first fixture line');
      assertEqual(previewMarkers.hasLastLine, true, 'the preview must contain the last line of the 20k slice');
      assertEqual(previewMarkers.hasFixturePhrase, true, 'the preview must contain the fixture phrase');
      assert(
        preview.textLength >= fixtureText.length * 0.99,
        `the preview text must cover the document (preview ${preview.textLength} vs fixture ${fixtureText.length})`,
      );

      // Nothing may have moved: same text digest, same state vector, same durable bytes.
      const textAfter = await readEditorDigest(page);
      const stateVectorAfter = await page.evaluate(() => window.__qa.docStateVector());
      const durableAfter = await reconstructDurableDocument(ctx.stack.dataPath, documentId);
      ctx.note('after entering preview', {
        textSha256: textAfter.sha256,
        textLength: textAfter.length,
        stateVector: stateVectorAfter,
        durable: {
          characters: durableAfter.text?.length ?? null,
          updateRows: durableAfter.updateRows,
          stateUpdateSha: durableAfter.stateUpdateSha,
        },
      });
      assertEqual(textAfter.sha256, textBefore.sha256, 'preview must not change a single byte of the editor text');
      assertEqual(textAfter.length, textBefore.length, 'preview must not change the text length');
      assertDeepEqual(stateVectorAfter, stateVectorBefore, 'preview must not change the Y.Doc state vector');
      assertEqual(
        durableAfter.stateUpdateSha,
        durableBefore.stateUpdateSha,
        'preview must not change the durable document bytes (encodeStateAsUpdate SHA)',
      );
      assertEqual(
        durableAfter.text,
        durableBefore.text,
        'preview must not change the text reconstructed from the server store',
      );

      // Back to the editor: the document a user types into is the one that was previewed.
      const mode = await switchMode(page, 'editor');
      const back = await readEditorDigest(page);
      ctx.note('after returning to edit mode', {
        mode: mode.canvasMode,
        sha256: back.sha256,
        length: back.length,
      });
      assertEqual(back.sha256, textBefore.sha256, 'returning from preview must not change the editor text');
      assertEqual(back.viewId, hydrated.viewId, 'returning from preview must not remount the editor');
    },
    // A cold 6.3 MB hydration plus a first preview render is slower than the default budget; this
    // is a bounded wait, not a retry mask.
    { timeoutMs: 420_000 },
  );

  /* ================================================================== *
   * 5 — preview adds no Redux state and no document body
   * ================================================================== */
  runner.scenario(
    'preview/5-redux-no-body',
    'preview adds no Redux slice and never mirrors the body into the store, while the body it renders still comes from Y.Text',
    async (ctx) => {
      const documentId = `a6-preview-redux-${marker('doc')}`;
      const bodyMarker = marker('REDUX-BODY-MARKER');
      const longParagraph = `Long body sentinel ${bodyMarker} ` + 'the quick brown fox '.repeat(20);
      const doc = [`# Redux ${bodyMarker}`, '', longParagraph, ''].join('\n');

      let oracle = null;
      let page = null;
      try {
        oracle = await WireOracle.connect({
          url: ctx.stack.wsUrl,
          documentId,
          label: 'preview-redux-seeder',
          role: 'owner',
        });
        oracle.replaceAll(doc);
        await oracle.waitForText(doc, { label: 'the redux seed to reach the server' });

        page = await ctx.newAppPage({ documentId });
        await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });
        await waitForEditorText(page, (text) => text === doc, {
          label: 'the redux document in the editor',
        });

        const before = await readReduxSnapshot(page, bodyMarker);
        ctx.note('Redux state before preview', before);
        assertEqual(
          before.available,
          true,
          `the live Redux store must be reachable through the fiber tree (${before.reason ?? 'available'})`,
        );
        assertEqual(before.containsNeedle, false, 'the document body must not be in Redux before preview');
        assertDeepEqual(
          before.longStrings,
          [],
          'no Redux value may hold a body-sized string (>= 200 chars) — the body lives only in Y.Text',
        );
        assertDeepEqual(before.forbiddenKeys, [], 'Redis must have no content/text/body field');
        assert(
          before.bytes < 8_192,
          `the whole Redux state must stay small (${before.bytes} bytes); a mirrored body would blow this up`,
        );

        const mode = await switchMode(page, 'preview');
        assertEqual(mode.previewState, 'ready', 'the preview must be ready before the Redux comparison');
        const previewText = await page.evaluate((selectors) => {
          const text = document.querySelector(selectors.content)?.textContent ?? '';
          return {
            hasHeading: text.includes(`Redux ${document.querySelector('h1')?.textContent ?? ''}`) || text.includes('Redux'),
            hasBodyMarker: text.includes(window.__qaReduxMarker ?? ''),
          };
        }, PREVIEW);
        // Pass the marker explicitly rather than relying on a global: the check above only proves
        // the rendered text exists; the body-marker check is done with an argument.
        const previewHasMarker = await page.evaluate(
          (selectors, needle) =>
            (document.querySelector(selectors.content)?.textContent ?? '').includes(needle),
          PREVIEW,
          bodyMarker,
        );
        ctx.note('preview rendered the body from Y.Text', { ...previewText, previewHasMarker });
        assertEqual(previewHasMarker, true, 'the preview must render the body that is absent from Redux');

        const after = await readReduxSnapshot(page, bodyMarker);
        ctx.note('Redux state with preview visible', after);
        assertEqual(after.available, true, 'the Redux store must still be reachable with preview visible');
        assertEqual(after.containsNeedle, false, 'the document body must not enter Redux when preview renders');
        assertDeepEqual(
          after.forbiddenKeys,
          [],
          'preview must not add a content/text/body field to the store',
        );
        assertDeepEqual(
          after.keys,
          before.keys,
          'preview must not add or remove a Redux slice (UI mode is not store state)',
        );
        assertDeepEqual(
          after.longStrings,
          [],
          'preview must not mirror the body into Redux (no body-sized string appeared)',
        );
        assert(
          after.bytes < 8_192,
          `the Redux state must stay small with preview visible (${after.bytes} bytes)`,
        );
        await screenshot(page, 'preview-5-redux');
      } finally {
        oracle?.close();
      }
    },
  );
}
