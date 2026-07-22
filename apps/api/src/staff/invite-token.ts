import { createHash, randomBytes } from 'node:crypto';

/**
 * The Invite token: 256 bits of CSPRNG output, base64url so it survives a URL
 * without escaping (#57, ADR-0033).
 *
 * 32 bytes because the token IS the authentication - whoever presents it becomes
 * a staff member of somebody's Tenant, so it has to be unguessable in the same
 * way a session token is, not merely inconvenient to type.
 */
const TOKEN_BYTES = 32;

/** How long an invite stays live. Long enough to survive a weekend and an
 * inbox, short enough that a forwarded link found a year later is dead. */
export const INVITE_TTL_DAYS = 7;

export function mintInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * What the database stores. SHA-256, deliberately NOT bcrypt.
 *
 * bcrypt exists to make LOW-entropy secrets (a password a human chose)
 * expensive to guess. This secret has 256 bits of entropy, so there is nothing
 * to slow down: an attacker who cannot guess the token cannot guess it any
 * better against a fast hash. What hashing buys here is the other property -
 * a leaked database dump is a list of hashes, not a list of usable invite links.
 *
 * A key-stretching hash would also make the ACCEPT path pay ~300 ms on a value
 * that is looked up by equality, which is the wrong cost in the wrong place.
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Where the email points. Built from the trusted `WEB_BASE_URL` origin, never
 * from a request Host - the same rule #127 established for OG canonical URLs:
 * a link we mint and email must not be steerable by whoever triggered it. */
export function inviteAcceptUrl(webBaseUrl: string, token: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/invite/${token}`;
}
