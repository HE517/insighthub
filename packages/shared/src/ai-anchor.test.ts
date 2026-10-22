import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import {
  createOperationAnchor,
  decodeRelativePosition,
  encodeRelativePosition,
  validateSuggestionAgainstDocument,
  type ResolvedRange,
  type ValidationResult,
} from './ai-anchor.js';
import type {
  AiEditOperation,
  AiEditSuggestion,
  AiInsertOperation,
  AiReplaceOperation,
} from './ai-suggestion.js';
import { DOCUMENT_TEXT_KEY, TRANSACTION_ORIGINS } from './binary-frame.js';
import { SHARED_CONTRACT_VERSION } from './index.js';
import { PROTOCOL_VERSION } from './protocol.js';

const BASE = 'The quick brown fox';
const REVISION = 1;

let nextClientId = 100_000;

function seed(): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = nextClientId++;
  doc.getText(DOCUMENT_TEXT_KEY).insert(0, BASE);
  return doc;
}

/** A second replica of `source`, as another browser client would have. */
function replicaOf(source: Y.Doc): Y.Doc {
  const replica = new Y.Doc();
  replica.clientID = nextClientId++;
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(source), TRANSACTION_ORIGINS.remote);
  return replica;
}

/** Copy the missing part of `from` into `into`, with the remote origin. */
function merge(from: Y.Doc, into: Y.Doc): void {
  Y.applyUpdate(
    into,
    Y.encodeStateAsUpdate(from, Y.encodeStateVector(into)),
    TRANSACTION_ORIGINS.remote,
  );
}

function replaceOp(
  text: Y.Text,
  index: number,
  length: number,
  replacement: string,
): AiReplaceOperation {
  return {
    kind: 'replace',
    index,
    length,
    text: replacement,
    anchor: createOperationAnchor(text, { index, length }),
  };
}

function insertOp(text: Y.Text, index: number, inserted: string): AiInsertOperation {
  return {
    kind: 'insert',
    index,
    text: inserted,
    anchor: createOperationAnchor(text, { index }),
  };
}

function suggestionWith(operations: AiEditOperation[], baseRevision = REVISION): AiEditSuggestion {
  return {
    id: 'sug-1',
    documentId: 'doc-1',
    baseRevision,
    summary: 'test suggestion',
    operations,
    diff: '--- a\n+++ b\n',
    status: 'pending',
    createdAt: '2026-10-22T00:00:00.000Z',
  };
}

/** Resolve an encoded anchor against `doc`; `null` means unresolvable. */
function absoluteIndex(doc: Y.Doc, encoded: string): number | null {
  const position = decodeRelativePosition(encoded);
  if (position === null) return null;
  return Y.createAbsolutePositionFromRelativePosition(position, doc)?.index ?? null;
}

function validate(suggestion: AiEditSuggestion, doc: Y.Doc, revision = REVISION): ValidationResult {
  return validateSuggestionAgainstDocument(suggestion, doc, revision);
}

describe('relative position encoding (JSON, not a second binary convention)', () => {
  it('round-trips through Yjs own JSON form', () => {
    const doc = seed();
    const text = doc.getText(DOCUMENT_TEXT_KEY);
    const position = Y.createRelativePositionFromTypeIndex(text, 4, 0);

    const encoded = encodeRelativePosition(position);

    expect(typeof encoded).toBe('string');
    // Exactly Yjs's JSON: a future reader can reproduce the anchor with
    // `Y.createRelativePositionFromJSON`, which is what decode uses.
    expect(JSON.parse(encoded)).toEqual(Y.relativePositionToJSON(position));

    const decoded = decodeRelativePosition(encoded);
    expect(decoded).not.toBeNull();
    expect(Y.createAbsolutePositionFromRelativePosition(decoded!, doc)?.index).toBe(4);
  });

  it('returns null for malformed encodings instead of throwing', () => {
    const malformed = [
      '', // empty
      'not json', // not JSON
      'null', // JSON, but not an object
      '[]',
      '42',
      '{}', // no item / tname / type
      '{"assoc":0}', // same, with only the association
      '{"tname":""}', // empty root name
      '{"tname":42}', // wrong type
      '{"item":{"client":1}}', // incomplete ID
      '{"item":{"client":"1","clock":0}}', // wrong ID field type
      '{"item":{"client":1,"clock":-1}}', // negative clock
      '{"tname":"content","assoc":1.5}', // fractional association
    ];

    for (const value of malformed) {
      expect(() => decodeRelativePosition(value), value).not.toThrow();
      expect(decodeRelativePosition(value), value).toBeNull();
    }
  });
});

