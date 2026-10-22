/**
 * The read-only directory, asserted two ways that the Node gate can see:
 *
 * 1. **Markup** (`renderToStaticMarkup`, the same technique `readOnlyNotice.test.ts` uses): the
 *    published testids, the `aria-current` marker on the active document, and the three-state copy.
 * 2. **Failure copy**: every typed `DocumentListError` maps to readable, distinct words, and
 *    `aborted` maps to nothing at all.
 *
 * The live fetch/abort lifecycle (mount → `GET /api/documents`, Refresh → abort + refetch, close →
 * abort) is an effect, so it is exercised in the real browser suite, not here; a Node test must not
 * pretend to be that evidence. What is asserted here is the part that would otherwise rot silently:
 * the DOM contract A6 consumes and the wording a user reads.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import type { DocumentMeta } from '@insighthub/shared';

import { DocumentListError } from '../ai/tools.js';
import { AiDirectoryView, type DirectoryState } from './AiDirectory.js';
import {
  AI_DIRECTORY_EMPTY_COPY,
  describeDirectoryFailure,
  type DirectoryFailureCopy,
} from './aiDirectoryCopy.js';

const DOCUMENTS: readonly DocumentMeta[] = [
  {
    id: 'alpha',
    title: 'Alpha notes',
    revision: 1,
    ownerId: 'demo-ada',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  },
  {
    id: 'bravo',
    title: 'Bravo notes',
    revision: 2,
    ownerId: 'demo-ada',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  },
  {
    id: 'charlie',
    title: 'Charlie notes',
    revision: 3,
    ownerId: 'demo-ada',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  },
];

function markupFor(state: DirectoryState, activeDocumentId = 'bravo'): string {
  return renderToStaticMarkup(
    createElement(AiDirectoryView, {
      state,
      activeDocumentId,
      onRefresh: () => undefined,
      onSelect: () => undefined,
    }),
  );
}

/** Count non-overlapping occurrences of a literal, so an assertion cannot pass on a substring. */
function count(html: string, literal: string): number {
  return html.split(literal).length - 1;
}

describe('directory markup: the published DOM contract', () => {
  it('renders the section and its Refresh control while loading, with no list and no error', () => {
    const html = markupFor({ kind: 'loading' });

    expect(html).toContain('data-testid="ai-directory"');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-testid="ai-directory-refresh"');
    expect(html).toContain('Loading readable documents');
    expect(html).not.toContain('data-testid="ai-directory-item"');
    expect(html).not.toContain('data-testid="ai-directory-error"');
    expect(html).not.toContain('data-testid="ai-directory-empty"');
  });

  it('lists readable documents and marks exactly the active one with aria-current', () => {
    const html = markupFor({ kind: 'ready', documents: DOCUMENTS }, 'bravo');

    expect(html).toContain('data-state="ready"');
    expect(html).toContain('aria-busy="false"');
    for (const document of DOCUMENTS) {
      expect(html).toContain(`data-document-id="${document.id}"`);
      expect(html).toContain(document.title);
    }
    expect(count(html, 'data-testid="ai-directory-item"')).toBe(DOCUMENTS.length);
    // Exactly one current marker, and it is the active document (not merely "a row exists").
    expect(count(html, 'aria-current="true"')).toBe(1);
    expect(html).toMatch(/data-document-id="bravo"[^>]*aria-current="true"/);
    expect(html).not.toMatch(/data-document-id="alpha"[^>]*aria-current="true"/);
    expect(html).not.toMatch(/data-document-id="charlie"[^>]*aria-current="true"/);
  });

  it('marks nothing when the active document is not in the readable list', () => {
    // A brand-new local id, or one the server does not list for this identity: the list must not
    // invent a "current" row, and must not claim the active document is unreadable.
    const html = markupFor({ kind: 'ready', documents: DOCUMENTS }, 'not-listed');
    expect(html).not.toContain('aria-current="true"');
    expect(count(html, 'data-testid="ai-directory-item"')).toBe(DOCUMENTS.length);
  });

  it('renders the exact empty-state sentence, not an error and not a blank list', () => {
    const html = markupFor({ kind: 'ready', documents: [] });

    expect(html).toContain('data-state="empty"');
    expect(html).toContain('data-testid="ai-directory-empty"');
    expect(html).toContain(AI_DIRECTORY_EMPTY_COPY);
    expect(AI_DIRECTORY_EMPTY_COPY).toBe('No readable documents');
    expect(html).not.toContain('data-testid="ai-directory-item"');
    expect(html).not.toContain('data-testid="ai-directory-error"');
  });

  it('renders a readable, typed error with the Refresh control still available', () => {
    const failure = describeDirectoryFailure(new DocumentListError('network', 'fetch failed'));
    expect(failure).not.toBeNull();
    const html = markupFor({ kind: 'error', failure: failure as DirectoryFailureCopy });

    expect(html).toContain('data-state="error"');
    expect(html).toContain('data-testid="ai-directory-error"');
    expect(html).toContain('data-directory-error="network"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('The document list is unavailable.');
    expect(html).toContain('Press Refresh to try again.');
    expect(html).toContain('data-testid="ai-directory-refresh"');
    expect(html).not.toContain('data-testid="ai-directory-empty"');
    expect(html).not.toContain('data-testid="ai-directory-item"');
  });
});

describe('directory failure copy: typed, distinct and never silent', () => {
  it('returns null only for an aborted request', () => {
    expect(describeDirectoryFailure(new DocumentListError('aborted', 'cancelled'))).toBeNull();
  });

  it('gives every non-aborted kind its own readable sentence and stable discriminator', () => {
    const cases = [
      new DocumentListError('unauthorized', 'no session', 401),
      new DocumentListError('http', 'HTTP 500', 500),
      new DocumentListError('network', 'fetch failed'),
      new DocumentListError('timeout', 'timed out'),
      new DocumentListError('malformed', 'bad body'),
      new Error('something else broke'),
    ] as const;

    const seen = new Set<string>();
    for (const error of cases) {
      const failure = describeDirectoryFailure(error);
      expect(failure).not.toBeNull();
      if (failure === null) throw new Error('unreachable');
      expect(failure.title.trim().length).toBeGreaterThan(0);
      expect(failure.detail.trim().length).toBeGreaterThan(0);
      // Distinct words per cause: `unknown`/`network`/`http` must not collapse into one message.
      seen.add(failure.title);
    }
    expect(seen.size).toBe(cases.length);
  });

  it('keeps the HTTP status in the copy, so a 500 is not reported as "unreachable"', () => {
    const failure = describeDirectoryFailure(new DocumentListError('http', 'HTTP 503', 503));
    expect(failure?.kind).toBe('http');
    expect(failure?.detail).toContain('503');
  });

  it('keeps an untyped error message instead of swallowing it', () => {
    const failure = describeDirectoryFailure(new Error('boom while listing'));
    expect(failure?.kind).toBe('unexpected');
    expect(failure?.detail).toContain('boom while listing');
  });

  it('ignores a thrown non-Error without inventing a message it did not have', () => {
    const failure = describeDirectoryFailure('not an error');
    expect(failure?.kind).toBe('unexpected');
    expect(failure?.detail).toContain('failed without a typed reason');
  });
});
