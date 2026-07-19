import { HttpException } from '@nestjs/common';
import { conflictBodySchema, parseConflictBody } from '@sambung/shared';
import {
  bookingNotCancellable,
  bookingNotPayable,
  datesUnavailable,
  emailTaken,
  propertyHasBookings,
  unitHasBookings,
  unitNameTaken,
} from './conflicts';

/**
 * The API⇄web 409 contract (#82). `apps/api` is the one workspace that imports
 * both the factories (which BUILD the bodies) and `@sambung/shared` (which
 * DEFINES their shape), so this is where the two are pinned together - exactly
 * like the pgEnum-mirror test (api-spec §8.6). If a factory's `code` or detail
 * ever drifts from `conflictBodySchema`, this goes red rather than shipping a 409
 * the web can't parse.
 */
describe('conflict factories conform to the shared wire contract', () => {
  const bodyOf = (e: HttpException): unknown => e.getResponse();

  it('every factory produces a body the shared schema accepts', () => {
    const bodies = [
      emailTaken(),
      unitNameTaken(),
      propertyHasBookings(3),
      unitHasBookings(14),
      datesUnavailable(['overlap', 'min_stay']),
      bookingNotCancellable('cancelled'),
      bookingNotPayable('expired'),
    ].map(bodyOf);

    for (const body of bodies) {
      // safeParse, not parse, so a failure names WHICH body broke the contract.
      const parsed = conflictBodySchema.safeParse(body);
      expect(parsed.success).toBe(true);
    }
  });

  it('carries the delete guard count as data, not prose', () => {
    expect(parseConflictBody(bodyOf(propertyHasBookings(2)))).toEqual({
      code: 'property_has_bookings',
      count: 2,
    });
    expect(parseConflictBody(bodyOf(unitHasBookings(14)))).toEqual({
      code: 'unit_has_bookings',
      count: 14,
    });
  });

  it('carries refusal reasons and the terminal status as data', () => {
    expect(
      parseConflictBody(bodyOf(datesUnavailable(['unavailable']))),
    ).toEqual({ code: 'dates_unavailable', reasons: ['unavailable'] });
    expect(parseConflictBody(bodyOf(bookingNotCancellable('expired')))).toEqual(
      {
        code: 'booking_not_cancellable',
        status: 'expired',
      },
    );
    expect(parseConflictBody(bodyOf(bookingNotPayable('confirmed')))).toEqual({
      code: 'booking_not_payable',
      status: 'confirmed',
    });
  });

  it('keeps a human message for logs without leaking it into the domain body', () => {
    const body = bodyOf(emailTaken()) as Record<string, unknown>;
    // The human default is still there (observability), but it is NOT the slug -
    // the machine identity lives in `code`, and the web renders its own copy.
    expect(body.message).toBe('Email already registered');
    expect(body.code).toBe('email_taken');
  });
});
