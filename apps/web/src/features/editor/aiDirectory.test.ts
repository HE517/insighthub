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
import { DocumentCreateError } from './documentCreation.js';
import { AiDirectoryView, type DirectoryState } from './AiDirectory.js';
import {
  AI_DIRECTORY_EMPTY_COPY,
  describeDirectoryFailure,
  type DirectoryFailureCopy,
} from './aiDirectoryCopy.js';
import {
  NEW_DOCUMENT_LABEL,
  NEW_DOCUMENT_PENDING_LABEL,
  describeCreateFailure,
  type NewDocumentFailureCopy,
} from './newDocumentCopy.js';

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

function markupFor(
  state: DirectoryState,
  activeDocumentId = 'bravo',
  options: { creating?: boolean; createFailure?: NewDocumentFailureCopy | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(AiDirectoryView, {
      state,
      activeDocumentId,
      creating: options.creating ?? false,
      createFailure: options.createFailure ?? null,
      onRefresh: () => undefined,
      onSelect: () => undefined,
      onCreate: () => undefined,
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

describe('new document control: markup (D-084 acceptance #7)', () => {
  it('renders one enabled New document button beside Refresh in every list state', () => {
    for (const state of [
      { kind: 'loading' },
      { kind: 'ready', documents: DOCUMENTS },
      { kind: 'ready', documents: [] },
      {
        kind: 'error',
        failure: describeDirectoryFailure(
          new DocumentListError('http', 'HTTP 500', 500),
        ) as DirectoryFailureCopy,
      },
    ] satisfies readonly DirectoryState[]) {
      const html = markupFor(state);
      expect(count(html, 'data-testid="new-document"')).toBe(1);
      expect(html).toContain(NEW_DOCUMENT_LABEL);
      // Creation is not a function of the list: a user with zero readable documents (the state
      // B12.5 exists for) must still see the control.
      expect(html).not.toMatch(/data-testid="new-document"[^>]*disabled/);
      // The pre-existing directory contract is untouched.
      expect(html).toContain('data-testid="ai-directory-refresh"');
    }
  });

  it('disables exactly the New document button while a creation is pending', () => {
    const html = markupFor({ kind: 'ready', documents: DOCUMENTS }, 'bravo', {
      creating: true,
    });

    // The pending label is visible, so "it is doing something" is not only conveyed by colour.
    expect(html).toContain(NEW_DOCUMENT_PENDING_LABEL);
    expect(html).toMatch(/<button[^>]*data-testid="new-document"[^>]*disabled/);
    // The list stays readable and its own control is unaffected by the creation.
    expect(count(html, 'data-testid="ai-directory-item"')).toBe(DOCUMENTS.length);
    expect(html).not.toMatch(/<button[^>]*data-testid="ai-directory-refresh"[^>]*disabled/);
  });

  it('renders a created-failure alert with a typed discriminator and no fabricated list row', () => {
    const failure = describeCreateFailure(
      new DocumentCreateError('http', 'POST /api/documents failed with HTTP 500.', 500),
    );
    const html = markupFor({ kind: 'ready', documents: DOCUMENTS }, 'bravo', {
      createFailure: failure,
    });

    expect(html).toContain('data-testid="new-document-error"');
    expect(html).toContain('data-create-error="http"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('The document was not created.');
    expect(html).toContain('500');
    // A failed creation must not appear as a document: the server list is the only source.
    expect(count(html, 'data-testid="ai-directory-item"')).toBe(DOCUMENTS.length);
    expect(html).not.toContain('Untitled document');
    // The button is usable again, so the failure is retryable from the same control.
    expect(html).not.toMatch(/data-testid="new-document"[^>]*disabled/);
  });

  it('keeps the creation error visible while the list is loading or in its own error state', () => {
    const failure = describeCreateFailure(
      new DocumentCreateError('unauthorized', 'no session', 401),
    );
    const onLoading = markupFor({ kind: 'loading' }, 'bravo', { createFailure: failure });
    const onDirectoryError = markupFor(
      {
        kind: 'error',
        failure: describeDirectoryFailure(
          new DocumentListError('network', 'offline'),
        ) as DirectoryFailureCopy,
      },
      'bravo',
      { createFailure: failure },
    );

    // Both errors are distinguishable: the directory keeps its own testid, so a scenario can
    // never mistake "the list failed" for "creation failed".
    expect(onLoading).not.toContain('data-testid="ai-directory-error"');
    expect(onDirectoryError).toContain('data-testid="ai-directory-error"');
    for (const html of [onLoading, onDirectoryError]) {
      expect(html).toContain('data-testid="new-document-error"');
      expect(html).toContain('data-create-error="unauthorized"');
    }
  });
});

describe('creation failure copy: honest about what is known (D-084 #7)', () => {
  it('maps 401 and 500 to distinct, retryable copy that never promises a saved document', () => {
    const unauthorized = describeCreateFailure(
      new DocumentCreateError('unauthorized', 'no session', 401),
    );
    const serverError = describeCreateFailure(new DocumentCreateError('http', 'HTTP 500', 500));

    expect(unauthorized?.kind).toBe('unauthorized');
    expect(serverError?.kind).toBe('http');
    expect(unauthorized?.title).not.toBe(serverError?.title);
    expect(serverError?.detail).toContain('500');
    expect(unauthorized?.detail.toLowerCase()).toContain('nothing was created');
    expect(serverError?.detail.toLowerCase()).toContain('nothing was created');
    // Neither may read as a success: the only confirmation of a created document is the switch
    // to the id the server returned.
    for (const failure of [unauthorized, serverError] as const) {
      expect(failure?.detail).not.toMatch(/saved|saving|successfully/i);
      expect(failure?.detail).toMatch(/try again|reload/i);
    }
  });

  it('does not claim "nothing was created" when the server may have committed', () => {
    const timeout = describeCreateFailure(new DocumentCreateError('timeout', 'timed out'));
    const malformed = describeCreateFailure(new DocumentCreateError('malformed', 'bad body'));
    // A transport failure can happen after the server committed but before the answer arrived;
    // the client cannot prove the absence of a document, so it must not say there is none.
    const network = describeCreateFailure(new DocumentCreateError('network', 'fetch failed'));

    for (const failure of [timeout, malformed, network] as const) {
      expect(failure).not.toBeNull();
      expect(failure?.detail).not.toContain('Nothing was created.');
      // The honest next step is to look at the server's list, not to create a second document.
      expect(failure?.detail).toContain('Refresh');
    }
  });

  it('returns null only for an aborted request', () => {
    expect(describeCreateFailure(new DocumentCreateError('aborted', 'cancelled'))).toBeNull();
  });

  it('keeps an untyped error message, without inventing an outcome', () => {
    const failure = describeCreateFailure(new Error('boom while creating'));
    expect(failure?.kind).toBe('unexpected');
    expect(failure?.detail).toContain('boom while creating');
    expect(failure?.detail).not.toContain('Nothing was created.');
  });
});
