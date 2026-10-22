/**
 * M3 Design Fidelity Gate — the computed-style properties A2's CSS promises.
 *
 * The 60 scenarios before this file prove **behaviour**: no functional regression while A2
 * restyled the shell. They do not prove that the hover lift, focus ring, pressed scale,
 * tooltip reveal, live-dot pulse or reduced-motion fallback exist. A screenshot can show
 * them for one instant but cannot be re-run, diffed, or made to fail when a future CSS edit
 * deletes a transition.
 *
 * This suite turns the observable half of the design brief into permanent Chromium
 * assertions. Every value is read with `getComputedStyle` from the **live application**
 * (real Vite build, real backend, real session, real mouse/Tab input). Pseudo-elements
 * (the two logo dots) are read with `getComputedStyle(element, '::before' | '::after')`.
 *
 * ## What this file deliberately does not claim
 *
 * Computed style is the final value the renderer uses, not the pixels on screen. These
 * scenarios therefore do **not** cover:
 *
 * - intermediate animation frames (the 0.2 s transition curve, easing "feel", frame rate);
 * - sub-pixel anti-aliasing, perceived contrast, optical alignment or screenshot diffs;
 * - `box-shadow` blur beyond its declared geometry/alpha, or whether a shadow looks good;
 * - tooltip stacking against a *third* overlapping avatar at every possible x-offset;
 * - the live-dot pulse's visual expansion over time (only `animation-name` and its
 *   hover/no-hover/reduced-motion gating are asserted).
 *
 * Those remain human design-review items. Everything asserted here is falsifiable by a CSS
 * mutation, and two such mutations are recorded in the task report.
 *
 * ## Naming
 *
 * The ids are `ui/1-…` … `ui/8-…`, matching the eight acceptance claims in the A6 brief.
 * The suite is discovered by `run.mjs` (filename order), so adding this file takes the
 * total from 60 to 68 without touching `run.mjs` or any earlier scenario.
 */
import {
  SELECTORS,
  setOffline,
  sleep,
  typeInEditor,
  waitForConnectionStatus,
  waitForEditorText,
  waitUntil,
} from '../lib/app.mjs';
import { DEMO_USERS } from '../lib/authz-fixture.mjs';
import { assert, assertEqual, assertIncludes } from '../lib/harness.mjs';
import { WireOracle } from '../lib/oracle.mjs';
import { waitForRoleTag } from '../lib/role-gate.mjs';

/** The exact computed colours of `--accent` / `--accentSoft` in `styles.css`. */
const ACCENT = 'rgb(57, 119, 233)';
const ACCENT_SOFT = 'rgb(234, 242, 255)';

/** A per-run marker, so stale content can never satisfy an assertion. */
function marker(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/* -------------------------------------------------------------------- *
 * Computed-style primitives
 * -------------------------------------------------------------------- */

/**
 * Read a set of computed properties from one element (or one of its pseudo-elements).
 *
 * `querySelectorAll` + `index` lets a scenario target the *n*-th avatar without knowing its
 * client id, while `pseudo` reads the logo's CSS-only dots.
 */
async function styleOf(page, selector, properties, { index = 0, pseudo = null } = {}) {
  return page.evaluate(
    (sel, props, at, pseudoElement) => {
      const element = document.querySelectorAll(sel)[at];
      if (element === undefined) return null;
      const style = getComputedStyle(element, pseudoElement);
      const values = {};
      for (const property of props) values[property] = style.getPropertyValue(property);
      return values;
    },
    selector,
    properties,
    index,
    pseudo,
  );
}

/** Read one computed property, polling until `predicate` accepts it. */
async function waitForStyle(
  page,
  selector,
  property,
  predicate,
  { label, index = 0, pseudo = null, timeoutMs = 5_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const styles = await styleOf(page, selector, [property], { index, pseudo });
    last = styles === null ? null : styles[property];
    if (last !== null && predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${label ?? `${selector} ${property}`}: ` +
          `last computed value ${JSON.stringify(last)}`,
      );
    }
    await sleep(50);
  }
}

/** Parse a 2-D `matrix(...)` (or the 2-D part of `matrix3d(...)`) into named components. */
function matrixOf(value) {
  if (typeof value !== 'string' || value === 'none') return null;
  const twoD = value.match(/^matrix\(([^)]+)\)$/);
  if (twoD !== null) {
    const [a, b, c, d, tx, ty] = twoD[1].split(',').map((part) => Number(part.trim()));
    return Number.isFinite(a) ? { a, b, c, d, tx, ty } : null;
  }
  const threeD = value.match(/^matrix3d\(([^)]+)\)$/);
  if (threeD !== null) {
    const values = threeD[1].split(',').map((part) => Number(part.trim()));
    return {
      a: values[0],
      b: values[1],
      c: values[4],
      d: values[5],
      tx: values[12],
      ty: values[13],
    };
  }
  return null;
}

function approx(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

function assertApprox(actual, expected, tolerance, what) {
  assert(
    Number.isFinite(actual) && approx(actual, expected, tolerance),
    `${what}: expected ~${expected} (±${tolerance}), got ${actual}`,
  );
}

/** True when two matrices are the same within a sub-pixel tolerance. */
function sameMatrix(left, right, tolerance = 0.001) {
  return ['a', 'b', 'c', 'd', 'tx', 'ty'].every((key) => approx(left[key], right[key], tolerance));
}

/**
 * Wait until `transform` both satisfies `predicate` **and has stopped changing**.
 *
 * A 0.18–0.22 s transition passes through every intermediate matrix; accepting the first
 * value inside a ±0.02 tolerance would record a mid-transition sample and would pass for a
 * target that differs from the design by up to 2 %. Requiring two identical consecutive
 * samples proves the transition has settled before the evidence value is read.
 */
async function waitForMatrix(
  page,
  selector,
  predicate,
  { label, index = 0, pseudo = null, timeoutMs = 5_000, stableMs = 100 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let previousAt = 0;
  let last = null;
  for (;;) {
    const styles = await styleOf(page, selector, ['transform'], { index, pseudo });
    last = styles === null ? null : styles.transform;
    const matrix = matrixOf(last);
    if (matrix !== null && predicate(matrix)) {
      if (previous !== null && sameMatrix(previous, matrix)) {
        if (Date.now() - previousAt >= stableMs) return { value: last, matrix };
      } else {
        previous = matrix;
        previousAt = Date.now();
      }
    } else {
      previous = null;
      previousAt = 0;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${label ?? `${selector} transform`}: ` +
          `last computed value ${JSON.stringify(last)}`,
      );
    }
    await sleep(50);
  }
}

