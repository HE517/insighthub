/**
 * `POST /api/documents` from the client (M4 B12.5).
 *
 * The server endpoint is already implemented and frozen (`docs/DECISIONS.md` D-084, `POST
 * /api/documents`): one optional `title`, server-generated id/owner, `201 { documentId, title }`.
 * These tests pin the **client half** without a browser or a real server:
 *
 * - the request is a `POST` with **no body** (the client cannot choose a title/id/owner);
 * - a `201` is validated before anything acts on it;
 * - every failure becomes the typed error the UI copy is built from (`401` is not "the server
 *   broke", and a malformed `201` is not success);
 * - an already-aborted signal never reaches the network (R9).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDocument, DocumentCreateError, parseCreatedDocument } from './documentCreation.js';

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly credentials: RequestCredentials | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function stubFetch(
  respond: (request: RecordedRequest) => Response | Promise<Response>,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init?.headers ?? {})) headers[name] = String(value);
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      credentials: init?.credentials,
      headers,
      body: init?.body,
    };
    requests.push(request);
    return respond(request);
  });
  return requests;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDocument: the request', () => {
  it('POSTs once to /api/documents with no body, no content-type and the session cookie', async () => {
    const requests = stubFetch(() =>
      jsonResponse(
        { documentId: 'd6f1b0f4-0f4e-4f2a-9d1e-2b4f5c6d7e8f', title: 'Untitled document' },
        201,
      ),
    );

    const created = await createDocument();

    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.url, '/api/documents');
    assert.equal(request.method, 'POST');
    // The body is empty on purpose (D-084 #2): the server owns title/id/owner, so the client has
    // nothing to send. A `{}` body would be legal too, but "no body" is the smallest request.
    assert.equal(request.body, undefined);
    assert.equal(request.headers['content-type'], undefined);
    assert.equal(request.headers['authorization'], undefined);
    // Session-authenticated write: the httpOnly cookie must be carried.
    assert.equal(request.credentials, 'include');
    expect(created).toEqual({
      documentId: 'd6f1b0f4-0f4e-4f2a-9d1e-2b4f5c6d7e8f',
      title: 'Untitled document',
    });
  });

  it('forwards the caller’s cancellation to fetch', async () => {
    // `api.ts` links the caller's signal to its own controller, so `fetch` does not receive the
    // caller's object — the observable contract is that aborting it aborts the request.
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      async (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();

    const pending = createDocument({ signal: controller.signal });
    await Promise.resolve();
    expect(seen?.aborted).toBe(false);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(seen?.aborted).toBe(true);
  });

  it('rejects with `aborted` and never touches the network when the signal is already aborted', async () => {
    const requests = stubFetch(() => jsonResponse({ documentId: 'id', title: 't' }, 201));
    const controller = new AbortController();
    controller.abort();

    await expect(createDocument({ signal: controller.signal })).rejects.toMatchObject({
      name: 'DocumentCreateError',
      kind: 'aborted',
    });
    assert.equal(requests.length, 0);
  });
});

describe('createDocument: failure mapping', () => {
  it('maps 401 to `unauthorized` (a missing session is not a server error)', async () => {
    stubFetch(() => jsonResponse({ error: 'session_required' }, 401));

    const error = await createDocument().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DocumentCreateError);
    expect((error as DocumentCreateError).kind).toBe('unauthorized');
    expect((error as DocumentCreateError).status).toBe(401);
  });

  it('maps 500 and 400 to `http` with the real status (the server rolled back)', async () => {
    for (const status of [400, 403, 500]) {
      stubFetch(() => jsonResponse({ error: 'x' }, status));
      const error = await createDocument().catch((caught: unknown) => caught);
      expect((error as DocumentCreateError).kind).toBe('http');
      expect((error as DocumentCreateError).status).toBe(status);
    }
  });

  it('maps an unreachable server to `network`', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    await expect(createDocument()).rejects.toMatchObject({ kind: 'network' });
  });

  it('maps its own timeout to `timeout` (the server may still have committed)', async () => {
    vi.stubGlobal(
      'fetch',
      async (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    await expect(createDocument({ timeoutMs: 10 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps an unreadable 201 body to `malformed` instead of inventing a document id', async () => {
    for (const body of [{}, { documentId: '' }, { documentId: 'id' }, [], 'nope', null]) {
      stubFetch(() => jsonResponse(body, 201));
      await expect(createDocument()).rejects.toMatchObject({ kind: 'malformed' });
    }
  });

  it('accepts the exact server body, and only the two required string fields', () => {
    expect(parseCreatedDocument({ documentId: 'id-1', title: 'Untitled document' })).toEqual({
      documentId: 'id-1',
      title: 'Untitled document',
    });
    expect(parseCreatedDocument({ documentId: 'id-1' })).toBeNull();
    expect(parseCreatedDocument({ title: 'x' })).toBeNull();
    expect(parseCreatedDocument({ documentId: 1, title: 'x' })).toBeNull();
    expect(parseCreatedDocument(null)).toBeNull();
  });
});
