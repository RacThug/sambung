import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { booking, unit } from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';
import { HOLD_TTL_MINUTES } from './booking.constants';

/** Everything the hold INSERT needs. Prices arrive as a bigint (the DB's money
 * type) already computed by the availability quote - the repository never prices. */
export interface HoldInput {
  tenantId: string;
  unitId: string;
  checkIn: string; // 'YYYY-MM-DD'
  checkOut: string;
  guestName: string;
  guestPhone: string;
  guestEmail: string | null;
  guestCount: number;
  totalPriceIdr: bigint;
}

/** What the INSERT hands back. Columns are nullable in the table (manual_block /
 * imports carry no hold or price), but THIS write always sets both - the service
 * narrows the nulls away, and a null here would be a bug, not a 409. */
export interface InsertedHold {
  id: string;
  status: string;
  holdExpiresAt: Date | null;
  totalPriceIdr: bigint | null;
}

/**
 * The write half of the booking domain (boss fight #1). Dumb by design: Drizzle
 * queries only, via the tenant-scoped (RLS) client, every one filtering by
 * tenant_id as the second layer of defence (architecture §3.3). The interesting
 * logic - sweep-then-check-then-insert as one unit of work - lives in the
 * service; these are the three statements it composes.
 *
 * Two methods assert they run inside a transaction. Their whole purpose is to
 * affect the SURROUNDING unit of work: the opportunistic sweep must be visible
 * to the re-check that follows it, and the insert must share the transaction the
 * exclusion constraint arbitrates. Called standalone, each would open (and
 * immediately close) its own transaction - the sweep freeing nothing the caller
 * can see, the insert racing nobody - so returning normally would be a lie.
 */
@Injectable()
export class BookingsRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * Opportunistic INTRA-TENANT sweep (ADR-0009, Option 2). Expire this unit's
   * lapsed-but-unswept holds, so a dead hold never blocks a guest actively
   * booking the unit. Runs BEFORE the re-check, in the same transaction, so the
   * re-check and the exclusion constraint both see the freed nights.
   *
   * Idempotent: the WHERE matches only holds already past their TTL, so a second
   * run - or the cron backstop racing it - flips nothing. Intra-tenant, so it
   * needs no owner connection: a Visitor is scoped to exactly the tenant that
   * owns this unit, and these are that tenant's own holds (the mirror of why the
   * cross-tenant cron DOES need the owner connection).
   */
  async expireLapsedHolds(unitId: string): Promise<void> {
    this.db.assertInTransaction('BookingsRepository.expireLapsedHolds');
    const tenantId = this.tenant.tenantId;
    await this.db.run((tx) =>
      tx
        .update(booking)
        .set({ status: 'expired' })
        .where(
          and(
            eq(booking.unitId, unitId),
            eq(booking.tenantId, tenantId),
            eq(booking.status, 'pending_payment'),
            sql`${booking.holdExpiresAt} < now()`,
          ),
        ),
    );
  }

  /**
   * The unit's guest cap, scoped to this tenant. `null` when the id is unknown to
   * this tenant - which the caller only reaches after `quote()` already confirmed
   * the unit exists, so a null here means it vanished mid-request.
   *
   * A separate one-column read rather than piggy-backing on the quote's fetch:
   * capacity is a booking-write concern, not an availability one, and the cost is
   * a single indexed PK lookup on the same transaction.
   */
  async fetchMaxGuests(unitId: string): Promise<number | null> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ maxGuests: unit.maxGuests })
        .from(unit)
        .where(and(eq(unit.id, unitId), eq(unit.tenantId, tenantId)))
        .limit(1),
    );
    return rows[0]?.maxGuests ?? null;
  }

  /**
   * Insert the pending_payment hold. `hold_expires_at` is `now() + the TTL` on
   * the DB clock (one clock, no skew). This is the statement the `booking_no_overlap`
   * exclusion constraint arbitrates: if a racing booking committed an overlapping
   * row since the re-check, this throws SQLSTATE 23P01, which the global
   * interceptor maps to the SAME 409 the re-check gives (api-spec §5.3).
   */
  async insertHold(input: HoldInput): Promise<InsertedHold> {
    this.db.assertInTransaction('BookingsRepository.insertHold');
    const rows = await this.db.run((tx) =>
      tx
        .insert(booking)
        .values({
          tenantId: input.tenantId,
          unitId: input.unitId,
          source: 'direct',
          status: 'pending_payment',
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guestName: input.guestName,
          guestPhone: input.guestPhone,
          guestEmail: input.guestEmail,
          guestCount: input.guestCount,
          totalPriceIdr: input.totalPriceIdr,
          holdExpiresAt: sql`now() + make_interval(mins => ${HOLD_TTL_MINUTES})`,
        })
        .returning({
          id: booking.id,
          status: booking.status,
          holdExpiresAt: booking.holdExpiresAt,
          totalPriceIdr: booking.totalPriceIdr,
        }),
    );
    return rows[0];
  }
}
