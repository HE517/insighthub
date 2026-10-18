/**
 * Opaque session token minting.
 *
 * ## Why 32 bytes and not 16
 *
 * `docs/CONTRACTS.md` §17.2 requires **at least** 128 bits from a CSPRNG. This module
 * mints 256. The extra 128 bits cost 11 characters of cookie and buy margin against the
 * birthday bound in a process-scoped store that never reuses a token; there is no
 * interoperability reason to sit exactly on the floor.
 *
 * ## Why base64url and no claims
 *
 * The token is **opaque** (§17.2): it carries no user id, no expiry and no signature. Two
 * reasons, and both matter:
 *
 * 1. A token that encodes identity invites a reader to parse it — and a parser is a place
 *    to make an authorization decision from attacker-controlled bytes. Here the only
 *    legal use of the string is a map lookup.
 * 2. Stateless/signed tokens would be a *durable* session, which §17.2 and §17.7 exclude;
 *    process-scoped memory is the stated limitation, not an accident.
 *
 * `base64url` keeps the value cookie-safe without percent-encoding, so the value a client
 * sends back is byte-identical to the value issued.
 */
import { randomBytes } from 'node:crypto';

/** 256 bits from the CSPRNG (the contract floor is 128). */
export const SESSION_TOKEN_ENTROPY_BYTES = 32;

/**
 * Length of a base64url encoding of `SESSION_TOKEN_ENTROPY_BYTES`, without padding.
 *
 * `ceil(32 / 3) * 4 - 1 = 43`. Exported so the cookie reader and the tests share one
 * definition instead of hardcoding 43 in three places.
 */
export const SESSION_TOKEN_LENGTH = 43;

/** Mint a fresh opaque session token. */
export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_ENTROPY_BYTES).toString('base64url');
}

/**
 * True when `value` has the exact shape this module mints.
 *
 * Used to reject junk cookie values **before** touching the session map. It is not a
 * security check — an attacker cannot forge a token by matching a regex; the rejection
 * only avoids pointless lookups and keeps the map's key space to well-formed strings.
 */
export function isWellFormedSessionToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === SESSION_TOKEN_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}