/** Poll one computed property until it equals `expected`. */
async function waitForExactStyle(
  page,
  selector,
  property,
  expected,
  { label, index = 0, pseudo = null, timeoutMs = 5_000 } = {},
) {
  return waitForStyle(page, selector, property, (value) => value === expected, {
    label: label ?? `${selector} ${property} === ${expected}`,
    index,
    pseudo,
    timeoutMs,
  });
}

/** `transition-duration` may be a comma-separated list; every entry must be exactly `0s`. */
function allDurationsZero(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return value
    .split(',')
    .map((part) => part.trim())
    .every((part) => part === '0s');
}

/** Alpha and blur radius of the first shadow in a computed `box-shadow` value. */
function shadowMetrics(value) {
  if (typeof value !== 'string' || value === 'none') return null;
  const color = value.match(/rgba?\(([^)]+)\)/);
  const channels = color === null ? [] : color[1].split(',').map((part) => Number(part.trim()));
  const lengths = [...value.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  return {
    alpha: channels.length === 4 ? channels[3] : 1,
    offsetX: lengths[0] ?? null,
    offsetY: lengths[1] ?? null,
    blur: lengths[2] ?? null,
    spread: lengths[3] ?? null,
  };
}

/* -------------------------------------------------------------------- *
 * Real input: mouse and Tab
 * -------------------------------------------------------------------- */

/** Move the real mouse to the centre of the `index`-th match. */
async function hover(page, selector, { index = 0 } = {}) {
  const centre = await page.evaluate(
    (sel, at) => {
      const element = document.querySelectorAll(sel)[at];
      if (element === undefined) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    selector,
    index,
  );
  if (centre === null) throw new Error(`no element matches ${selector}[${index}]`);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: centre.x,
    y: centre.y,
    button: 'none',
    clickCount: 0,
  });
  return centre;
}

/** Move the mouse off every interactive surface (bottom-left paper, not a control). */
async function moveMouseAway(page) {
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 4,
    y: 875,
    button: 'none',
    clickCount: 0,
  });
}

/** A real mouse-down that stays held, so `:active` can be observed while it lasts. */
async function mouseDownAt(page, selector) {
  const centre = await hover(page, selector);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: centre.x,
    y: centre.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  return centre;
}

/**
 * Release outside the pressed control.
 *
 * Releasing on the button would dispatch a real `click` and undo the edit. Moving the
 * pointer while the button is held keeps `:active` alive long enough to measure it, then
 * releases somewhere harmless — no activation.
 */
async function releaseOutside(page) {
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 4,
    y: 875,
    button: 'left',
    buttons: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: 4,
    y: 875,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

/**
 * Press Tab once, as a raw CDP key event.
 *
 * This is the same key event a keyboard produces (`rawKeyDown` + `keyUp`, with the native
 * virtual key code). It is deliberately not a synthetic `element.focus()`: the point of
 * `:focus-visible` is that the browser decides modality, and only a real Tab reaches it.
 */
async function pressTab(page) {
  const base = {
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  };
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * Focus `targetSelector` by walking the document's real Tab order from the document input.
 *
 * Clicking the input only establishes a known starting point; every step after it is a real
 * Tab key event. The returned `visited` list is evidence of what the browser actually focused,
 * so a timeout can distinguish "the target is missing" from "the target is not tabbable".
 */
async function focusByTab(
  page,
  targetSelector,
  { startSelector = SELECTORS.documentInput, maxTabs = 20 } = {},
) {
  await page.click(startSelector);
  await sleep(60);
  const started = await page.evaluate(
    (sel) => document.activeElement?.matches?.(sel) === true,
    startSelector,
  );
  if (!started) throw new Error(`clicking ${startSelector} did not focus it`);

  const visited = [];
  for (let tab = 1; tab <= maxTabs; tab += 1) {
    await pressTab(page);
    await sleep(60);
    const active = await page.evaluate((sel) => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) {
        return { matched: false, tag: null, ariaLabel: null, className: null, clientId: null };
      }
      return {
        matched: element.matches(sel),
        tag: element.tagName,
        ariaLabel: element.getAttribute('aria-label'),
        className: typeof element.className === 'string' ? element.className : '',
        clientId: element.getAttribute('data-client-id'),
      };
    }, targetSelector);
    visited.push({ tab, ...active });
    if (active.matched) return { tabs: tab, active, visited };
  }
  throw new Error(
    `Tab did not reach ${targetSelector} within ${maxTabs} presses; visited: ` +
      JSON.stringify(visited),
  );
}

