import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import type {
  BookingRefusalReason,
  BookingStatus,
  ConflictCode,
  InviteRefusalReason,
} from '@sambung/shared';

/**
 * The 409s of the domain, in one place - the ONE convention for every conflict
 * (api-spec §8.2, #82).
 *
 * Two forces meet here. First, some conflicts are reached by TWO layers - an
 * app-level pre-check (a fast path, or a friendlier answer) and the database
 * constraint that actually guarantees it - and api-spec §5.3 requires those to be
 * indistinguishable ("the client cannot tell, and must not care, which layer
 * refused"), so both throw the SAME factory rather than two copies of a string a
 * typo could split. The constraint half of that wiring lives in db-error.map.ts.
 *
 * Second, EVERY 409 - one-layer or two - carries a machine-readable `code` slug
 * from `@sambung/shared`, plus typed detail (a `count`, `reasons`, a `status`).
 * `message` stays a human default for logs; the client switches on `code` and
 * renders its own copy (ADR-0012). One `conflict()` builder stamps the shape so
 * no factory can forget the slug or diverge on the envelope.
 */

/**
 * Build a 409 whose identity is `code` and whose typed extras are `detail`.
 * `message` is a human default (logs / non-localized clients); the web never
 * renders it. The body is `{ statusCode, error, code, message, ...detail }`, and
 * `code` + `detail` parse cleanly against `conflictBodySchema` (proven by a test).
 */
function conflict(
  code: ConflictCode,
  message: string,
  detail: Record<string, unknown> = {},
): HttpException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code,
    message,
    ...detail,
  });
}

/** app_user.email is citext UNIQUE. Racing signups both pass the pre-check. */
export const emailTaken = (): HttpException =>
  conflict('email_taken', 'Email already registered');

/**
 * unit.(property_id, name) is UNIQUE (ADR-0001).
 *
 * The odd one out: only ONE layer can produce this. zod cannot check it - the
 * answer depends on the other rows - so there is no app-level twin and the
 * constraint IS the check. That's exactly when mapping the name earns its keep,
 * and why this maps while the unit CHECKs and the booking FKs deliberately don't:
 * a duplicate name is a legitimate thing for an owner to try, whereas a negative
 * price or a cascade-that-shouldn't-be can only mean the boundary or the delete
 * guard is broken (500, loudly).
 */
export const unitNameTaken = (): HttpException =>
  conflict(
    'unit_name_taken',
    'A unit with this name already exists in this property',
  );

/**
 * A property / unit cannot be deleted because a booking has ever referenced it
 * (ADR-0002) - deleting it would cascade away that ledger. One-layer conflicts,
 * like unitNameTaken: no constraint produces this (the guard counts under a lock
 * and the FKs stay unmapped on purpose), the service raises it directly.
 *
 * The `count` rides as DATA, never baked into an English sentence (#82 AC): the
 * web composes "This unit has 14 bookings…" from the number, and can localize it.
 * Property and unit are distinct slugs so the web renders the right noun without
 * inferring it from context.
 */
export const propertyHasBookings = (count: number): HttpException =>
  conflict(
    'property_has_bookings',
    `Property has ${count} booking(s); archive it instead of deleting`,
    { count },
  );

export const unitHasBookings = (count: number): HttpException =>
  conflict(
    'unit_has_bookings',
    `Unit has ${count} booking(s); archive it instead of deleting`,
    { count },
  );

/**
 * A booking cannot occupy these nights (api-spec §5.3, boss fight #1).
 *
 * THE reason the factory pattern exists. Two layers reach it: the service
 * re-checks availability inside the transaction and throws this with the full
 * `reasons` it computed (`overlap`/`min_stay`/`max_guests`/`unavailable`); and if
 * a racing booking slips between that check and the INSERT, the
 * `booking_no_overlap` exclusion constraint fires and the interceptor maps it
 * here with `['overlap']` (see db-error.map.ts). §5.3 requires the two to be
 * indistinguishable - one factory, thrown from both places.
 *
 * The machine-readable `reasons` array (api-spec §5.3, AC #4) lets the checkout
 * UI branch (re-quote on `overlap`, back to search on `unavailable`) without
 * parsing prose.
 */
export const datesUnavailable = (
  reasons: readonly BookingRefusalReason[],
): HttpException =>
  conflict('dates_unavailable', 'These dates are no longer available', {
    reasons,
  });

/**
 * A booking cannot be cancelled because it is already terminal (#50, api-spec
 * §5.6). The FSM lives in the cancel UPDATE's WHERE, so this is the one-layer
 * kind: no constraint produces it, the guarded UPDATE matching zero rows does.
 * The terminal `status` (`cancelled` / `expired`) rides as machine-readable data
 * so the UI can say "already cancelled" vs "expired" without parsing prose.
 */
export const bookingNotCancellable = (status: BookingStatus): HttpException =>
  conflict('booking_not_cancellable', 'Booking cannot be cancelled', {
    status,
  });

/**
 * A booking cannot be paid because it is no longer a live hold (#52, api-spec
 * §6.1, ADR-0015). Reached after the opportunistic hold-sweep, so a lapsed hold
 * arrives here as `status: 'expired'`; a booking that was confirmed, cancelled or
 * expired arrives with its own terminal status. One-layer, like the cancel FSM:
 * no constraint produces it, the post-sweep status read does. The blocking
 * `status` rides as data so the checkout UI can say "already confirmed" vs "this
 * hold lapsed - pick dates again" without parsing prose.
 */
export const bookingNotPayable = (status: BookingStatus): HttpException =>
  conflict('booking_not_payable', 'Booking cannot be paid', { status });

/**
 * A channel for this (unit, channel) is already connected (api-spec §7.1, #55).
 * THE factory pattern's job: two layers reach it - ChannelsService pre-checks and
 * throws this for a friendly answer with no wasted smoke fetch; and if a second
 * connect races between that check and the INSERT, the
 * `channel_connection_unit_channel_uniq` constraint fires and the interceptor maps
 * it here (see db-error.map.ts). §5.3 requires the two to be indistinguishable -
 * one factory, thrown from both places. No detail: the unit and channel are
 * already in the request, so the web has all it needs to compose copy.
 */
export const channelAlreadyConnected = (): HttpException =>
  conflict(
    'channel_already_connected',
    'This channel is already connected to this unit',
  );

/**
 * A staff Invite resolved, but is no longer live (#57, ADR-0033). One-layer:
 * the accept transaction's guarded UPDATE matching zero rows produces it, then
 * reads the row back to say which of the three it was.
 *
 * Note what this is NOT reached for: an UNKNOWN token. That is a 404, so a
 * caller guessing tokens learns nothing - the difference between "no such
 * invite" and "an invite, but spent" is only ever told to someone already
 * holding a real one.
 */
export const inviteNotAcceptable = (
  reason: InviteRefusalReason,
): HttpException =>
  conflict('invite_not_acceptable', 'This invite can no longer be used', {
    reason,
  });

/**
 * This Tenant already has a live invite for this email (#57). The two-layer kind
 * (§5.3): InvitesService pre-checks for the friendly answer, and a racing second
 * create is caught by the `staff_invite_live_email_uniq` partial index and mapped
 * here (db-error.map.ts) - one factory, so the loser cannot tell which refused.
 */
export const inviteAlreadyPending = (): HttpException =>
  conflict(
    'invite_already_pending',
    'An invite for this email is already pending',
  );
