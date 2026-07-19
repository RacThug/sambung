import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import type { BookingRefusalReason } from '@sambung/shared';

/**
 * Domain errors that a database constraint can also produce.
 *
 * Each is a factory, not a string, because two layers arrive at the same
 * answer: an app-level check (a fast path, or a friendlier message) and the
 * constraint that actually guarantees it. api-spec §5.3 requires those to be
 * indistinguishable - "the client cannot tell (and must not care) which layer
 * refused" - so both throw the SAME factory rather than two copies of a string
 * that a typo can silently split apart.
 *
 * The constraint half of the wiring lives in db-error.map.ts.
 */

/** app_user.email is citext UNIQUE. Racing signups both pass the pre-check. */
export const emailTaken = (): HttpException =>
  new ConflictException('Email already registered');

/**
 * unit.(property_id, name) is UNIQUE (ADR-0001).
 *
 * The odd one out: only ONE layer can produce this. zod cannot check it - the
 * answer depends on the other rows - so there is no app-level twin here and the
 * constraint isn't a backstop, it IS the check. That's exactly when mapping the
 * name earns its keep, and it's why this maps while the unit CHECKs and the
 * booking FKs deliberately don't: a duplicate name is a legitimate thing for an
 * owner to try, whereas a negative price or a cascade-that-shouldn't-be can only
 * mean the boundary or the delete guard is broken (500, loudly).
 */
export const unitNameTaken = (): HttpException =>
  new ConflictException(
    'A unit with this name already exists in this property',
  );

/**
 * A guest booking cannot occupy these nights (api-spec §5.3, boss fight #1).
 *
 * THE reason this whole factory pattern exists. Two layers reach it: the service
 * re-checks availability inside the transaction and throws this with the full
 * `reasons` it computed (`overlap`/`min_stay`/`max_guests`/`unavailable`); and if
 * a racing booking slips between that check and the INSERT, the
 * `booking_no_overlap` exclusion constraint fires and the interceptor maps it
 * here with `['overlap']` (see db-error.map.ts). api-spec §5.3 requires the two
 * to be indistinguishable - "the client cannot tell (and must not care) which
 * layer refused" - which is exactly one factory, thrown from both places.
 *
 * The body carries a machine-readable `reasons` array (AC #4) on top of the
 * standard conflict shape, so the checkout UI can branch (re-quote on `overlap`,
 * send back to search on `unavailable`) without parsing prose.
 */
export const datesUnavailable = (
  reasons: readonly BookingRefusalReason[],
): HttpException =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    message: 'These dates are no longer available',
    reasons,
  });

/**
 * A booking cannot be cancelled because it is already terminal (#50, api-spec
 * §5.6). The FSM lives in the cancel UPDATE's WHERE, so this is the ONE-layer
 * kind (like unitNameTaken): no constraint produces it, the guarded UPDATE
 * matching zero rows does. The body names the terminal `status` (`cancelled` /
 * `expired`) as a machine-readable field so the UI says "already cancelled" vs
 * "expired" without parsing prose (§8.2).
 */
export const bookingNotCancellable = (status: string): HttpException =>
  new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    message: 'Booking cannot be cancelled',
    status,
  });
