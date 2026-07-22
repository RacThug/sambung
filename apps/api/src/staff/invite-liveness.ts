import type { InviteAcceptMode, InviteRefusalReason } from '@sambung/shared';

/**
 * One Invite, as everything outside the database sees it (#57).
 *
 * Carries the three closure timestamps rather than a computed boolean, because
 * "why is this dead" is the answer the invitee needs, and a boolean would throw
 * it away one layer too early.
 */
export interface InviteView {
  id: string;
  tenantId: string;
  tenantName: string;
  email: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitedBy: string;
  propertyNames: string[];
}

/**
 * Is this invite still usable, and if not, why? `null` means live.
 *
 * THE definition, in one place. It used to exist three times - here, inline in
 * `preview`, and again in the accept fallback - which is the kind of duplication
 * that does not fail loudly: the copies drift, and the invitee is told the wrong
 * story about their own link.
 *
 * There is one further copy that CANNOT be collapsed into this: the `WHERE` of
 * the guarded UPDATE in `InviteAcceptRepository.accept`. That one is the
 * authority - it runs inside the transaction, against the database's clock, and
 * it is what actually decides. This function explains; that statement rules. The
 * two are deliberately in different languages so nobody mistakes one for the
 * other.
 *
 * The ORDER is the interesting part:
 *
 * - `accepted` wins outright. It stays the honest answer however much later the
 *   link is opened, and it is the only reason with a different next step -
 *   "sign in" rather than "ask for a new one".
 * - `expired` beats `revoked`, because an invite that lapsed may LATER be
 *   marked revoked as bookkeeping when a replacement supersedes it (see
 *   `supersedeExpiredInvites`). Reporting "withdrawn" then would tell the holder
 *   the owner changed their mind, when in truth they simply ran out of time.
 * - `revoked` is what remains: withdrawn while it was still live.
 */
export function refusalReason(
  invite: InviteView,
  now: Date = new Date(),
): InviteRefusalReason | null {
  if (invite.acceptedAt) return 'accepted';
  if (invite.expiresAt <= now) return 'expired';
  if (invite.revokedAt) return 'revoked';
  return null;
}

/**
 * Which password an invite for this address will ask for (#154, ADR-0034).
 *
 * ONE definition, used by BOTH the preview (which renders the form) and accept
 * (which decides whether to verify a password). Two copies here would mean a
 * page that asks for one thing and an endpoint that checks another.
 *
 * The subtle case is `seatCount === 0`, and it exists to close a regression
 * #154 would otherwise introduce. Before memberships, `DELETE /staff/:id`
 * deleted the account, so re-inviting that address was always a clean start.
 * Now the account survives - so without this rule, someone removed and later
 * re-invited would be asked for a password they may not remember, and since
 * Sambung has no password reset, the owner could never fix it: `create` mode
 * unreachable, the address globally taken, the invite permanently unacceptable.
 *
 * An account with no seats is inert - it cannot even sign in (`403`), and it
 * guards no data. Letting the invite claim it grants exactly what the invite
 * grants and nothing more, which is precisely what would have happened had the
 * row not been there. The account holder loses a password that was already
 * useless to them.
 */
export function inviteAcceptModeFor(
  account: { seatCount: number } | undefined,
): InviteAcceptMode {
  return account && account.seatCount > 0 ? 'signin' : 'create';
}