/* -------------------------------------------------------------------- *
 * Page-specific observation helpers
 * -------------------------------------------------------------------- */

/** The rendered collaborator row whose tooltip text is exactly `name`. */
async function findCollaboratorByTip(page, name) {
  return page.evaluate((wanted) => {
    const rows = [...document.querySelectorAll('.collab')];
    const row = rows.find(
      (candidate) => (candidate.querySelector('.collab__tip')?.textContent ?? '').trim() === wanted,
    );
    if (row === undefined) {
      return {
        found: false,
        rows: rows.map((candidate) => ({
          clientId: candidate.getAttribute('data-client-id'),
          tip: (candidate.querySelector('.collab__tip')?.textContent ?? '').trim(),
        })),
      };
    }
    return {
      found: true,
      clientId: row.getAttribute('data-client-id'),
      tip: (row.querySelector('.collab__tip')?.textContent ?? '').trim(),
    };
  }, name);
}

/** Wait until the browser has rendered the oracle peer as a collaborator row. */
async function waitForCollaboratorByTip(page, name) {
  let last = null;
  await waitUntil(
    async () => {
      last = await findCollaboratorByTip(page, name);
      return last.found;
    },
    { label: `collaborator tooltip ${JSON.stringify(name)}`, timeoutMs: 20_000 },
  );
  return last;
}

/** Box + paint state of an element, used for "the tooltip/notice is really visible". */
async function readBox(page, selector) {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (element === null) return { present: false };
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      present: true,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  }, selector);
}

/** Visible text of the whole page (the "no false save/sync claim" check). */
async function pageText(page) {
  return page.evaluate(() =>
    (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim(),
  );
}

/** Turn `prefers-reduced-motion` on or off through the browser's own emulation domain. */
async function emulateReducedMotion(page, reduce) {
  await page.send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [
      {
        name: 'prefers-reduced-motion',
        value: reduce ? 'reduce' : 'no-preference',
      },
    ],
  });
  const wanted = reduce ? 'reduce' : 'no-preference';
  await waitUntil(
    async () =>
      await page.evaluate(
        (value) => matchMedia(`(prefers-reduced-motion: ${value})`).matches,
        wanted,
      ),
    { label: `prefers-reduced-motion: ${wanted}`, timeoutMs: 5_000 },
  );
}

/** A viewer document with the local identity in the viewer role. */
async function openViewerPage(ctx, documentId) {
  await ctx.authz.grant(documentId, DEMO_USERS.linus, 'viewer');
  const page = await ctx.newAppPage({
    documentId,
    as: DEMO_USERS.linus,
    role: 'viewer',
  });
  await waitForRoleTag(ctx, page, 'viewer', { label: 'the viewer role' });
  return page;
}

