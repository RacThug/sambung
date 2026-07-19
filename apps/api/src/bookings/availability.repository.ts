import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { booking, property, unit } from '@sambung/db';
import { OCCUPYING_STATUSES, type BlockedRange } from '@sambung/shared';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

/** What the quote needs about the unit itself. `archived` is the EFFECTIVE flag
 * (the unit's own OR its property's), computed in SQL so one fetch answers both
 * the price and the archived-→404 question (api-spec §4.8). */
export interface UnitPricing {
  basePriceIdr: bigint;
  minStay: number;
  archived: boolean;
}

// "Occupying" = a booking that holds the calendar against everyone else
// (CONTEXT.md). Exactly the set inside the booking_no_overlap exclusion
// constraint's WHERE - the read must scope to the same statuses the write's
// correctness guard does, or the quote could disagree with the constraint. Now
// the shared OCCUPYING_STATUSES: the availability read, the booking write's
// re-check, and the calendar's ?status= filter all name one list (ADR-0010).

// Dumb repository: Drizzle queries only, via the tenant-scoped (RLS) client. The
// tenant is ambient (#76) and every query still filters by tenant_id anyway - the
// same two layers as every other repository (architecture §3.3), guarding the one
// env var (DATABASE_URL vs APP_DATABASE_URL) that would boot without RLS in force.
@Injectable()
export class AvailabilityRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * The unit's price, min-stay, and effective-archived state, or null when the id
   * is unknown to this tenant. One fetch: the JOIN reads the parent property so
   * `archived` covers a unit hidden by an archived Property, not only its own flag.
   */
  async fetchUnitPricing(unitId: string): Promise<UnitPricing | null> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({
          basePriceIdr: unit.basePriceIdr,
          minStay: unit.minStay,
          archived: sql<boolean>`(${unit.archivedAt} is not null or ${property.archivedAt} is not null)`,
        })
        .from(unit)
        .innerJoin(
          property,
          and(
            eq(property.id, unit.propertyId),
            eq(property.tenantId, unit.tenantId),
          ),
        )
        .where(and(eq(unit.id, unitId), eq(unit.tenantId, tenantId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Every occupying booking overlapping `[from, to)`, clipped to the window and
   * returned as half-open `{from, to}` - nothing else. Unmerged; the caller
   * coalesces (contiguous ranges must not leak the seam between two bookings).
   *
   * The overlap test is the SAME `daterange(check_in, check_out, '[)') &&` the
   * exclusion constraint uses (db-design §4.2/4.3), so a quote can never report
   * "free" for a stay the booking write would reject. Clipping is
   * `greatest`/`least` cast to text, so the driver returns clean `YYYY-MM-DD`
   * strings rather than Date objects; because the `&&` already guaranteed a real
   * overlap, each clipped range is non-empty (`from < to`).
   */
  findBlockedRanges(
    unitId: string,
    from: string,
    to: string,
  ): Promise<BlockedRange[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select({
          from: sql<string>`greatest(${booking.checkIn}, ${from}::date)::text`,
          to: sql<string>`least(${booking.checkOut}, ${to}::date)::text`,
        })
        .from(booking)
        .where(
          and(
            eq(booking.unitId, unitId),
            eq(booking.tenantId, tenantId),
            inArray(booking.status, OCCUPYING_STATUSES),
            sql`daterange(${booking.checkIn}, ${booking.checkOut}, '[)') && daterange(${from}::date, ${to}::date, '[)')`,
          ),
        )
        .orderBy(asc(booking.checkIn)),
    );
  }
}
