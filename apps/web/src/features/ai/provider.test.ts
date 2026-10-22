import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  aiEditSuggestionSchema,
  createOperationAnchor,
  DOCUMENT_TEXT_KEY,
  validateSuggestionAgainstDocument,
  type AiEditSuggestion,
} from '@insighthub/shared';

import { LocalProviderError, createLocalProvider } from './localProvider.js';
import type { AiSuggestInput } from './provider.js';
import { createDocument, docText } from './testSupport.js';

const FIXED_NOW = new Date('2026-10-22T10:00:00.000Z');
const REVISION = 7;

function inputFor(
  doc: Y.Doc,
  instruction: string,
  selection?: { from: number; to: number },
): AiSuggestInput {
  return {
    documentId: 'demo-document',
    instruction,
    text: docText(doc),
    ...(selection === undefined ? {} : { selection }),
    baseRevision: REVISION,
    anchorText: doc.getText(DOCUMENT_TEXT_KEY),
  };
}

/** A suggestion is only usable if it satisfies the frozen schema *and* validates live. */
function expectContractValid(suggestion: AiEditSuggestion, doc: Y.Doc): void {
  expect(() => aiEditSuggestionSchema.parse(suggestion)).not.toThrow();
  expect(validateSuggestionAgainstDocument(suggestion, doc, suggestion.baseRevision)).toMatchObject(
    {
      ok: true,
    },
  );
}

describe('local provider: replace + insert', () => {
  it('uppercases the selection as a replace operation', async () => {
    const doc = createDocument('The quick brown fox');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    const suggestion = await provider.suggest(inputFor(doc, 'uppercase', { from: 4, to: 9 }));

    expect(suggestion.operations).toHaveLength(1);
    const operation = suggestion.operations[0];
    expect(operation.kind).toBe('replace');
    if (operation.kind !== 'replace') throw new Error('unreachable');
    expect(operation).toMatchObject({ index: 4, length: 5, text: 'QUICK' });
    expect(operation.anchor.expectedText).toBe('quick');
    expect(operation.anchor.end).toEqual(expect.any(String));
    expect(suggestion.baseRevision).toBe(REVISION);
    expect(suggestion.status).toBe('pending');
    expect(suggestion.createdAt).toBe(FIXED_NOW.toISOString());
    expect(suggestion.diff).toContain('-The quick brown fox');
    expect(suggestion.diff).toContain('+The QUICK brown fox');
    expectContractValid(suggestion, doc);
  });

  it('adds a task checkbox to every non-blank line as insert operations', async () => {
    const doc = createDocument('alpha\nbeta');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    const suggestion = await provider.suggest(inputFor(doc, 'add-todo'));

    expect(suggestion.operations.map((operation) => operation.kind)).toEqual(['insert', 'insert']);
    expect(suggestion.operations).toMatchObject([
      { index: 0, text: '- [ ] ' },
      { index: 6, text: '- [ ] ' },
    ]);
    // An insert anchor has no `end`; the schema forbids one.
    for (const operation of suggestion.operations) {
      expect(Object.prototype.hasOwnProperty.call(operation.anchor, 'end')).toBe(false);
      expect(operation.anchor.expectedText).toBe('');
    }
    expect(suggestion.summary).toContain('2 lines');
    expect(suggestion.diff).toContain('+- [ ] alpha');
    expectContractValid(suggestion, doc);
  });

  it('trims trailing whitespace per line with multiple replace operations', async () => {
    const doc = createDocument('one  \ntwo\nthree\t\n');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    const suggestion = await provider.suggest(inputFor(doc, 'trim-trailing-space'));

    expect(suggestion.operations.map((operation) => operation.kind)).toEqual([
      'replace',
      'replace',
    ]);
    expect(suggestion.operations).toMatchObject([
      { index: 3, length: 2, text: '' },
      { index: 15, length: 1, text: '' },
    ]);
    expect(suggestion.summary).toContain('2 lines');
    expectContractValid(suggestion, doc);
  });

  it('trims the final line when the document does not end with a newline', async () => {
    const doc = createDocument('alpha  ');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    const suggestion = await provider.suggest(inputFor(doc, 'trim-trailing-space'));

    expect(suggestion.operations[0]).toMatchObject({ kind: 'replace', index: 5, length: 2 });
    expectContractValid(suggestion, doc);
  });

  it('refuses to trim whitespace that is not at the end of its line', async () => {
    const doc = createDocument('alpha  beta');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    // The selection stops right after the spaces, but the line continues: trimming there would
    // edit text the user did not select, so the provider reports `no-change` instead.
    await expect(
      provider.suggest(inputFor(doc, 'trim-trailing-space', { from: 0, to: 7 })),
    ).rejects.toMatchObject({ kind: 'no-change' });
  });

  it('replaces and deletes the selection', async () => {
    const doc = createDocument('hello world');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    const replaced = await provider.suggest(
      inputFor(doc, 'replace-selection: goodbye', { from: 0, to: 5 }),
    );
    expect(replaced.operations[0]).toMatchObject({
      kind: 'replace',
      index: 0,
      length: 5,
      text: 'goodbye',
    });
    expectContractValid(replaced, doc);

    const deleted = await provider.suggest(inputFor(doc, 'delete-selection', { from: 5, to: 11 }));
    expect(deleted.operations[0]).toMatchObject({ kind: 'replace', index: 5, length: 6, text: '' });
    expectContractValid(deleted, doc);
  });
});