export function register(runner) {
  /* ================================================================== *
   * 1 — logo hover: rotate/scale and both dots drift; leave restores
   * ================================================================== */
  runner.scenario(
    'ui/1-logo-hover-transforms',
    'hovering the brand rotates/scales the logo and separates both dots; leaving returns the logo transform to none',
    async (ctx) => {
      const page = await ctx.newAppPage({ documentId: `a6-ui-logo-${marker('doc')}` });

      const supportsHover = await page.evaluate(
        () => matchMedia('(hover: hover) and (pointer: fine)').matches,
      );
      ctx.note('hover-capable fine pointer media query', supportsHover);
      assert(supportsHover, 'the run must have a hover-capable fine pointer (desktop Chromium)');

      const before = await styleOf(page, '.brand__logo', ['transform']);
      const dotBefore = await styleOf(page, '.brand__logo', ['transform'], { pseudo: '::before' });
      const dotAfter = await styleOf(page, '.brand__logo', ['transform'], { pseudo: '::after' });
      ctx.note('logo computed transform before hover', {
        logo: before?.transform,
        beforeDot: dotBefore?.transform,
        afterDot: dotAfter?.transform,
      });
      assertEqual(before?.transform, 'none', 'the logo must start un-transformed');
      assertEqual(dotBefore?.transform, 'none', 'the before-dot must start un-transformed');
      assertEqual(dotAfter?.transform, 'none', 'the after-dot must start un-transformed');

      await hover(page, '.brand__logo');
      const hovered = await waitForMatrix(
        page,
        '.brand__logo',
        (matrix) => approx(matrix.a, 1.0375, 0.02) && approx(matrix.b, -0.0725, 0.02),
        { label: 'logo rotate(-4deg) scale(1.04)' },
      );
      const dotA = await waitForMatrix(
        page,
        '.brand__logo',
        (matrix) => approx(matrix.tx, 2, 0.2) && approx(matrix.ty, -1, 0.2),
        { label: 'the before-dot translate(2px, -1px)', pseudo: '::before' },
      );
      const dotB = await waitForMatrix(
        page,
        '.brand__logo',
        (matrix) => approx(matrix.tx, -2, 0.2) && approx(matrix.ty, 2, 0.2),
        { label: 'the after-dot translate(-2px, 2px)', pseudo: '::after' },
      );

      ctx.note('logo computed transforms while hovered', {
        logo: hovered.value,
        matrix: hovered.matrix,
        beforeDot: dotA.value,
        afterDot: dotB.value,
      });
      assert(hovered.matrix !== null, 'the hovered logo transform must not be `none`');
      assertApprox(hovered.matrix.a, 1.0375, 0.02, 'logo matrix a (scale × cos 4°)');
      assertApprox(hovered.matrix.b, -0.0725, 0.02, 'logo matrix b (scale × −sin 4°)');
      assertApprox(hovered.matrix.d, 1.0375, 0.02, 'logo matrix d');
      assert(dotA.matrix !== null, 'the before-dot transform must not be `none` on hover');
      assert(dotB.matrix !== null, 'the after-dot transform must not be `none` on hover');

      await moveMouseAway(page);
      const restored = await waitForExactStyle(page, '.brand__logo', 'transform', 'none', {
        label: 'the logo to settle back to transform:none after mouse-out',
      });
      const restoredBeforeDot = await waitForExactStyle(page, '.brand__logo', 'transform', 'none', {
        label: 'the before-dot to settle back to transform:none',
        pseudo: '::before',
      });
      const restoredAfterDot = await waitForExactStyle(page, '.brand__logo', 'transform', 'none', {
        label: 'the after-dot to settle back to transform:none',
        pseudo: '::after',
      });
      ctx.note('logo computed transforms after mouse-out', {
        logo: restored,
        beforeDot: restoredBeforeDot,
        afterDot: restoredAfterDot,
      });
    },
  );

  /* ================================================================== *
   * 2 — document switcher focus ring: accent border, 3px ring, −1px lift
   * ================================================================== */
  runner.scenario(
    'ui/2-switcher-focus-ring',
    'focusing the real document input gives the switcher an accent border, a 3px accent box-shadow ring and a translateY(-1px) lift',
    async (ctx) => {
      const page = await ctx.newAppPage({ documentId: `a6-ui-switcher-${marker('doc')}` });

      // `newAppPage` switches the document and leaves the input focused, so first leave the
      // focus state to prove the ring is caused by focus rather than being the resting style.
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      });
      await moveMouseAway(page);
      await waitForExactStyle(page, '.switcher', 'transform', 'none', {
        label: 'the switcher to return to its unfocused position',
      });
      await waitForExactStyle(page, '.switcher', 'border-color', 'rgb(220, 228, 237)', {
        label: 'the switcher to return to its resting border',
      });
      const idle = await styleOf(page, '.switcher', ['border-color', 'box-shadow', 'transform']);
      ctx.note('switcher computed style before focus', idle);
      assertEqual(idle?.transform, 'none', 'the switcher must start un-lifted');
      assertEqual(idle?.['box-shadow'], 'none', 'the switcher must start without a ring');

      // A real mouse click on the real input, not `input.focus()`.
      await page.click(SELECTORS.documentInput);
      const focus = await page.evaluate((selector) => {
        const input = document.querySelector(selector);
        if (!(input instanceof HTMLInputElement)) {
          return { found: false };
        }
        return {
          found: true,
          activeIsInput: document.activeElement === input,
          tag: document.activeElement?.tagName ?? null,
          type: input.type,
          ariaLabel: input.getAttribute('aria-label'),
          value: input.value,
        };
      }, SELECTORS.documentInput);
      ctx.note('document input focus facts', focus);
      assert(focus.found, 'the document switcher must contain a real <input>');
      assertEqual(focus.activeIsInput, true, 'document.activeElement must be the real input');
      assertEqual(focus.tag, 'INPUT', 'the focused element must be an INPUT');
      assertEqual(focus.type, 'text', 'the switcher must be a real text input');
      assertEqual(focus.ariaLabel, 'Document id', 'the input keeps its accessible name');

      const focused = await waitForMatrix(
        page,
        '.switcher',
        (matrix) => approx(matrix.ty, -1, 0.05),
        { label: 'the switcher translateY(-1px) focus lift' },
      );
      const border = await waitForExactStyle(page, '.switcher', 'border-color', ACCENT, {
        label: 'the switcher accent border on focus',
      });
      const shadow = await waitForStyle(
        page,
        '.switcher',
        'box-shadow',
        (value) =>
          typeof value === 'string' && value.includes('3px') && value.includes('57, 119, 233'),
        { label: 'the switcher 3px accent focus ring' },
      );
      const after = await styleOf(page, '.switcher', ['border-color', 'box-shadow', 'transform']);
      ctx.note('switcher computed style while focused', after);
      ctx.note('focus ring evidence', {
        borderColor: border,
        boxShadow: shadow,
        transform: focused.value,
        matrix: focused.matrix,
      });

      assertIncludes(shadow, '3px', 'the focus ring must be 3px thick');
      assertIncludes(shadow, '57, 119, 233', 'the focus ring must use the accent colour');
      assert(focused.matrix !== null, 'the focused switcher transform must not be `none`');
      assertApprox(focused.matrix.ty, -1, 0.05, 'switcher focus translateY');
      assertEqual(
        await page.evaluate(
          (selector) => document.activeElement === document.querySelector(selector),
          SELECTORS.documentInput,
        ),
        true,
        'after the style assertions, focus must still be on the real input',
      );
    },
  );

  /* ================================================================== *
   * 3 — avatar hover + tooltip, and keyboard focus + tooltip
   * ================================================================== */
  runner.scenario(
    'ui/3-avatar-hover-and-tooltip',
    'hovering a real collaborator avatar lifts it by 4px at scale 1.08 with z-index 4 and a shadow, reveals the real name tooltip, and real Tab focus also reveals it with a 2px accent outline',
    async (ctx) => {
      const documentId = `a6-ui-avatar-${marker('doc')}`;
      const peerName = `Fidelity Peer ${marker('name')}`;
      const page = await ctx.newAppPage({ documentId });

      const peer = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'design-fidelity-presence',
        userId: DEMO_USERS.grace,
        role: 'editor',
      });
      try {
        peer.enablePresence(
          { id: 'design-fidelity-peer', name: peerName, color: '#3366cc' },
          { cursor: { anchor: 0, head: 0 } },
        );
        const rendered = await waitForCollaboratorByTip(page, peerName);
        ctx.note('collaborator row found by exact tooltip text', rendered);
        assert(rendered.found, 'the oracle collaborator row must render');
        assertEqual(rendered.tip, peerName, 'the tooltip must contain the real collaborator name');
        const avatarSelector = `.collab[data-client-id="${rendered.clientId}"]`;
        const tipSelector = `${avatarSelector} .collab__tip`;

        const idleTip = await readBox(page, tipSelector);
        ctx.note('tooltip before hover', idleTip);
        assertEqual(idleTip.opacity, '0', 'the tooltip must start transparent');

        await hover(page, avatarSelector);
        const lifted = await waitForMatrix(
          page,
          avatarSelector,
          (matrix) =>
            approx(matrix.a, 1.08, 0.015) &&
            approx(matrix.d, 1.08, 0.015) &&
            approx(matrix.ty, -4, 0.2),
          { label: 'the avatar translateY(-4px) scale(1.08) hover' },
        );
        const hoverFacts = await styleOf(page, avatarSelector, ['z-index', 'box-shadow']);
        const tip = await waitForExactStyle(page, tipSelector, 'opacity', '1', {
          label: 'the tooltip opacity:1 on hover',
        });
        const tipBox = await readBox(page, tipSelector);
        ctx.note('avatar and tooltip while hovered', {
          transform: lifted.value,
          matrix: lifted.matrix,
          ...hoverFacts,
          tooltipOpacity: tip,
          tooltipBox: tipBox,
        });

        assert(lifted.matrix !== null, 'the hovered avatar transform must not be `none`');
        assertApprox(lifted.matrix.a, 1.08, 0.015, 'avatar hover scaleX');
        assertApprox(lifted.matrix.d, 1.08, 0.015, 'avatar hover scaleY');
        assertApprox(lifted.matrix.ty, -4, 0.2, 'avatar hover translateY');
        assertEqual(hoverFacts['z-index'], '4', 'the hovered avatar must be lifted to z-index 4');
        assert(hoverFacts['box-shadow'] !== 'none', 'the hovered avatar must cast a box-shadow');
        assertEqual(tip, '1', 'the tooltip must become opaque on hover');
        assert(tipBox.width > 0 && tipBox.height > 0, 'the tooltip must have a real box');
        assertEqual(tipBox.text, peerName, 'the tooltip must show the real collaborator name');

        await moveMouseAway(page);
        const awayTip = await waitForExactStyle(page, tipSelector, 'opacity', '0', {
          label: 'the tooltip opacity:0 after mouse-out',
        });
        ctx.note('tooltip after mouse-out', awayTip);

        const focus = await focusByTab(page, avatarSelector);
        ctx.note('real Tab focus reached the avatar', {
          tabs: focus.tabs,
          active: focus.active,
          visited: focus.visited,
        });
        const tipOnFocus = await waitForExactStyle(page, tipSelector, 'opacity', '1', {
          label: 'the tooltip opacity:1 while the avatar is keyboard-focused',
        });
        const outline = await styleOf(page, avatarSelector, [
          'outline-width',
          'outline-style',
          'outline-color',
          'outline-offset',
        ]);
        ctx.note('avatar while keyboard-focused', {
          activeElement: focus.active,
          tooltipOpacity: tipOnFocus,
          outline,
        });
        assertEqual(outline['outline-width'], '2px', 'keyboard focus must draw a 2px outline');
        assertEqual(outline['outline-style'], 'solid', 'the focus outline must be solid');
        assertEqual(
          outline['outline-color'],
          ACCENT,
          'the focus outline must use the accent colour',
        );
        assertEqual(outline['outline-offset'], '2px', 'the focus outline must be offset by 2px');

        await page.click(SELECTORS.documentInput);
        const blurredTip = await waitForExactStyle(page, tipSelector, 'opacity', '0', {
          label: 'the tooltip opacity:0 after focus leaves the avatar',
        });
        ctx.note('tooltip after focus leaves the avatar', blurredTip);
      } finally {
        peer.close();
      }
    },
  );

  /* ================================================================== *
   * 4 — undo: hover colours/icon, pressed scale, keyboard focus, disabled viewer
   * ================================================================== */
  runner.scenario(
    'ui/4-undo-states',
    'Undo paints accent-soft/accent and scales its icon on hover, presses to scale(.93), shows a 2px accent ring on Tab, and is disabled/opacity .38/not-allowed/inert on hover for a viewer',
    async (ctx) => {
      const documentId = `a6-ui-undo-${marker('doc')}`;
      const typed = marker('UI-UNDO');
      const page = await ctx.newAppPage({ documentId });

      await typeInEditor(page, typed);
      await waitForEditorText(page, (text) => text.includes(typed), {
        label: 'the local edit that enables Undo',
      });
      await waitUntil(
        async () =>
          (
            await page.evaluate(
              () => document.querySelector('[data-testid="undo-state"]')?.textContent ?? '',
            )
          ).includes('undo: available'),
        { label: 'Undo to become enabled', timeoutMs: 10_000 },
      );

      await hover(page, SELECTORS.undoButton);
      const hovered = await waitForStyle(
        page,
        SELECTORS.undoButton,
        'background-color',
        (value) => value === ACCENT_SOFT,
        { label: 'the Undo hover background-color accentSoft' },
      );
      const hoveredColor = await waitForExactStyle(page, SELECTORS.undoButton, 'color', ACCENT, {
        label: 'the Undo hover color accent',
      });
      const icon = await waitForMatrix(
        page,
        `${SELECTORS.undoButton} svg`,
        (matrix) => approx(matrix.a, 1.08, 0.015) && approx(matrix.d, 1.08, 0.015),
        { label: 'the Undo icon scale(1.08) on hover' },
      );
      ctx.note('Undo while hovered', {
        background: hovered,
        color: hoveredColor,
        iconTransform: icon.value,
        iconMatrix: icon.matrix,
      });
      assertApprox(icon.matrix.a, 1.08, 0.015, 'Undo icon hover scaleX');
      assertApprox(icon.matrix.d, 1.08, 0.015, 'Undo icon hover scaleY');

      await mouseDownAt(page, SELECTORS.undoButton);
      const pressed = await waitForMatrix(
        page,
        SELECTORS.undoButton,
        (matrix) => approx(matrix.a, 0.93, 0.02) && approx(matrix.d, 0.93, 0.02),
        { label: 'the Undo button scale(.93) while pressed' },
      );
      const pressedStyle = await styleOf(page, SELECTORS.undoButton, ['transform']);
      ctx.note('Undo while the mouse is held down', {
        transform: pressedStyle?.transform,
        matrix: pressed.matrix,
      });
      assertApprox(pressed.matrix.a, 0.93, 0.02, 'pressed Undo scaleX');
      assertApprox(pressed.matrix.d, 0.93, 0.02, 'pressed Undo scaleY');
      await releaseOutside(page);
      await waitForExactStyle(page, SELECTORS.undoButton, 'transform', 'none', {
        label: 'the Undo button to settle back after release',
      });

      const focus = await focusByTab(page, SELECTORS.undoButton);
      const outline = await styleOf(page, SELECTORS.undoButton, [
        'outline-width',
        'outline-style',
        'outline-color',
      ]);
      ctx.note('Undo after real Tab focus', { tabs: focus.tabs, active: focus.active, outline });
      assertEqual(focus.active.ariaLabel, 'Undo', 'Tab must land on the Undo button');
      assertEqual(outline['outline-width'], '2px', 'keyboard-focused Undo must have a 2px outline');
      assertEqual(outline['outline-style'], 'solid', 'the Undo outline must be solid');
      assertEqual(outline['outline-color'], ACCENT, 'the Undo outline must use the accent colour');

      /* ---------- viewer: disabled, dim, not-allowed, no hover motion ---------- */
      const viewerDocument = `a6-ui-undo-viewer-${marker('doc')}`;
      const viewer = await openViewerPage(ctx, viewerDocument);
      const viewerDisabled = await viewer.evaluate((selector) => {
        const button = document.querySelector(selector);
        return button instanceof HTMLButtonElement ? button.disabled : null;
      }, SELECTORS.undoButton);
      const viewerFacts = await styleOf(viewer, SELECTORS.undoButton, [
        'opacity',
        'cursor',
        'transform',
      ]);
      ctx.note('viewer Undo before hover', { viewerDisabled, ...viewerFacts });
      assertEqual(viewerDisabled, true, 'a viewer’s Undo must be disabled');

      await hover(viewer, SELECTORS.undoButton);
      await sleep(300);
      const viewerHover = await styleOf(viewer, SELECTORS.undoButton, [
        'opacity',
        'cursor',
        'transform',
        'background-color',
      ]);
      ctx.note('viewer Undo while hovered', viewerHover);
      assertEqual(viewerHover.opacity, '0.38', 'disabled Undo must be painted at opacity .38');
      assertEqual(
        viewerHover.cursor,
        'not-allowed',
        'disabled Undo must not advertise itself as clickable',
      );
      assertEqual(viewerHover.transform, 'none', 'a disabled Undo must not respond to hover');
    },
  );

  /* ================================================================== *
   * 5 — Live dot pulse only on a hovered connected pill
   * ================================================================== */
  runner.scenario(
    'ui/5-connection-pill-pulse',
    'the connected pill’s dot runs ih-pulse only while hovered, no pulse exists without hover or while reconnecting, and exactly one badge exists outside the topbar',
    async (ctx) => {
      const page = await ctx.newAppPage({ documentId: `a6-ui-pill-${marker('doc')}` });
      await waitForConnectionStatus(page, 'connected', { timeoutMs: 30_000 });

      const counts = await page.evaluate(() => ({
        total: document.querySelectorAll('[data-testid="connection-status"]').length,
        inTopbar: document.querySelectorAll('.topbar [data-testid="connection-status"]').length,
        status: document.querySelector('[data-testid="connection-status"]')?.dataset.status ?? null,
        label:
          document.querySelector('[data-testid="connection-status"] .conn-pill__label')
            ?.textContent ?? null,
      }));
      ctx.note('connection badge placement', counts);
      assertEqual(counts.total, 1, 'exactly one [data-testid="connection-status"] must exist');
      assertEqual(counts.inTopbar, 0, 'the badge lives in the document header, not the topbar');
      assertEqual(counts.status, 'connected', 'the badge must start connected');

      const dotSelector = `${SELECTORS.connectionStatus} .conn-pill__dot`;
      const idlePulse = await waitForStyle(
        page,
        dotSelector,
        'animation-name',
        (value) => value === 'none',
        {
          label: 'the dot to have no animation while not hovered',
        },
      );
      ctx.note('dot animation-name without hover', idlePulse);

      await hover(page, SELECTORS.connectionStatus);
      const hoverPulse = await waitForStyle(
        page,
        dotSelector,
        'animation-name',
        (value) => value === 'ih-pulse',
        { label: 'the connected dot ih-pulse while hovered' },
      );
      const animation = await styleOf(page, dotSelector, ['animation-name', 'animation-duration']);
      ctx.note('dot animation while the connected pill is hovered', animation);
      assertEqual(hoverPulse, 'ih-pulse', 'hovering a connected pill must start ih-pulse');

      await moveMouseAway(page);
      const unpulsed = await waitForStyle(
        page,
        dotSelector,
        'animation-name',
        (value) => value === 'none',
        {
          label: 'the dot animation to stop after mouse-out',
        },
      );
      ctx.note('dot animation-name after mouse-out', unpulsed);

      await setOffline(page, true);
      const reconnecting = await waitForConnectionStatus(page, 'reconnecting', {
        timeoutMs: 20_000,
      });
      await hover(page, SELECTORS.connectionStatus);
      await sleep(300);
      const reconnectingPulse = await styleOf(page, dotSelector, [
        'animation-name',
        'animation-duration',
      ]);
      ctx.note('reconnecting pill while hovered', {
        status: reconnecting,
        ...reconnectingPulse,
      });
      assertEqual(reconnecting, 'reconnecting', 'the fault must drive the real reconnecting state');
      assertEqual(
        reconnectingPulse['animation-name'],
        'none',
        'a reconnecting pill must never pulse — the motion cannot claim “live”',
      );
      await setOffline(page, false);
    },
  );

  /* ================================================================== *
   * 6 — editor focus-within strengthens the canvas frame
   * ================================================================== */
  runner.scenario(
    'ui/6-editor-focus-within',
    'focusing the editor turns the canvas border accent and strengthens the box-shadow (larger blur and alpha) than the idle canvas',
    async (ctx) => {
      const page = await ctx.newAppPage({ documentId: `a6-ui-canvas-${marker('doc')}` });

      const idle = await styleOf(page, '.canvas', ['border-color', 'box-shadow']);
      const idleShadow = shadowMetrics(idle['box-shadow']);
      ctx.note('canvas computed style before editor focus', idle);

      await page.click(SELECTORS.editorContent);
      const border = await waitForExactStyle(page, '.canvas', 'border-color', ACCENT, {
        label: 'the canvas accent border while the editor has focus',
      });
      const focused = await styleOf(page, '.canvas', ['border-color', 'box-shadow']);
      const focusedShadow = shadowMetrics(focused['box-shadow']);
      ctx.note('canvas computed style while the editor has focus', focused);
      ctx.note('box-shadow comparison', {
        idle: { value: idle['box-shadow'], ...idleShadow },
        focused: { value: focused['box-shadow'], ...focusedShadow },
      });

      assertEqual(border, ACCENT, 'focus-within must turn the canvas border accent');
      assert(idleShadow !== null, 'the idle canvas must have a parsable box-shadow');
      assert(focusedShadow !== null, 'the focused canvas must have a parsable box-shadow');
      assert(
        focused['box-shadow'] !== idle['box-shadow'],
        `focus-within must change the canvas box-shadow (idle ${JSON.stringify(idle['box-shadow'])}, focused ${JSON.stringify(focused['box-shadow'])})`,
      );
      assert(
        focusedShadow.blur > idleShadow.blur,
        `the focused canvas blur (${focusedShadow.blur}px) must exceed idle (${idleShadow.blur}px)`,
      );
      assert(
        focusedShadow.alpha > idleShadow.alpha,
        `the focused canvas shadow alpha (${focusedShadow.alpha}) must exceed idle (${idleShadow.alpha})`,
      );
    },
  );

  /* ================================================================== *
   * 7 — reduced motion: no transitions/animations, states stay visible
   * ================================================================== */
  runner.scenario(
    'ui/7-reduced-motion',
    'with prefers-reduced-motion:reduce every transition duration is 0s and the live pulse is off, while the collaborator tooltip and read-only notice remain visible',
    async (ctx) => {
      const documentId = `a6-ui-motion-${marker('doc')}`;
      const peerName = `Reduced Motion Peer ${marker('name')}`;
      const page = await openViewerPage(ctx, documentId);

      const peer = await WireOracle.connect({
        url: ctx.stack.wsUrl,
        documentId,
        label: 'reduced-motion-presence',
        userId: DEMO_USERS.grace,
        role: 'editor',
      });
      try {
        peer.enablePresence(
          { id: 'reduced-motion-peer', name: peerName, color: '#8b5cf6' },
          { cursor: { anchor: 0, head: 0 } },
        );
        const rendered = await waitForCollaboratorByTip(page, peerName);
        const avatarSelector = `.collab[data-client-id="${rendered.clientId}"]`;
        const tipSelector = `${avatarSelector} .collab__tip`;

        await emulateReducedMotion(page, true);
        const media = await page.evaluate(() => ({
          reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
          noPreference: matchMedia('(prefers-reduced-motion: no-preference)').matches,
        }));
        ctx.note('emulated motion media', media);
        assertEqual(media.reduce, true, 'the browser must report prefers-reduced-motion: reduce');

        const durationTargets = [
          ['logo', '.brand__logo'],
          ['switcher', '.switcher'],
          ['avatar', avatarSelector],
          ['connection pill', SELECTORS.connectionStatus],
          ['canvas', '.canvas'],
        ];
        const durations = {};
        for (const [label, selector] of durationTargets) {
          durations[label] = await waitForStyle(
            page,
            selector,
            'transition-duration',
            allDurationsZero,
            { label: `${label} transition-duration to be 0s under reduced motion` },
          );
        }
        ctx.note('transition-duration values under reduced motion', durations);

        await hover(page, SELECTORS.connectionStatus);
        const dotAnimation = await styleOf(page, `${SELECTORS.connectionStatus} .conn-pill__dot`, [
          'animation-name',
          'animation-duration',
        ]);
        ctx.note('pill dot animation under reduced motion while hovered', dotAnimation);
        assertEqual(
          dotAnimation['animation-name'],
          'none',
          'the live-dot pulse must be off under reduced motion',
        );

        await hover(page, avatarSelector);
        const tipOpacity = await waitForExactStyle(page, tipSelector, 'opacity', '1', {
          label: 'the collaborator tooltip to remain visible under reduced motion',
        });
        const tipBox = await readBox(page, tipSelector);
        const notice = await readBox(page, SELECTORS.readOnlyNotice);
        ctx.note('states that must remain visible under reduced motion', {
          tooltipOpacity: tipOpacity,
          tooltipBox: tipBox,
          readOnlyNotice: notice,
        });
        assert(tipBox.width > 0 && tipBox.height > 0, 'the tooltip must still have a real box');
        assertEqual(tipOpacity, '1', 'the tooltip must still be visible under reduced motion');
        assertEqual(notice.present, true, 'the read-only notice must still be rendered');
        assert(notice.width > 0 && notice.height > 0, 'the read-only notice must still have a box');
        assertEqual(notice.opacity, '1', 'the read-only notice must still be visible');

        await page.send('Emulation.setEmulatedMedia', { media: '', features: [] });
      } finally {
        peer.close();
      }
    },
  );

  /* ================================================================== *
   * 8 — notices readable and honest
   * ================================================================== */
  runner.scenario(
    'ui/8-notices-readable',
    'the viewer read-only notice is visible with the exact headline “Read-only for your role”, and no page copy claims Saved, All changes saved, Synced, immediately revoked or role updated instantly',
    async (ctx) => {
      const documentId = `a6-ui-notice-${marker('doc')}`;
      const page = await openViewerPage(ctx, documentId);

      await waitForExactStyle(page, SELECTORS.readOnlyNotice, 'opacity', '1', {
        label: 'the read-only notice to finish its entrance and become opaque',
      });
      const notice = await readBox(page, SELECTORS.readOnlyNotice);
      const title = await page.evaluate(
        (selector) =>
          document.querySelector(`${selector} .read-only-notice__title`)?.textContent?.trim() ??
          null,
        SELECTORS.readOnlyNotice,
      );
      const text = await pageText(page);
      const lower = text.toLowerCase();
      const banned = [
        'Saved',
        'All changes saved',
        'Synced',
        'immediately revoked',
        'role updated instantly',
      ];
      const found = banned.filter((phrase) => lower.includes(phrase.toLowerCase()));
      ctx.note('read-only notice', notice);
      ctx.note('read-only notice headline', title);
      ctx.note('page text inspected for false save/sync/role claims', {
        characters: text.length,
        bannedPhrases: banned,
        found,
      });

      assertEqual(notice.present, true, 'the read-only notice must be rendered');
      assert(
        notice.width > 0 && notice.height > 0,
        'the read-only notice must be laid out visibly',
      );
      assertEqual(notice.display !== 'none', true, 'the notice must not be display:none');
      assertEqual(notice.visibility, 'visible', 'the notice must be visibility:visible');
      assertEqual(notice.opacity, '1', 'the notice must be fully opaque');
      assertEqual(
        title,
        'Read-only for your role',
        'the notice headline must be exactly “Read-only for your role”',
      );
      for (const phrase of banned) {
        assert(
          !found.includes(phrase),
          `the page must not contain the false claim ${JSON.stringify(phrase)}; ` +
            `all banned matches were ${JSON.stringify(found)}`,
        );
      }
    },
  );
}
