/**
 * Tests for the pure collaborator-display helpers.
 *
 * These run on peer-supplied strings (a collaborator's name), so the edge cases
 * are about not producing nonsense or splitting a character in half.
 */
import { describe, expect, it } from 'vitest';

import { cursorLabel, initialsOf } from './collaboratorPresentation.js';

describe('initialsOf', () => {
  it('returns the first character of a name', () => {
    expect(initialsOf('Ada')).toBe('A');
  });

  it('trims surrounding whitespace', () => {
    expect(initialsOf('  Grace  ')).toBe('G');
  });

  it('falls back to ? for an empty or whitespace-only name', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });

  it('does not split a surrogate pair', () => {
    // A naive `slice(0, 1)` would return half of the emoji.
    expect(initialsOf('🙂 Ada')).toBe('🙂');
    expect(Array.from(initialsOf('🙂 Ada')).length).toBe(1);
  });

  it('handles CJK names', () => {
    expect(initialsOf('张伟')).toBe('张');
  });
});

describe('cursorLabel', () => {
  it('renders a position', () => {
    expect(cursorLabel(12)).toBe('@12');
  });

  it('returns null when there is no cursor, instead of inventing position 0', () => {
    expect(cursorLabel(null)).toBeNull();
  });

  it('returns null for a nonsensical offset rather than rendering it', () => {
    expect(cursorLabel(-1)).toBeNull();
    expect(cursorLabel(Number.NaN)).toBeNull();
    expect(cursorLabel(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('truncates a fractional offset', () => {
    expect(cursorLabel(3.7)).toBe('@3');
  });
});
