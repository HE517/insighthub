/**
 * The preview feed: one debounced, read-only reader of `Y.Text` (V1 Markdown preview).
 *
 * Everything here runs in the workspace's `node` Vitest environment against a **real**
 * `Y.Doc` / `Y.Text` (`FakeCollaborativeSession`), because the interesting behaviour is the
 * observer lifetime and the debounce, not a mocked string. There is no DOM involved: the feed
 * is deliberately a plain object (`previewFeed.ts`), so these rules are testable without jsdom.
 *
 * What is proven here:
 *
 * - entering preview renders **once, immediately** (no empty frame, no 400 ms wait);
 * - edits re-render only after the 400 ms window, and a burst is coalesced into one render;
 * - the observer exists **only** while the preview is visible (before `activate()` and after
 *   `deactivate()` an edit produces no render at all);
 * - a 100k document renders once on entry and its `Y.Text` / state vector are byte-identical
 *   afterwards — preview is a reader, never a writer (`AGENTS.md` R11);
 * - `session.transact`, `doc.transact`, `text.insert` and `text.delete` are never called by
 *   the feed.
 */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { DOCUMENT_TEXT_KEY, TRANSACTION_ORIGINS } from '@insighthub/shared';

import { createPreviewFeed, PREVIEW_DEBOUNCE_MS } from './previewFeed.js';
import {
  createFakeCollaborativeSession,
  type FakeCollaborativeSession,
} from './testing/fakeCollaborativeSession.js';
import { hundredThousandMarkdown } from './testing/previewFixture.js';

const USER = { id: 'me', name: 'Me' };

function createSession(initialText: string): FakeCollaborativeSession {
  return createFakeCollaborativeSession({ documentId: 'preview', user: USER, initialText });
}

/** The production seam: the preview reads `doc.getText('content')`, not a copy. */
function documentText(session: FakeCollaborativeSession): Y.Text {
  return session.doc.getText(DOCUMENT_TEXT_KEY);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function encodeState(session: FakeCollaborativeSession): string {
  return Buffer.from(Y.encodeStateVector(session.doc)).toString('hex');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('preview feed: entering preview renders once, immediately', () => {
  it('uses a 400 ms debounce', () => {
    expect(PREVIEW_DEBOUNCE_MS).toBe(400);
  });

  it('emits the current Y.Text synchronously on activate(), without a timer', () => {
    const session = createSession('# Hello\n\nWorld');
    const snapshots: string[] = [];
    const feed = createPreviewFeed({
      text: documentText(session),
      onSnapshot: (markdown) => snapshots.push(markdown),
    });

    feed.activate();

    expect(snapshots).toEqual(['# Hello\n\nWorld']);
    feed.deactivate();
    session.destroy();
  });

  it('is idempotent: a second activate() does not render again', () => {
    const session = createSession('once');
    const snapshots: string[] = [];
    const feed = createPreviewFeed({
      text: documentText(session),
      onSnapshot: (markdown) => snapshots.push(markdown),
    });

    feed.activate();
    feed.activate();

    expect(snapshots).toEqual(['once']);
    feed.deactivate();
    session.destroy();
  });
});

describe('preview feed: 400 ms debounce while visible', () => {
  it('does not re-render within the window and does after it', () => {
    vi.useFakeTimers();
    const session = createSession('start');
    const snapshots: string[] = [];
    const feed = createPreviewFeed({
      text: documentText(session),
      onSnapshot: (markdown) => snapshots.push(markdown),
    });
    feed.activate();
    snapshots.length = 0;

    session.transact((text) => text.insert(text.length, '!'), TRANSACTION_ORIGINS.local);
    expect(snapshots).toEqual([]);

    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(snapshots).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(snapshots).toEqual(['start!']);

    feed.deactivate();
    session.destroy();
  });

  it('coalesces a burst into one render, timed from the last change', () => {
    vi.useFakeTimers();
    const session = createSession('a');
    const snapshots: string[] = [];
    const feed = createPreviewFeed({
      text: documentText(session),
      onSnapshot: (markdown) => snapshots.push(markdown),
    });
    feed.activate();
    snapshots.length = 0;

    session.transact((text) => text.insert(text.length, 'b'), TRANSACTION_ORIGINS.local);
    vi.advanceTimersByTime(200);
    session.transact((text) => text.insert(text.length, 'c'), TRANSACTION_ORIGINS.local);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(snapshots).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(snapshots).toEqual(['abc']);

    feed.deactivate();
    session.destroy();
  });

  it('sees a remote collaborator edit through the same observer', () => {
    vi.useFakeTimers();
    const session = createSession('base');
    const snapshots: string[] = [];
    const feed = createPreviewFeed({
      text: documentText(session),
      onSnapshot: (markdown) => snapshots.push(markdown),
    });
    feed.activate();
    snapshots.length = 0;

    session.applyRemoteText((text) => text.insert(0, 'REMOTE '));
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);

    expect(snapshots).toEqual(['REMOTE base']);

    feed.deactivate();
    session.destroy();
  });
});

describe('preview feed: subscription is tied to visibility', () => {
  it('does not observe before activate()', () => {
    vi.useFakeTimers();
    const session = createSession('before');
    const snapshots: string[] = [];
    const feed = createPreviewFeed({
      text: documentText(session),
      onSnapshot: (markdown) => snapshots.push(markdown),
    });

    session.transact((text) => text.insert(text.length, ' change'), TRANSACTION_ORIGINS.local);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(snapshots).toEqual([]);

    // Opening the preview later must show the current text, not the stale pre-edit one.
    feed.activate();
    expect(snapshots).toEqual(['before change']);

    feed.deactivate();
    session.destroy();
  });

  it('cancels the pending timer and stops observing on deactivate()', () => {
    vi.useFakeTimers();
    const session = createSession('visible');
    const snapshots: string[] = [];
    const feed = createPreviewFeed({
      text: documentText(session),
      onSnapshot: (markdown) => snapshots.push(markdown),
    });
    feed.activate();
    snapshots.length = 0;

    session.transact((text) => text.insert(text.length, ' pending'), TRANSACTION_ORIGINS.local);
    feed.deactivate();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 5);
    expect(snapshots).toEqual([]);

    // And later edits are invisible to a deactivated feed.
    session.transact((text) => text.insert(text.length, ' later'), TRANSACTION_ORIGINS.local);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 5);
    expect(snapshots).toEqual([]);

    session.destroy();
  });

  it('re-activating after a deactivate renders the latest text once', () => {
    vi.useFakeTimers();
    const session = createSession('one');
    const snapshots: string[] = [];
    const feed = createPreviewFeed({
      text: documentText(session),
      onSnapshot: (markdown) => snapshots.push(markdown),
    });
    feed.activate();
    feed.deactivate();
    snapshots.length = 0;

    session.transact((text) => text.insert(text.length, ' two'), TRANSACTION_ORIGINS.local);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(snapshots).toEqual([]);

    feed.activate();
    expect(snapshots).toEqual(['one two']);

    feed.deactivate();
    session.destroy();
  });
});

