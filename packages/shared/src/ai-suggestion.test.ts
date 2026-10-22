import { describe, expect, it } from 'vitest';

import {
  aiEditOperationSchema,
  aiEditSuggestionSchema,
  aiOperationAnchorSchema,
  isSuggestionStale,
} from './ai-suggestion.js';

/** A structurally valid anchor; the strings are opaque to the schema. */
const validReplaceAnchor = {
  start: '{"tname":"content","assoc":0}',
  end: '{"tname":"content","assoc":-1}',
  expectedText: 'Hello world!',
};

const validInsertAnchor = {
  start: '{"tname":"content","assoc":0}',
  expectedText: '',
};

const validSuggestion = {
  id: 'sug-1',
  documentId: 'doc-1',
  baseRevision: 7,
  summary: 'Tighten the opening paragraph',
  operations: [
    {
      kind: 'replace' as const,
      index: 0,
      length: 12,
      text: 'InsightHub is',
      anchor: validReplaceAnchor,
    },
  ],
  diff: '--- a\n+++ b\n',
  status: 'pending' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ai edit suggestion contract', () => {
  it('accepts a well-formed suggestion', () => {
    const parsed = aiEditSuggestionSchema.safeParse(validSuggestion);
    expect(parsed.success).toBe(true);
  });

  it('requires at least one operation', () => {
    const parsed = aiEditSuggestionSchema.safeParse({ ...validSuggestion, operations: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative offset', () => {
    const parsed = aiEditSuggestionSchema.safeParse({
      ...validSuggestion,
      operations: [{ kind: 'insert', index: -1, text: 'x', anchor: validInsertAnchor }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty insert payload', () => {
    const parsed = aiEditSuggestionSchema.safeParse({
      ...validSuggestion,
      operations: [{ kind: 'insert', index: 0, text: '', anchor: validInsertAnchor }],
    });
    expect(parsed.success).toBe(false);
  });

  it('flags a suggestion generated against an older revision as stale', () => {
    expect(isSuggestionStale(validSuggestion, 7)).toBe(false);
    expect(isSuggestionStale(validSuggestion, 8)).toBe(true);
  });
});

describe('M3 operation anchoring schema (§11.1)', () => {
  it('accepts an anchor with start + expectedText and an optional end', () => {
    expect(aiOperationAnchorSchema.safeParse(validInsertAnchor).success).toBe(true);
    expect(aiOperationAnchorSchema.safeParse(validReplaceAnchor).success).toBe(true);
  });

  it('requires start and expectedText', () => {
    expect(aiOperationAnchorSchema.safeParse({ expectedText: '' }).success).toBe(false);
    expect(aiOperationAnchorSchema.safeParse({ start: 'x' }).success).toBe(false);
    expect(aiOperationAnchorSchema.safeParse({ start: '', expectedText: '' }).success).toBe(false);
  });

  it('requires an anchor on every operation (negative type test)', () => {
    // This is the "required, not optional" rule: an un-anchored operation is not a
    // legal proposal, so it cannot reach the stale-check path by accident.
    expect(
      aiEditOperationSchema.safeParse({
        kind: 'replace',
        index: 0,
        length: 5,
        text: 'x',
      }).success,
    ).toBe(false);
    expect(
      aiEditOperationSchema.safeParse({
        kind: 'insert',
        index: 0,
        text: 'x',
      }).success,
    ).toBe(false);
  });

  it('requires end on a replace', () => {
    expect(
      aiEditOperationSchema.safeParse({
        kind: 'replace',
        index: 0,
        length: 5,
        text: 'x',
        anchor: { start: 'a', expectedText: 'hello' },
      }).success,
    ).toBe(false);
  });

  it('forbids end on an insert instead of silently stripping it', () => {
    // `.strict()` on the insert anchor is what makes this fail: an insert has a
    // zero-length range, so an `end` there is a caller bug, not a field to drop.
    expect(
      aiEditOperationSchema.safeParse({
        kind: 'insert',
        index: 0,
        text: 'x',
        anchor: { start: 'a', end: 'b', expectedText: '' },
      }).success,
    ).toBe(false);
  });

  it('accepts an insert with only start + expectedText', () => {
    expect(
      aiEditOperationSchema.safeParse({
        kind: 'insert',
        index: 0,
        text: 'x',
        anchor: validInsertAnchor,
      }).success,
    ).toBe(true);
  });
});
