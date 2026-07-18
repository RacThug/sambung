import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  createBookingResponseSchema,
  toRupiah,
  type BookingRefusalReason,
  type CreateBookingRequest,
  type CreateBookingResponse,
} from '@sambung/shared';
import { PublicScope } from '../common/public-scope.service';
import { TenantContext } from '../common/tenant-context.service';
import { datesUnavailable } from '../common/db-error/conflicts';
import { TenantDbService } from '../db/tenant-db.service';
import { AvailabilityService } from './availability.service';
import { BookingsRepository } from './bookings.repository';

/**
 * The guest funnel's checkout - `POST /public/bookings` (api-spec §5.3,
 * FR-BOOK-1). This is boss fight #1: no single layer is correct alone, so the
 * job here is to compose four of them into one transaction.
 *
 *   1. Re-check availability (the app's UX layer + the ONLY guard for min_stay /
 *      max_guests / archived, none of which the DB constraint knows).
 *   2. The `booking_no_overlap` exclusion constraint (the ONLY guard for the
 *      overlap race - two guests whose app-checks both pass because neither sees
 *      the other's uncommitted hold under READ COMMITTED).
 *   3. The pessimistic hold (`pending_payment` occupies the calendar the moment
 *      checkout starts, before anyone pays).
 *   4. The expiry sweep (a dead hold stops occupying only once flipped; here the
 *      opportunistic in-transaction sweep does it for the unit in hand).
 *
 * The re-check and the constraint both refuse with the SAME 409 shape, so the
 * client cannot tell which layer fired (and must not care).
 */
@Injectable()
export class BookingsService {
  constructor(
    private readonly scope: PublicScope,
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
    private readonly availability: AvailabilityService,
    private readonly repo: BookingsRepository,
  ) {}

  async createPublicBooking(
    req: CreateBookingRequest,
  ): Promise<CreateBookingResponse> {
    // Resolve the tenant from the unit id BEFORE any tenant-scoped query. Pure
    // resolver (ADR-0008): 404s a unit that does not exist at all, mints a
    // Visitor scoped to exactly that tenant, and judges archive nowhere - the
    // archived answer is this write's to give, below, as a 409.
    await this.scope.enterFromUnitId(req.unitId);

    // One transaction owns the whole unit of work: sweep -> re-check -> insert.
    // quote() and the repository methods JOIN this transaction (#72), so the
    // re-check sees the sweep's uncommitted UPDATE and the insert shares the
    // transaction the exclusion constraint arbitrates.
    return this.db.run(async () => {
      // (1) Opportunistic sweep: free this unit's dead-but-unswept holds first,
      // so a lapsed hold never blocks a live guest (ADR-0009). Must precede the
      // re-check, or the re-check would still see the dead hold as occupying.
      await this.repo.expireLapsedHolds(req.unitId);

      // (2) Re-check via the ONE interval authority (api-spec §5.1). Reusing
      // quote() is what guarantees the read and the write share a single
      // definition of "overlap" - they cannot drift into disagreeing.
      const outcome = await this.availability.quote(
        req.unitId,
        req.checkIn,
        req.checkOut,
      );
      if (outcome.kind === 'not_found') {
        // enterFromUnitId found it a moment ago; gone now = deleted mid-request.
        // Indistinguishable from unknown, like the resolver's own 404.
        throw new NotFoundException('Unit not found');
      }
      if (outcome.kind === 'archived') {
        // Resolve-then-409 (ADR-0008). The guest reached checkout on a unit the
        // owner archived after the page loaded - a race, like the dates
        // vanishing. Surfaces as `unavailable`, never the word "archived".
        throw datesUnavailable(['unavailable']);
      }
      const quote = outcome.response;

      // (3) Collect every refusal into ONE 409 (page-spec §3.2 shows combined
      // reasons). quote() supplies overlap/min_stay; capacity is a write-only
      // check - max_guests depends on the chosen unit, so no GET could enforce
      // it. Reasons order: overlap, min_stay, then max_guests.
      const reasons: BookingRefusalReason[] = [...quote.reasons];
      const maxGuests = await this.repo.fetchMaxGuests(req.unitId);
      if (maxGuests === null) {
        throw new NotFoundException('Unit not found');
      }
      if (req.guestCount > maxGuests) {
        reasons.push('max_guests');
      }
      if (reasons.length > 0) {
        throw datesUnavailable(reasons);
      }

      // (4) Insert the hold. The price is the SERVER's (from the quote), never
      // the client's. A racing overlap loses at the exclusion constraint here,
      // mapped to the same 409 as (3)'s overlap.
      const created = await this.repo.insertHold({
        tenantId: this.tenant.tenantId,
        unitId: req.unitId,
        checkIn: req.checkIn,
        checkOut: req.checkOut,
        guestName: req.guestName,
        guestPhone: req.guestPhone,
        guestEmail: req.guestEmail ?? null,
        guestCount: req.guestCount,
        totalPriceIdr: BigInt(quote.totalPriceIdr),
      });

      // The columns are nullable in the table, but this write always sets hold
      // and price - a null back is a bug, not a booking. Fail loud (500).
      if (created.holdExpiresAt === null || created.totalPriceIdr === null) {
        throw new InternalServerErrorException(
          'Booking insert returned a null hold or price',
        );
      }

      // Parse on the way out so the payload cannot silently widen.
      return createBookingResponseSchema.parse({
        bookingId: created.id,
        status: created.status,
        holdExpiresAt: created.holdExpiresAt.toISOString(),
        totalPriceIdr: toRupiah(created.totalPriceIdr),
        nights: quote.nights,
      });
    });
  }
}
