/**
 * Cross-cutting invariants for `POST /api/ai/suggest` that the §11.2 matrix in `route.test.ts`
 * does not cover (A5, M3 Round 2 permission review).
 *
 * Three claims, one test each:
 *
 * 1. **The 404 is the same response as §17.4's.** The matrix test compares the AI endpoint's
 *    two non-disclosure cases with *each other*; §11.2 says they behave exactly like §17.4, so
 *    this compares them with the document read endpoint as well — status, body and every
 *    application header.
 * 2. **The endpoint cannot read document content.** Proven twice: statically (the AI modules
 *    import neither the durable store, the room registry, the socket layer nor Yjs) and
 *    behaviourally (the provider receives exactly the body's `content`; the test harness wires
 *    no `DocumentStore` at all, so there is no server-side source to read).
 * 3. **`AI_PROVIDER=stub` does not widen the gate.** The session check and `canRead` still run
 *    before the stub is called; a viewer is allowed (generation is a read), a denied document
 *    is `404`, and no session is `401`.
 *
 * No production code is changed by this file; it only pins properties the review relies on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { after, describe, it } from 'node:test';

import type { ServerAiSuggestInput, ServerAiProvider } from './provider.js';
import { createServerAiProviderFromEnv } from './openai.js';
import {
  bootstrapSession,
  comparableHeaders,
  postSuggest,
  startAiHarness,
  type AiTestHarness,
} from './test-support.js';

const harnesses: AiTestHarness[] = [];

async function newHarness(provider: ServerAiProvider | null): Promise<AiTestHarness> {
  const harness = await startAiHarness(provider);
  harnesses.push(harness);
  return harness;
}

after(async () => {
  for (const harness of harnesses) await harness.close();
});

const VALID_BODY = {
  documentId: 'demo-document',
  instruction: 'Add a greeting at the very top.',
  baseRevision: 0,
  content: '# Notes\n',
} as const;

/**
 * Application headers, minus the ones that describe the TCP exchange rather than the response.
 *
 * `date` legitimately differs between two requests; `connection` / `keep-alive` are socket
 * management. Everything else — `content-type`, `content-length`, `etag`, `vary` and the CORS
 * headers — is part of what a caller can observe, so a non-disclosure comparison must include
 * it.
 */
function applicationHeaders(response: Response): Record<string, string> {
  const record = comparableHeaders(response);
  delete record['connection'];
  delete record['keep-alive'];
  return record;
}

describe('POST /api/ai/suggest — the 404 is the same response as §17.4', () => {
  it('matches GET /api/documents/:id for an unknown document and for no membership', async () => {
    const provider = createServerAiProviderFromEnv({ AI_PROVIDER: 'stub' });
    assert.ok(provider !== null);
    const harness = await newHarness(provider);
    const ada = await bootstrapSession(harness, 'demo-ada');
    // `demo-grace` may read `demo-document` but has no membership on `demo-private-notes`.
    const grace = await bootstrapSession(harness, 'demo-grace');

    interface Snapshot {
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: string;
    }

    const snapshot = async (response: Response): Promise<Snapshot> => ({
      status: response.status,
      headers: applicationHeaders(response),
      body: await response.text(),
    });

    const ai = {
      unknown: await snapshot(
        await postSuggest(harness, ada, { ...VALID_BODY, documentId: 'no-such-document' }),
      ),
      noMembership: await snapshot(
        await postSuggest(harness, grace, { ...VALID_BODY, documentId: 'demo-private-notes' }),
      ),
    };
    const read = {
      unknown: await snapshot(
        await harness.request('/api/documents/no-such-document', { headers: { cookie: ada } }),
      ),
      noMembership: await snapshot(
        await harness.request('/api/documents/demo-private-notes', { headers: { cookie: grace } }),
      ),
    };

    // One response for all four caller/endpoint states: status, body and observable headers.
    for (const [label, response] of Object.entries({ ...ai, ...read })) {
      assert.equal(response.status, 404, label);
      assert.equal(response.body, '{"error":"not_found"}', label);
      assert.equal(response.headers['content-type'], 'application/json; charset=utf-8', label);
      assert.equal(response.headers['set-cookie'], undefined, label);
      assert.ok(!response.body.includes('operations'), label);
      assert.ok(!response.body.includes('summary'), label);
    }
    assert.deepEqual(ai.unknown, ai.noMembership);
    assert.deepEqual(ai.unknown, read.unknown);
    assert.deepEqual(ai.unknown, read.noMembership);
  });
});

