import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  cancelBookingResponseSchema,
  createBookingResponseSchema,
  createOwnerBookingResponseSchema,
  toRupiah,
  type AvailabilityResponse,
  type BookingRefusalReason,
  type CancelBookingResponse,
  type CreateBookingRequest,
  type CreateBookingResponse,
  type CreateOwnerBookingRequest,
  type CreateOwnerBookingResponse,
} from '@sambung/shared';
import { PublicScope } from '../common/public-scope.service';
import { TenantContext } from '../common/tenant-context.service';
import {
  bookingNotCancellable,
  datesUnavailable,
} from '../common/db-error/conflicts';
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
      // (1+2) Sweep this unit's dead holds, then re-check via the ONE interval
      // authority. An archived unit surfaces as `unavailable` here - the guest
      // wire never carries the owner's word "archived" (ADR-0008).
      const quote = await this.sweepQuoteOrThrow(
        req.unitId,
        req.checkIn,
        req.checkOut,
        'unavailable',
      );

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

  /**
   * The OWNER-side create - `POST /bookings`, a manual Block or a walk-in (#50,
   * api-spec §5.4, ADR-0011). The owner is an authority, not a customer: this
   * reuses the guest funnel's ONE overlap chokepoint (the sweep + quote() +, at
   * insert, the exclusion constraint) but obeys ONLY the physical invariant.
   *
   * There is no `enterFromUnitId`: the JwtAuthGuard already minted the owner
   * principal, so the whole transaction runs on the owner RLS connection and a
   * cross-tenant / unknown unit is invisible → 404 (via `sweepQuoteOrThrow`).
   */
  async createOwnerBooking(
    req: CreateOwnerBookingRequest,
  ): Promise<CreateOwnerBookingResponse> {
    return this.db.run(async () => {
      // Same chokepoint as the guest funnel. An archived unit is named plainly
      // to the owner (`archived`), not hidden as `unavailable` (ADR-0011).
      const quote = await this.sweepQuoteOrThrow(
        req.unitId,
        req.checkIn,
        req.checkOut,
        'archived',
      );

      // Overlap is the only refusal the owner obeys. `min_stay` is the owner's
      // own rule to bend (a one-night maintenance block), so it is ignored;
      // `max_guests` is never checked here. The real overlap guard remains the
      // exclusion constraint at insert - this is the friendly pre-check twin.
      if (quote.reasons.includes('overlap')) {
        throw datesUnavailable(['overlap']);
      }

      const base = {
        tenantId: this.tenant.tenantId,
        unitId: req.unitId,
        checkIn: req.checkIn,
        checkOut: req.checkOut,
      };
      const created =
        req.source === 'manual_block'
          ? // A Block: no guest, no price - it occupies but sells nothing.
            await this.repo.insertConfirmed({
              ...base,
              source: 'manual_block',
              guestName: null,
              guestPhone: null,
              guestEmail: null,
              guestCount: null,
              totalPriceIdr: null,
            })
          : // A walk-in: guest name required; price is the owner's override or
            // the server's `base x nights` default (the quote's figure).
            await this.repo.insertConfirmed({
              ...base,
              source: 'direct',
              guestName: req.guestName,
              guestPhone: req.guestPhone ?? null,
              guestEmail: req.guestEmail ?? null,
              guestCount: req.guestCount ?? null,
              totalPriceIdr: BigInt(req.totalPriceIdr ?? quote.totalPriceIdr),
            });

      return createOwnerBookingResponseSchema.parse({
        bookingId: created.id,
        status: created.status,
        source: created.source,
        checkIn: created.checkIn,
        checkOut: created.checkOut,
        totalPriceIdr:
          created.totalPriceIdr === null
            ? null
            : toRupiah(created.totalPriceIdr),
        nights: quote.nights,
      });
    });
  }

  /**
   * Cancel a booking - the universal free-the-dates verb (#50, api-spec §5.6).
   * FSM-guarded in the repository's UPDATE; here we frame the outcome: `terminal`
   * → 409 naming the state, `not_found` → 404. `refund` is `manual` iff a paid
   * payment exists (always `none` at M2). One transaction so the guarded UPDATE
   * and the refund lookup agree on a single snapshot.
   */
  async cancel(id: string): Promise<CancelBookingResponse> {
    return this.db.run(async () => {
      const outcome = await this.repo.cancelById(id);
      if (outcome.kind === 'not_found') {
        throw new NotFoundException('Booking not found');
      }
      if (outcome.kind === 'terminal') {
        throw bookingNotCancellable(outcome.status);
      }
      const refund = (await this.repo.hasPaidPayment(id)) ? 'manual' : 'none';
      return cancelBookingResponseSchema.parse({ status: 'cancelled', refund });
    });
  }

  /**
   * The shared overlap chokepoint, in one transaction: sweep this unit's dead
   * holds (ADR-0009), then quote() as the single interval authority (joined into
   * the caller's transaction, #72). Both the guest funnel and the owner write run
   * this - the reason the read and the write can never disagree on "overlap".
   *
   * `archivedReason` is the only thing that differs by caller: the guest sees an
   * archived unit as `unavailable`, the owner as `archived` (ADR-0011). A unit
   * that vanished mid-request is a 404, indistinguishable from unknown.
   */
  private async sweepQuoteOrThrow(
    unitId: string,
    checkIn: string,
    checkOut: string,
    archivedReason: BookingRefusalReason,
  ): Promise<AvailabilityResponse> {
    await this.repo.expireLapsedHolds(unitId);
    const outcome = await this.availability.quote(unitId, checkIn, checkOut);
    if (outcome.kind === 'not_found') {
      throw new NotFoundException('Unit not found');
    }
    if (outcome.kind === 'archived') {
      throw datesUnavailable([archivedReason]);
    }
    return outcome.response;
  }
}
