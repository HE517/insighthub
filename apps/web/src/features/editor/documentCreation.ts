/**
 * `POST /api/documents` — self-service document creation (M4 B12.5, `docs/DECISIONS.md` D-084
 * acceptance #7).
 *
 * ## What the client may and may not say
 *
 * The request body is **empty**: D-084 #2 makes the title optional (the server applies
 * `Untitled document`) and makes the id, the owner and the role server facts. This module has no
 * parameter for any of them, which is the client-side half of that guarantee — there is nothing to
 * that could be sent even if a caller wanted to.
 *
 * ```text
 * POST /api/documents            (no body)
 *   → 201 { documentId, title }  ← the two values needed to switch to the new document
 * ```
 *
 * The body is validated before use exactly like `listDocuments` validates its list: an
 * unreadable `201` must not become an "open the new document" action for an id that does not
 * exist. A failure is a typed {@link DocumentCreateError}, never a silent success — the UI has to
 * tell the user whether a document now exists.
 *
 * ## Failure semantics (why `timeout`/`malformed` are not called "not created")
 *
 * | kind | meaning |
 * | --- | --- |
 * | `unauthorized` | `401` — no verified session, so the server refused before creating |
 * | `http` | any other non-2xx (`400`/`403`/`500`/…); the server's transaction rolled back |
 * | `network` | the request never reached the server |
 * | `timeout` | no answer in time; **the server may still have committed** |
 * | `malformed` | a `2xx` whose body this client cannot read; a document may exist |
 * | `aborted` | cancelled on purpose (unmount); not a user-visible failure |
 *
 * The last two are why the copy in `newDocumentCopy.ts` never claims "nothing was created" for
 * them and tells the user to check the directory first. `AGENTS.md` R9: every call takes an
 * `AbortSignal` and the aborted case is handled, not thrown at the user.
 */
import { postJson } from '../../api.js';

/** Why `POST /api/documents` produced no usable answer. */
export type DocumentCreateFailure =
  'aborted' | 'unauthorized' | 'http' | 'network' | 'timeout' | 'malformed';

/**
 * A failed creation.
 *
 * `kind` is the stable discriminator; `status` is present for `http`/`unauthorized`, which is what
 * lets the copy distinguish "no session" from "the server broke" instead of collapsing them.
 */
export class DocumentCreateError extends Error {
  readonly kind: DocumentCreateFailure;
  readonly status?: number;

  constructor(kind: DocumentCreateFailure, message: string, status?: number) {
    super(message);
    this.name = 'DocumentCreateError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** The server's `201` body (`docs/CONTRACTS.md` §17.4, B12.5). */
export interface CreatedDocument {
  readonly documentId: string;
  readonly title: string;
}

/**
 * Validate the creation response before anything acts on it.
 *
 * Hand-written checks rather than a Zod schema: the web app has no `zod` dependency and the
 * frozen body is two strings. Everything the client needs is that both are non-empty; the id's
 * format is the server's business, so it is deliberately not re-constrained here.
 */
export function parseCreatedDocument(value: unknown): CreatedDocument | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const documentId = record['documentId'];
  const title = record['title'];
  if (typeof documentId !== 'string' || documentId.length === 0) return null;
  if (typeof title !== 'string' || title.length === 0) return null;
  return { documentId, title };
}

export interface CreateDocumentOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Create one document, owned by the session's identity, and resolve the server's answer.
 *
 * Rejects (never resolves `undefined`) when the call failed or the body was unreadable. The
 * `signal` is forwarded to `fetch` by the shared HTTP client (`api.ts`), which also applies a
 * timeout; an aborted request rejects as `aborted`, which callers must treat as a non-event.
 */
export async function createDocument(
  options: CreateDocumentOptions = {},
): Promise<CreatedDocument> {
  const signal = options.signal;
  // Close the window where an already-aborted signal would still reach the network (the same
  // check `listDocuments` makes for the same reason).
  if (signal?.aborted === true) {
    throw new DocumentCreateError(
      'aborted',
      'The create-document request was aborted before it started.',
    );
  }

  const result = await postJson<unknown>('/api/documents', {
    // Session-bearing write: the cookie must be carried even when the API lives on another
    // origin (`docs/CONTRACTS.md` §17.4 cross-origin note). No body on purpose — see the header.
    credentials: 'include',
    ...(signal === undefined ? {} : { signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  if (!result.ok) {
    switch (result.error.kind) {
      case 'aborted':
        throw new DocumentCreateError('aborted', 'The create-document request was aborted.');
      case 'timeout':
        throw new DocumentCreateError('timeout', result.error.message);
      case 'network':
        throw new DocumentCreateError('network', result.error.message);
      case 'http':
        if (result.error.status === 401) {
          throw new DocumentCreateError(
            'unauthorized',
            'POST /api/documents answered 401: no valid session.',
            401,
          );
        }
        throw new DocumentCreateError(
          'http',
          `POST /api/documents failed with HTTP ${String(result.error.status)}.`,
          result.error.status,
        );
    }
  }

  const created = parseCreatedDocument(result.data);
  if (created === null) {
    throw new DocumentCreateError(
      'malformed',
      'POST /api/documents answered 201 without a readable { documentId, title } body.',
    );
  }
  return created;
}
