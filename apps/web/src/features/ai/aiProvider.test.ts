import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DOCUMENT_TEXT_KEY } from '@insighthub/shared';

import { createAiProvider, readAiProviderMode } from './aiProvider.js';
import { createLocalProvider } from './localProvider.js';
import type { AiSuggestInput } from './provider.js';
import { createRemoteProvider } from './remoteProvider.js';
import { createDocument, docText } from './testSupport.js';

const FIXED_NOW = new Date('2026-10-22T10:00:00.000Z');
const REVISION = 7;

const VALID_DRAFT = {
  summary: 'Uppercase the document',
  operations: [{ kind: 'replace', index: 0, length: 5, text: 'ALPHA' }],
};

function inputFor(doc: ReturnType<typeof createDocument>): AiSuggestInput {
  return {
    documentId: 'demo-document',
    instruction: 'uppercase',
    text: docText(doc),
    baseRevision: REVISION,
    anchorText: doc.getText(DOCUMENT_TEXT_KEY),
  };
}

/** A `fetch` double; the factory test only needs to know whether it was called. */
function fakeFetchBody(): {
  fetchImpl: typeof fetch;
  calls: number;
} {
  const state = { fetchImpl: undefined as unknown as typeof fetch, calls: 0 };
  state.fetchImpl = (async (): Promise<Response> => {
    state.calls += 1;
    return new Response(JSON.stringify(VALID_DRAFT), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return state;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readAiProviderMode', () => {
  it('defaults to local when the variable is absent or empty', () => {
    expect(readAiProviderMode({})).toBe('local');
    expect(readAiProviderMode({ VITE_AI_PROVIDER: '' })).toBe('local');
  });

  it('selects remote only for the exact literal "remote"', () => {
    expect(readAiProviderMode({ VITE_AI_PROVIDER: 'remote' })).toBe('remote');
    expect(readAiProviderMode({ VITE_AI_PROVIDER: 'REMOTE' })).toBe('local');
    expect(readAiProviderMode({ VITE_AI_PROVIDER: 'local' })).toBe('local');
    expect(readAiProviderMode({ VITE_AI_PROVIDER: 'openai' })).toBe('local');
  });

  it('reads the real import.meta.env through a stub, without touching global env', () => {
    vi.stubEnv('VITE_AI_PROVIDER', 'remote');
    expect(readAiProviderMode()).toBe('remote');
    vi.stubEnv('VITE_AI_PROVIDER', 'local');
    expect(readAiProviderMode()).toBe('local');
  });
});

describe('createAiProvider', () => {
  it('returns the deterministic local provider by default (no network)', async () => {
    vi.stubEnv('VITE_AI_PROVIDER', '');
    const doc = createDocument('alpha');
    const provider = createAiProvider({ now: () => FIXED_NOW });

    const suggestion = await provider.suggest(inputFor(doc));

    expect(suggestion.id).toMatch(/^local-/);
    expect(suggestion.summary).toBe('Uppercase the document');
    expect(docText(doc)).toBe('alpha');
  });

  it('returns the remote provider when VITE_AI_PROVIDER=remote', async () => {
    vi.stubEnv('VITE_AI_PROVIDER', 'remote');
    const doc = createDocument('alpha');
    const fake = fakeFetchBody();
    const provider = createAiProvider({
      endpoint: '/test/ai',
      fetchImpl: fake.fetchImpl,
      now: () => FIXED_NOW,
    });

    const suggestion = await provider.suggest(inputFor(doc));

    expect(fake.calls).toBe(1);
    expect(suggestion.id).toMatch(/^remote-/);
    expect(suggestion.baseRevision).toBe(REVISION);
  });

  it('treats an unknown value as local instead of guessing an endpoint', async () => {
    vi.stubEnv('VITE_AI_PROVIDER', 'openai');
    const doc = createDocument('alpha');
    const provider = createAiProvider({ now: () => FIXED_NOW });

    await expect(provider.suggest(inputFor(doc))).resolves.toMatchObject({
      id: expect.stringMatching(/^local-/),
    });
  });

  it('builds exactly what the two underlying factories build', () => {
    expect(typeof createLocalProvider).toBe('function');
    expect(typeof createRemoteProvider).toBe('function');
    expect(createAiProvider({ mode: 'local' })).toMatchObject({ suggest: expect.any(Function) });
    expect(createAiProvider({ mode: 'remote' })).toMatchObject({ suggest: expect.any(Function) });
  });
});

describe('browser-side credential hygiene', () => {
  const AI_MODULES = [
    './remoteProvider.ts',
    './aiProvider.ts',
    '../editor/AiSuggestPanel.tsx',
    '../editor/aiProposalCopy.ts',
  ];
  const FORBIDDEN = [
    /OPENAI_API_KEY/i,
    /VITE_OPENAI/i,
    /api\.openai\.com/i,
    /\bAuthorization\b/,
    /\bBearer\s+\S/,
  ];

  it('never reads a provider key or calls OpenAI from the browser AI surface', () => {
    for (const relative of AI_MODULES) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      for (const pattern of FORBIDDEN) {
        expect(source, `${relative} must not match ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it('keeps the remote provider free of React/Redux state', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./remoteProvider.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/\buseState\b|\buseReducer\b|\bdispatch\(/);
    expect(source).not.toMatch(/from '[^']*(store|redux)/i);
  });
});