describe('createOperationAnchor', () => {
  it('captures a replace range: start, end and the exact expectedText', () => {
    const doc = seed();
    const text = doc.getText(DOCUMENT_TEXT_KEY);

    const anchor = createOperationAnchor(text, { index: 4, length: 5 });

    expect(anchor.expectedText).toBe('quick');
    expect(anchor.end).toBeDefined();
    expect(absoluteIndex(doc, anchor.start)).toBe(4);
    expect(absoluteIndex(doc, anchor.end!)).toBe(9);
  });

  it('captures an insert as a zero-length anchor with no end', () => {
    const doc = seed();
    const text = doc.getText(DOCUMENT_TEXT_KEY);

    const anchor = createOperationAnchor(text, { index: 4 });

    expect(anchor.expectedText).toBe('');
    expect('end' in anchor).toBe(false);
    expect(absoluteIndex(doc, anchor.start)).toBe(4);
  });

  it('rejects a range outside the document instead of inventing an anchor', () => {
    const doc = seed();
    const text = doc.getText(DOCUMENT_TEXT_KEY);

    expect(() => createOperationAnchor(text, { index: 999 })).toThrow(RangeError);
    expect(() => createOperationAnchor(text, { index: 20, length: 1 })).toThrow(RangeError);
    expect(() => createOperationAnchor(text, { index: 0, length: -1 })).toThrow(RangeError);
  });
});

