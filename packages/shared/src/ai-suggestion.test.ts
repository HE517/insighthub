import { describe, expect, it } from 'vitest';

import { aiEditSuggestionSchema, isSuggestionStale } from './ai-suggestion.js';

const validSuggestion = {
  id: 'sug-1',
  documentId: 'doc-1',
  baseRevision: 7,
  summary: 'Tighten the opening paragraph',
  operations: [{ kind: 'replace' as const, index: 0, length: 12, text: 'InsightHub is' }],
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
      operations: [{ kind: 'insert', index: -1, text: 'x' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty insert payload', () => {
    const parsed = aiEditSuggestionSchema.safeParse({
      ...validSuggestion,
      operations: [{ kind: 'insert', index: 0, text: '' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('flags a suggestion generated against an older revision as stale', () => {
    expect(isSuggestionStale(validSuggestion, 7)).toBe(false);
    expect(isSuggestionStale(validSuggestion, 8)).toBe(true);
  });
});
