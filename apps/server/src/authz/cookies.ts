/**
 * The session cookie: how a token is carried, and how it is read back.
 *
 * ## One carrier, read one way
 *
 * `docs/CONTRACTS.md` §17.2 makes the cookie the **only** carrier in Phase 2 — no
 * `Authorization` header path. So this module reads exactly one header (`Cookie`) and never
 * looks at `Authorization`, a query parameter or a body field. That is what removes the
 * "which one wins?" question that turns an identity check into an exploitable inconsistency.
 *
 * ## Why the parse is written here instead of importing a package
 *
 * No new production dependency is allowed this round (`AGENTS.md` R3), and the cookie is
 * *written* through Express's own `res.cookie`, so only the 15-line read side has to exist.
 * The parser is deliberately forgiving (a hostile `Cookie` header must never throw — a throw
 * in a request path becomes a 500 for a client that was going to get a 401) and therefore
 * treats anything it does not understand as "no session".
 */

/** Cookie name frozen by §17.2. */
export const SESSION_COOKIE_NAME = 'insighthub_session';

/**
 * Read one cookie value out of a raw `Cookie` header.
 *
 * Returns `null` when the header is absent, when the name is absent, or when the value is
 * empty. The first occurrence wins, matching how browsers order a header they build
 * themselves; a client that sends duplicates is already outside the contract, and picking the
 * first keeps the answer deterministic instead of "whichever the parser felt like".
 */
export function readCookieValue(header: string | undefined, name: string): string | null {
  if (typeof header !== 'string' || header.length === 0) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const candidateName = part.slice(0, separator).trim();
    if (candidateName !== name) continue;
    const rawValue = part.slice(separator + 1).trim();
    if (rawValue.length === 0) return null;
    return decodeCookieValue(rawValue);
  }

  return null;
}

/**
 * Percent-decode a cookie value, tolerating invalid escapes.
 *
 * `decodeURIComponent('%')` throws a `URIError`. That must not become a request failure: a
 * malformed cookie is indistinguishable from no cookie, from the caller's point of view —
 * both mean "no session", i.e. `401`.
 */
function decodeCookieValue(rawValue: string): string {
  // Strip a surrounding quoted pair (`Cookie: name="value"` is legal), then decode.
  const unquoted =
    rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1)
      : rawValue;
  try {
    return decodeURIComponent(unquoted);
  } catch {
    return unquoted;
  }
}

/** Read the session token out of a `Cookie` header (or `null`). */
export function readSessionCookie(header: string | undefined): string | null {
  return readCookieValue(header, SESSION_COOKIE_NAME);
}
