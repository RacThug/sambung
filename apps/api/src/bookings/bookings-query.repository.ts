import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { booking, property, unit } from '@sambung/db';
import type { BookingSource, BookingStatus } from '@sambung/shared';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

/** The filters `GET /bookings` AND-s together (api-spec §5.5). All optional; the
 * window, when present, is a validated pair. */
export interface BookingListFilters {
  from?: string; // 'YYYY-MM-DD'
  to?: string;
  propertyId?: string;
  unitId?: string;
  status?: readonly BookingStatus[];
  source?: readonly BookingSource[];
}

/** The DB-shaped row the repo returns; the service maps it to the wire
 * `BookingRow` (bigint -> number, Date -> ISO). */
export interface BookingListRow {
  id: string;
  unitId: string;
  source: BookingSource;
  status: BookingStatus;
  checkIn: string;
  checkOut: string;
  guestName: string | null;
  guestCount: number | null;
  holdExpiresAt: Date | null;
  totalPriceIdr: bigint | null;
}

/** The DB-shaped detail row for `GET /bookings/:id` (#50): a list row plus the
 * guest contact and display names the detail view needs (owner full disclosure). */
export interface BookingDetailRow extends BookingListRow {
  guestPhone: string | null;
  guestEmail: string | null;
  propertyId: string;
  propertyName: string;
  unitName: string;
}

// Dumb repository: Drizzle queries only, via the tenant-scoped (RLS) client. The
// tenant is ambient (#76) and every query ALSO filters by tenant_id - one source,
// two layers, guarding the one env var (DATABASE_URL vs APP_DATABASE_URL) that
// would boot the owner role without RLS (architecture §3.3). The isolation test
// exercises exactly that WHERE.
@Injectable()
export class BookingsQueryRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * Every booking matching the filters, whole rows, sorted by check-in.
   *
   * Joins `unit` so a `propertyId` filter is expressible (a booking carries only
   * its unit id) and so the join key re-asserts tenant consistency; the join is
   * inner because `booking.unit_id` is a NOT NULL, FK-valid column, so it drops
   * nothing. The window predicate is the SAME `daterange(...) &&` overlap the
   * availability read and the exclusion constraint use (db-design §4.2/4.3), so a
   * stay straddling either edge matches - never a parallel copy of "overlap".
   */
  list(filters: BookingListFilters): Promise<BookingListRow[]> {
    const tenantId = this.tenant.tenantId;
    const conds: SQL[] = [eq(booking.tenantId, tenantId)];

    if (filters.from && filters.to) {
      conds.push(
        sql`daterange(${booking.checkIn}, ${booking.checkOut}, '[)') && daterange(${filters.from}::date, ${filters.to}::date, '[)')`,
      );
    }
    if (filters.propertyId) {
      conds.push(eq(unit.propertyId, filters.propertyId));
    }
    if (filters.unitId) {
      conds.push(eq(booking.unitId, filters.unitId));
    }
    if (filters.status && filters.status.length > 0) {
      conds.push(inArray(booking.status, [...filters.status]));
    }
    if (filters.source && filters.source.length > 0) {
      conds.push(inArray(booking.source, [...filters.source]));
    }

    return this.db.run((tx) =>
      tx
        .select({
          id: booking.id,
          unitId: booking.unitId,
          source: booking.source,
          status: booking.status,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guestName: booking.guestName,
          guestCount: booking.guestCount,
          holdExpiresAt: booking.holdExpiresAt,
          totalPriceIdr: booking.totalPriceIdr,
        })
        .from(booking)
        .innerJoin(
          unit,
          and(eq(unit.id, booking.unitId), eq(unit.tenantId, booking.tenantId)),
        )
        .where(and(...conds))
        // check-in is the sort key (api-spec §5.5); id breaks ties so a page of
        // same-day bookings has a stable order.
        .orderBy(asc(booking.checkIn), asc(booking.id)),
    );
  }

  /**
   * One booking in full, or null when the id is unknown / belongs to another
   * tenant (→ 404-over-403). Joins `unit` and `property` for the display names and
   * to re-assert tenant consistency on both join keys; the tenant_id WHERE is the
   * second layer beside RLS (architecture §3.3). Whole row - owner disclosure.
   */
  async getById(id: string): Promise<BookingDetailRow | null> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({
          id: booking.id,
          unitId: booking.unitId,
          source: booking.source,
          status: booking.status,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guestName: booking.guestName,
          guestCount: booking.guestCount,
          holdExpiresAt: booking.holdExpiresAt,
          totalPriceIdr: booking.totalPriceIdr,
          guestPhone: booking.guestPhone,
          guestEmail: booking.guestEmail,
          propertyId: unit.propertyId,
          propertyName: property.name,
          unitName: unit.name,
        })
        .from(booking)
        .innerJoin(
          unit,
          and(eq(unit.id, booking.unitId), eq(unit.tenantId, booking.tenantId)),
        )
        .innerJoin(
          property,
          and(
            eq(property.id, unit.propertyId),
            eq(property.tenantId, unit.tenantId),
          ),
        )
        .where(and(eq(booking.id, id), eq(booking.tenantId, tenantId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }
}
