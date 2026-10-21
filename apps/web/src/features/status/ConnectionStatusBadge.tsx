/**
 * Connection / offline affordances.
 *
 * Two rules from the frozen contract shape this file:
 *
 * - **Offline is a normal state, not an error path** (`AGENTS.md` R10). The
 *   notice says so, and the editor stays editable; nothing here disables input.
 * - **The network never gates the editor** (`docs/CONTRACTS.md` §10.1). Local
 *   state makes a session `active`, so a session is fully usable with the socket
 *   down. Everything rendered here is informational.
 *
 * All policy lives in `connectionPresentation.ts`; this file only renders it.
 *
 * ## Contract surfaces
 *
 * `[data-testid="connection-status"]` is rendered **exactly once** (the document header) and
 * carries `data-status`, whose value must stay inside the shared `ConnectionStatus` union —
 * three browser suites read it (`tests/browser/lib/app.mjs` `readConnectionStatus`). The
 * visible label and the dot are decoration around that attribute; the description is the
 * native `title`, so the pill stays small.
 *
 * The badge was previously an Ant Design `Badge` + `Tooltip`. It is plain markup now so the
 * pill's size/colour are owned by the single `:root` theme in `styles.css` rather than by a
 * component library's defaults. No behaviour moved.
 */
import type { ConnectionStatus } from '@insighthub/shared';

import { CONNECTION_PRESENTATION, offlineNoticeText } from './connectionPresentation.js';

export interface ConnectionStatusBadgeProps {
  status: ConnectionStatus;
  /** Replaces the default description in the tooltip when supplied. */
  detail?: string;
}

export function ConnectionStatusBadge({ status, detail }: ConnectionStatusBadgeProps) {
  const presentation = CONNECTION_PRESENTATION[status];

  return (
    <span
      className="conn-pill"
      data-testid="connection-status"
      data-status={status}
      title={detail ?? presentation.description}
    >
      <span className="conn-pill__dot" aria-hidden="true" />
      <span className="conn-pill__label">{presentation.label}</span>
    </span>
  );
}

/**
 * The standalone offline notice.
 *
 * Rendered only for statuses where the user's edits exist locally but are not yet
 * shared, so the message is never a lie about durability.
 */
export function OfflineNotice({ status }: { status: ConnectionStatus }) {
  const text = offlineNoticeText(status);
  if (text === null) return null;

  return (
    <div className="offline-notice" data-testid="offline-notice" role="status">
      <span>{text}</span>
    </div>
  );
}
