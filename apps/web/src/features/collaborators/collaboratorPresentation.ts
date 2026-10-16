/**
 * Pure display helpers for the collaborator UI.
 *
 * Split out of the component so the rules can be unit-tested without a DOM, and
 * so the file that renders peer-supplied strings stays trivially reviewable.
 */

/**
 * First visible character of a name, for an avatar glyph.
 *
 * `Array.from` iterates code points rather than UTF-16 units, so an emoji or a
 * CJK character is not split in half the way `name.slice(0, 1)` would split a
 * surrogate pair.
 */
export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  return Array.from(trimmed)[0] ?? '?';
}

/**
 * A short, stable label for a cursor position, e.g. `@12`.
 *
 * `null` for a collaborator who has published no cursor yet — the UI shows "no
 * cursor" rather than inventing position 0, which would be a lie about another
 * user's caret.
 */
export function cursorLabel(head: number | null): string | null {
  if (head === null || !Number.isFinite(head) || head < 0) return null;
  return `@${Math.trunc(head)}`;
}
