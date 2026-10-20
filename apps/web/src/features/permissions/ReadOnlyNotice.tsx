/**
 * The visible read-only notice.
 *
 * Rendered next to the editor (not in the header) so the explanation is adjacent to the
 * surface that ignores keystrokes. All wording and the show/hide decision live in
 * `readOnlyNoticeCopy.ts`; this file only renders it, the same split `ConnectionStatusBadge.tsx`
 * uses for `connectionPresentation.ts`.
 *
 * The file is `<Component>.tsx` while the copy is `<lowerCamel>Copy.ts` on purpose: TypeScript's
 * module resolution is case-insensitive on Windows, and `readOnlyNotice.ts` vs
 * `ReadOnlyNotice.tsx` would collide (`TS1149`) — which is exactly how a second copy of the
 * wording would sneak in.
 *
 * Plain elements, no Ant Design: the notice is asserted through `renderToStaticMarkup` in a
 * Node test environment, and a component that renders nothing but HTML keeps that assertion
 * about *our* copy instead of about a UI library's server rendering.
 *
 * It is an **informational** affordance. It does not and cannot stop a write — the server
 * rejects unauthorised mutations before apply/persist/broadcast (`docs/CONTRACTS.md` §17.5),
 * and `docs/ARCHITECTURE.md` §8.2 keeps the browser out of the security boundary.
 */
import type { CapabilityGate } from './capabilityGate.js';
import { READ_ONLY_NOTICE_TESTID, readOnlyNoticeFor } from './readOnlyNoticeCopy.js';

export interface ReadOnlyNoticeProps {
  /** The gate the editor is rendered from; the notice is derived from it, never re-derived. */
  gate: CapabilityGate;
}

export function ReadOnlyNotice({ gate }: ReadOnlyNoticeProps) {
  const model = readOnlyNoticeFor(gate);
  if (model === null) return null;

  return (
    <div className="read-only-notice" data-testid={READ_ONLY_NOTICE_TESTID} role="status">
      <strong className="read-only-notice__title">{model.title}</strong>
      <span className="read-only-notice__detail">{model.detail}</span>
    </div>
  );
}