describe('preview feed: read-only (R11)', () => {
  it('never calls a write path and leaves the document byte-identical', () => {
    vi.useFakeTimers();
    const session = createSession('# Title\n\nBody with **bold**.');
    const text = documentText(session);
    const before = text.toString();
    const beforeHash = digest(before);
    const beforeState = encodeState(session);

    const transact = vi.spyOn(session, 'transact');
    const docTransact = vi.spyOn(session.doc, 'transact');
    const insert = vi.spyOn(text, 'insert');
    const remove = vi.spyOn(text, 'delete');
    const snapshots: string[] = [];

    const feed = createPreviewFeed({
      text,
      onSnapshot: (markdown) => snapshots.push(markdown),
    });
    feed.activate();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 3);
    feed.deactivate();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 3);

    expect(snapshots).toEqual([before]);
    expect(transact).not.toHaveBeenCalled();
    expect(docTransact).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(text.toString()).toBe(before);
    expect(digest(text.toString())).toBe(beforeHash);
    expect(encodeState(session)).toBe(beforeState);

    // `vi.spyOn` writes a property on the instance; restore so `session.destroy()` is clean.
    transact.mockRestore();
    docTransact.mockRestore();
    insert.mockRestore();
    remove.mockRestore();
    session.destroy();
  });

  it('renders a 100k document exactly once on entry and does not modify it', () => {
    const fixture = hundredThousandMarkdown();
    expect(fixture).toHaveLength(100_000);

    const session = createSession(fixture);
    const text = documentText(session);
    const beforeHash = digest(text.toString());
    const beforeState = encodeState(session);
    const snapshots: string[] = [];

    const feed = createPreviewFeed({
      text,
      onSnapshot: (markdown) => snapshots.push(markdown),
    });

    const started = performance.now();
    feed.activate();
    const entryMs = performance.now() - started;
    // Test instrumentation, not product telemetry (D-086 §2 allows it in the harness).
    console.log(`[perf] 100k enter-preview snapshot (feed, node): ${entryMs.toFixed(2)} ms`);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toHaveLength(100_000);
    expect(digest(text.toString())).toBe(beforeHash);
    expect(encodeState(session)).toBe(beforeState);
    expect(entryMs).toBeLessThan(5000);

    feed.deactivate();
    session.destroy();
  });
});
