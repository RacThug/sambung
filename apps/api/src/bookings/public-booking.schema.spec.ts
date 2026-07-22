import { apiCreateBookingRequestSchema } from './public-booking.schema';

/**
 * `apiCreateBookingRequestSchema` is the one inbound request schema that lives
 * OUTSIDE packages/shared, so the enumeration guard there (ADR-0031, #150)
 * cannot see it. It inherits strict by `.refine()`-ing the shared schema - a
 * derivation, not a declaration, which is exactly the kind of property that
 * breaks silently when someone rebuilds the wrapper. Pin it here.
 */
describe('apiCreateBookingRequestSchema (ADR-0031)', () => {
  const valid = {
    unitId: '11111111-1111-1111-1111-111111111111',
    checkIn: '2030-01-01',
    checkOut: '2030-01-03',
    guestName: 'Ayu',
    guestPhone: '+6281234567890',
    guestCount: 2,
  };

  it('accepts a valid body', () => {
    expect(apiCreateBookingRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    const result = apiCreateBookingRequestSchema.safeParse({
      ...valid,
      guestCounts: 4, // a typo the guest funnel would never send
    });

    expect(result.success).toBe(false);
    expect(
      result.success
        ? []
        : result.error.issues.map((issue) => issue.code as string),
    ).toContain('unrecognized_keys');
  });
});