describe('POST /api/ai/suggest — no server-side document content source', () => {
  it('forwards exactly the submitted content, for a readable document id', async () => {
    const calls: ServerAiSuggestInput[] = [];
    const harness = await newHarness({
      async suggest(input: ServerAiSuggestInput) {
        calls.push(input);
        return { summary: 'probe', operations: [{ kind: 'insert', index: 0, text: 'X' }] };
      },
    });
    const ada = await bootstrapSession(harness, 'demo-ada');
    const content = 'CLIENT-SUPPLIED SNAPSHOT — not read from any server-side document';

    const response = await postSuggest(harness, ada, { ...VALID_BODY, content });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ instruction: VALID_BODY.instruction, content }]);
  });

  it('AI server modules import neither the document store, the room registry, the socket nor Yjs', () => {
    // If any of these imports appears, the endpoint has gained a document-content source (a read
    // bypass) or a document-write path (a write bypass). The list is deliberately about imports,
    // not comments: prose may name these modules, code may not depend on them.
    const FORBIDDEN_IMPORTS: ReadonlyArray<readonly [string, RegExp]> = [
      ['yjs', /from\s+['"]yjs['"]/],
      ['persistence', /from\s+['"]\.\.\/persistence\//],
      ['rooms', /from\s+['"]\.\.\/rooms\//],
      ['ws', /from\s+['"]\.\.\/ws\.js['"]/],
      ['app', /from\s+['"]\.\.\/app\.js['"]/],
      [
        'authz internals (only public.js may be imported)',
        /from\s+['"]\.\.\/authz\/(?!public\.js)/,
      ],
    ];
    const MODULES = ['./route.ts', './provider.ts', './openai.ts', './stub.ts', './limits.ts'];

    for (const relative of MODULES) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      for (const [label, pattern] of FORBIDDEN_IMPORTS) {
        assert.ok(
          !pattern.test(source),
          `${relative} must not import ${label}; POST /api/ai/suggest has no document store access`,
        );
      }
    }
  });
});

describe('POST /api/ai/suggest — AI_PROVIDER=stub does not widen the gate', () => {
  it('still requires a session, still requires canRead, and lets a viewer generate', async () => {
    const provider = createServerAiProviderFromEnv({ AI_PROVIDER: 'stub' });
    assert.ok(provider !== null, 'the stub is built without a key');
    const harness = await newHarness(provider);
    const ada = await bootstrapSession(harness, 'demo-ada');
    const grace = await bootstrapSession(harness, 'demo-grace');
    const linus = await bootstrapSession(harness, 'demo-linus'); // viewer on demo-document

    const noSession = await postSuggest(harness, null, VALID_BODY);
    assert.equal(noSession.status, 401);
    assert.equal(await noSession.text(), '{"error":"session_required"}');

    const denied = await postSuggest(harness, grace, {
      ...VALID_BODY,
      documentId: 'demo-private-notes',
    });
    assert.equal(denied.status, 404);
    assert.equal(await denied.text(), '{"error":"not_found"}');

    // Positive control: the owner gets a draft, so the two refusals above are not a broken fixture.
    const owner = await postSuggest(harness, ada, VALID_BODY);
    assert.equal(owner.status, 200);

    // Generation is a read: `canRead` is the only requirement, so a viewer gets a draft.
    const viewer = await postSuggest(harness, linus, VALID_BODY);
    assert.equal(viewer.status, 200);
    const draft = (await viewer.json()) as { model?: string };
    assert.equal(draft.model, 'stub');
  });
});