describe('validateSuggestionAgainstDocument — three-stage check', () => {
  it('accepts an unchanged document and returns ranges 1:1 with operations', () => {
    const doc = seed();
    const text = doc.getText(DOCUMENT_TEXT_KEY);
    const suggestion = suggestionWith([
      replaceOp(text, 4, 5, 'slow'),
      insertOp(text, 0, 'Intro: '),
    ]);

    expect(validate(suggestion, doc)).toEqual({
      ok: true,
      ranges: [
        { index: 4, length: 5 },
        { index: 0, length: 0 },
      ] satisfies ResolvedRange[],
    });
  });

  it('follows a concurrent insertion before the range (anchor moves, text still matches)', () => {
    const local = seed();
    const remote = replicaOf(local);
    const suggestion = suggestionWith([replaceOp(local.getText(DOCUMENT_TEXT_KEY), 4, 5, 'slow')]);

    remote.transact(() => {
      remote.getText(DOCUMENT_TEXT_KEY).insert(0, 'PREFIX ');
    }, TRANSACTION_ORIGINS.remote);
    merge(remote, local);

    expect(local.getText(DOCUMENT_TEXT_KEY).toString()).toBe(`PREFIX ${BASE}`);
    // "quick" moved right by the seven characters inserted in front of it.
    expect(validate(suggestion, local)).toEqual({
      ok: true,
      ranges: [{ index: 11, length: 5 }],
    });
  });

  it('follows a concurrent insertion exactly at the start boundary', () => {
    const local = seed();
    const remote = replicaOf(local);
    const suggestion = suggestionWith([replaceOp(local.getText(DOCUMENT_TEXT_KEY), 4, 5, 'slow')]);

    remote.transact(() => {
      // Insert between "The " and "quick": the insertion is *outside* the range.
      remote.getText(DOCUMENT_TEXT_KEY).insert(4, 'XX');
    }, TRANSACTION_ORIGINS.remote);
    merge(remote, local);

    expect(local.getText(DOCUMENT_TEXT_KEY).toString()).toBe('The XXquick brown fox');
    expect(validate(suggestion, local)).toEqual({
      ok: true,
      ranges: [{ index: 6, length: 5 }],
    });
  });

  it('does not absorb a concurrent insertion exactly at the end boundary', () => {
    const local = seed();
    const remote = replicaOf(local);
    const suggestion = suggestionWith([replaceOp(local.getText(DOCUMENT_TEXT_KEY), 4, 5, 'slow')]);

    remote.transact(() => {
      // Insert between "quick" and " brown": text after the range must not join it.
      remote.getText(DOCUMENT_TEXT_KEY).insert(9, 'YY');
    }, TRANSACTION_ORIGINS.remote);
    merge(remote, local);

    expect(local.getText(DOCUMENT_TEXT_KEY).toString()).toBe('The quickYY brown fox');
    expect(validate(suggestion, local)).toEqual({
      ok: true,
      ranges: [{ index: 4, length: 5 }],
    });
  });

  it('returns text-mismatch for a deleted range, and proves the anchor still resolves', () => {
    const local = seed();
    const remote = replicaOf(local);
    const suggestion = suggestionWith([replaceOp(local.getText(DOCUMENT_TEXT_KEY), 4, 5, 'slow')]);
    const operation = suggestion.operations[0];
    expect(operation.kind).toBe('replace');
    const anchor = (operation as AiReplaceOperation).anchor;

    remote.transact(() => {
      remote.getText(DOCUMENT_TEXT_KEY).delete(4, 5);
    }, TRANSACTION_ORIGINS.remote);
    merge(remote, local);

    expect(local.getText(DOCUMENT_TEXT_KEY).toString()).toBe('The  brown fox');

    // The mechanism RelativePosition alone cannot catch: Yjs keeps a deleted
    // position resolvable and maps it to the neighbouring index. Both anchors
    // still resolve to 4, so `anchor-unresolved` is NOT what rejects this.
    expect(absoluteIndex(local, anchor.start)).toBe(4);
    expect(absoluteIndex(local, anchor.end!)).toBe(4);

    // The exact-compare stage is the only thing that notices the text is gone.
    expect(validate(suggestion, local)).toEqual({ ok: false, reason: 'text-mismatch' });
  });

  it('returns text-mismatch when the region was replaced with different text', () => {
    const local = seed();
    const remote = replicaOf(local);
    const suggestion = suggestionWith([replaceOp(local.getText(DOCUMENT_TEXT_KEY), 4, 5, 'slow')]);

    remote.transact(() => {
      const text = remote.getText(DOCUMENT_TEXT_KEY);
      text.delete(4, 5);
      text.insert(4, 'slow!');
    }, TRANSACTION_ORIGINS.remote);
    merge(remote, local);

    expect(local.getText(DOCUMENT_TEXT_KEY).toString()).toBe('The slow! brown fox');
    expect(validate(suggestion, local)).toEqual({ ok: false, reason: 'text-mismatch' });
  });

  it('reports revision before any anchor work, even for a malformed anchor', () => {
    const doc = seed();
    const text = doc.getText(DOCUMENT_TEXT_KEY);
    const valid = replaceOp(text, 4, 5, 'slow');
    const malformed: AiEditOperation = {
      ...valid,
      anchor: {
        start: 'not-json',
        end: 'also-not-json',
        expectedText: 'quick',
      },
    };
    const suggestion = suggestionWith([malformed], REVISION);

    // The document moved on (revision 2), so the reason is `revision` — the
    // malformed anchor is never decoded.
    expect(validate(suggestion, doc, REVISION + 1)).toEqual({ ok: false, reason: 'revision' });
  });

  it('returns malformed for unusable anchors without throwing', () => {
    const doc = seed();
    const text = doc.getText(DOCUMENT_TEXT_KEY);
    const valid = createOperationAnchor(text, { index: 4, length: 5 });

    const anchors: Array<[label: string, anchor: unknown]> = [
      ['not JSON', { ...valid, start: 'not json' }],
      ['missing start', { end: valid.end, expectedText: valid.expectedText }],
      ['missing expectedText', { start: valid.start, end: valid.end }],
      ['missing end on replace', { start: valid.start, expectedText: valid.expectedText }],
      ['empty start', { ...valid, start: '' }],
    ];

    for (const [label, anchor] of anchors) {
      const operation = {
        kind: 'replace',
        index: 4,
        length: 5,
        text: 'slow',
        anchor,
      } as unknown as AiEditOperation;
      const suggestion = suggestionWith([operation]);

      expect(() => validate(suggestion, doc), label).not.toThrow();
      expect(validate(suggestion, doc), label).toEqual({ ok: false, reason: 'malformed' });
    }

    const missingAnchor = {
      kind: 'replace',
      index: 4,
      length: 5,
      text: 'slow',
    } as unknown as AiEditOperation;
    expect(validate(suggestionWith([missingAnchor]), doc)).toEqual({
      ok: false,
      reason: 'malformed',
    });

    const insertWithEnd = {
      kind: 'insert',
      index: 4,
      text: 'x',
      anchor: { ...createOperationAnchor(text, { index: 4 }), end: valid.end },
    } as unknown as AiEditOperation;
    expect(validate(suggestionWith([insertWithEnd]), doc)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('returns anchor-unresolved for an anchor from another document', () => {
    const foreign = seed();
    const foreignAnchor = createOperationAnchor(foreign.getText(DOCUMENT_TEXT_KEY), {
      index: 4,
      length: 5,
    });
    const operation = {
      kind: 'replace',
      index: 4,
      length: 5,
      text: 'slow',
      anchor: foreignAnchor,
    } as unknown as AiEditOperation;
    const local = seed();

    expect(validate(suggestionWith([operation]), local)).toEqual({
      ok: false,
      reason: 'anchor-unresolved',
    });
  });

  it('returns anchor-unresolved for an anchor on a different Y.Text in the same doc', () => {
    const doc = seed();
    const other = doc.getText('other');
    other.insert(0, BASE);
    const otherAnchor = createOperationAnchor(other, { index: 4, length: 5 });
    const operation = {
      kind: 'replace',
      index: 4,
      length: 5,
      text: 'slow',
      anchor: otherAnchor,
    } as unknown as AiEditOperation;

    expect(validate(suggestionWith([operation]), doc)).toEqual({
      ok: false,
      reason: 'anchor-unresolved',
    });
  });
});

describe('M3 contract version / wire', () => {
  it('is version 8 while PROTOCOL_VERSION stays 2 (no wire change)', () => {
    expect(SHARED_CONTRACT_VERSION).toBe(8);
    expect(PROTOCOL_VERSION).toBe(2);
  });
});