describe('local provider: anchors are minted by createOperationAnchor', () => {
  it('recomputes the identical encoded anchor from the same Y.Text', async () => {
    const doc = createDocument('The quick brown fox');
    const text = doc.getText(DOCUMENT_TEXT_KEY);
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    const suggestion = await provider.suggest(inputFor(doc, 'uppercase', { from: 4, to: 9 }));
    const operation = suggestion.operations[0];
    if (operation.kind !== 'replace') throw new Error('unreachable');

    // Same helper, same live Y.Text → byte-identical RelativePosition JSON. A hand-written anchor
    // could not satisfy this.
    const recomputed = createOperationAnchor(text, { index: 4, length: 5 });
    expect(operation.anchor.start).toBe(recomputed.start);
    expect(operation.anchor.end).toBe(recomputed.end);
  });
});

describe('local provider: determinism', () => {
  it('produces byte-identical suggestions for the same input and clock', async () => {
    const doc = createDocument('alpha\nbeta');
    const provider = createLocalProvider({ now: () => FIXED_NOW });
    const input = inputFor(doc, 'add-todo');

    const first = await provider.suggest(input);
    const second = await provider.suggest(input);

    expect(second).toEqual(first);
    expect(second.diff).toBe(first.diff);
    expect(second.id).toBe(first.id);
  });

  it('keeps the edit deterministic with the real clock, and only createdAt differs', async () => {
    const doc = createDocument('The quick brown fox');
    const provider = createLocalProvider();

    const first = await provider.suggest(inputFor(doc, 'uppercase'));
    const second = await provider.suggest(inputFor(doc, 'uppercase'));

    expect(second.id).toBe(first.id);
    expect(second.operations).toEqual(first.operations);
    expect(second.diff).toBe(first.diff);
    expect(second.summary).toBe(first.summary);
  });

  it('derives a different id for a different request', async () => {
    const doc = createDocument('mixed CASE');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    const first = await provider.suggest(inputFor(doc, 'uppercase'));
    const second = await provider.suggest(inputFor(doc, 'add-todo'));

    expect(first.id).not.toBe(second.id);
  });
});

describe('local provider: refuses to invent a suggestion', () => {
  it('throws a typed error for an unknown instruction', async () => {
    const doc = createDocument('some text');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    const attempt = provider.suggest(inputFor(doc, 'make it sound smarter'));
    await expect(attempt).rejects.toBeInstanceOf(LocalProviderError);
    await expect(attempt).rejects.toMatchObject({ kind: 'unknown-instruction' });
    await expect(attempt).rejects.toThrow(/Supported: uppercase/);
  });

  it('throws instead of proposing a no-op edit', async () => {
    const doc = createDocument('ALREADY UPPER');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    await expect(provider.suggest(inputFor(doc, 'uppercase'))).rejects.toMatchObject({
      kind: 'no-change',
    });
  });

  it('rejects a selection outside the document', async () => {
    const doc = createDocument('short');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    await expect(
      provider.suggest(inputFor(doc, 'uppercase', { from: 2, to: 99 })),
    ).rejects.toMatchObject({ kind: 'invalid-selection' });
  });

  it('rejects an instruction that needs a selection without one', async () => {
    const doc = createDocument('short');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    await expect(provider.suggest(inputFor(doc, 'delete-selection'))).rejects.toMatchObject({
      kind: 'selection-required',
    });
  });

  it('refuses a text snapshot that does not match the live anchor text', async () => {
    const doc = createDocument('live text');
    const provider = createLocalProvider({ now: () => FIXED_NOW });

    await expect(
      provider.suggest({ ...inputFor(doc, 'add-todo'), text: 'a stale snapshot' }),
    ).rejects.toThrow(/stale snapshot/);
  });

  it('honours an already-aborted signal before doing any work', async () => {
    const doc = createDocument('some text');
    const provider = createLocalProvider({ now: () => FIXED_NOW });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.suggest({ ...inputFor(doc, 'uppercase'), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
