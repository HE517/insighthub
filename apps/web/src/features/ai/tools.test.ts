import { afterEach, describe, expect, it, vi } from 'vitest';

import { DOCUMENT_TEXT_KEY, type DocumentMeta } from '@insighthub/shared';

import { createDocument } from './testSupport.js';
import { DocumentListError, listDocuments, readDocumentText } from './tools.js';

const DOCUMENT: DocumentMeta = {
  id: 'demo-document',
  title: 'Demo document',
  revision: 4,
  ownerId: 'demo-ada',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
};

interface RecordedRequest {
  url: string;
  method: string;
  signal: AbortSignal | null | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Replace `fetch` and record what the tool asked for. */
function stubFetch(response: Response | (() => Response)): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      signal: init?.signal,
    });
    return typeof response === 'function' ? response() : response;
  });
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('readDocumentText', () => {
  it('reads the live Y.Text and never caches a stale copy', () => {
    const doc = createDocument('first');
    const session = { doc };

    expect(readDocumentText(session)).toBe('first');

    doc.getText(DOCUMENT_TEXT_KEY).insert(5, ' second');
    expect(readDocumentText(session)).toBe('first second');
  });

  it('returns an empty string for an empty document', () => {
    expect(readDocumentText({ doc: createDocument() })).toBe('');
  });
});

describe('listDocuments', () => {
  it('GETs /api/documents with a signal and returns schema-valid DocumentMeta[]', async () => {
    const requests = stubFetch(jsonResponse({ documents: [DOCUMENT] }));
    const controller = new AbortController();

    const documents = await listDocuments(controller.signal);

    expect(documents).toEqual([DOCUMENT]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toMatch(/\/api\/documents$/);
    expect(requests[0].method).toBe('GET');
    // R9: the caller's cancellation is actually forwarded to fetch.
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects 401 as `unauthorized`, not as an empty list', async () => {
    stubFetch(jsonResponse({ error: 'unauthorized' }, 401));

    await expect(listDocuments(new AbortController().signal)).rejects.toMatchObject({
      name: 'DocumentListError',
      kind: 'unauthorized',
      status: 401,
    });
  });

  it('rejects any other non-2xx as `http` with the status', async () => {
    stubFetch(jsonResponse({ error: 'internal_error' }, 500));

    await expect(listDocuments(new AbortController().signal)).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    });
  });

  it('rejects a body that does not match { documents: DocumentMeta[] }', async () => {
    stubFetch(() => jsonResponse({ documents: [{ id: '', title: '' }] }));

    await expect(listDocuments(new AbortController().signal)).rejects.toBeInstanceOf(
      DocumentListError,
    );
    await expect(listDocuments(new AbortController().signal)).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('rejects a non-object body as `malformed`', async () => {
    stubFetch(() => jsonResponse(null));

    await expect(listDocuments(new AbortController().signal)).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('rejects a network failure as `network`', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    await expect(listDocuments(new AbortController().signal)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('rejects an already-aborted signal without touching the network', async () => {
    const requests = stubFetch(jsonResponse({ documents: [] }));
    const controller = new AbortController();
    controller.abort();

    await expect(listDocuments(controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
    expect(requests).toHaveLength(0);
  });

  it('aborts an in-flight request through the forwarded signal', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined)
        throw new Error('fetch was called without a signal');
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });

    const controller = new AbortController();
    const pending = listDocuments(controller.signal);
    // `fetch` is invoked synchronously by the HTTP client; the signal must already be attached.
    expect(signals).toHaveLength(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });
});
