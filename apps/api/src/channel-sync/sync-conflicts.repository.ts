import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  booking,
  channelConnection,
  property,
  syncConflict,
  unit,
} from '@sambung/db';
import {
  OCCUPYING_STATUSES,
  type ListSyncConflictsQuery,
  type SyncConflictStatus,
} from '@sambung/shared';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

/** One conflict row joined with the inventory names an owner needs to recognise it. */
export interface SyncConflictRow {
  id: string;
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitName: string;
  channel: string;
  externalUid: string;
  checkIn: string;
  checkOut: string;
  status: SyncConflictStatus;
  firstDetectedAt: Date;
  lastSeenAt: Date;
  closedAt: Date | null;
}

/** A booking currently holding nights a conflict wants, tagged with the conflict it
 * blocks (one booking can block several, and one conflict can have several
 * blockers - a long OTA stay can span two short direct ones). */
export interface BlockingBookingRow {
  conflictId: string;
  id: string;
  source: string;
  status: string;
  checkIn: string;
  checkOut: string;
  guestName: string | null;
}

/** The outcome of dismissing: the row is unknown to this tenant, or it now sits in
 * some closed state (which may be `dismissed` from this call, or `resolved` if the
 * world healed it first - the caller echoes reality rather than assuming). */
export type DismissOutcome =
  | { kind: 'not_found' }
  | { kind: 'closed'; status: SyncConflictStatus; closedAt: Date | null };

/**
 * The sync-conflict inbox's READ side (#38, api-spec §7.5) - dumb repository,
 * Drizzle only, on the tenant-scoped (RLS) client.
 *
 * Note the asymmetry with the rest of this module: the import WRITES conflicts on the
 * RLS-bypassed owner connection (a cron with no principal, ADR-0025), while every
 * query here runs as the authenticated owner. Same table, two connections - so this
 * file keeps the explicit `tenant_id` filter on every statement (architecture §3.3),
 * which is the layer that still holds if the app ever booted on `DATABASE_URL` and
 * RLS were not in force.
 */
@Injectable()
export class SyncConflictsRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * The inbox list. Newest-seen first: an inbox is read top-down, and the thing that
   * clashed most recently is the thing the owner has not yet dealt with.
   *
   * Joins unit + property for the names (and for the `propertyId` filter, which a
   * multi-property owner uses to work one workbench at a time). Both joins carry
   * `tenant_id` in the ON clause, matching the composite-FK grain - a join that
   * matched on id alone would be a second place a cross-tenant row could appear.
   */
  async list(query: ListSyncConflictsQuery): Promise<SyncConflictRow[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select({
          id: syncConflict.id,
          propertyId: property.id,
          propertyName: property.name,
          unitId: unit.id,
          unitName: unit.name,
          channel: channelConnection.channel,
          externalUid: syncConflict.externalUid,
          checkIn: syncConflict.checkIn,
          checkOut: syncConflict.checkOut,
          status: syncConflict.status,
          firstDetectedAt: syncConflict.firstDetectedAt,
          lastSeenAt: syncConflict.lastSeenAt,
          closedAt: syncConflict.closedAt,
        })
        .from(syncConflict)
        .innerJoin(
          unit,
          and(
            eq(unit.id, syncConflict.unitId),
            eq(unit.tenantId, syncConflict.tenantId),
          ),
        )
        .innerJoin(
          property,
          and(
            eq(property.id, unit.propertyId),
            eq(property.tenantId, unit.tenantId),
          ),
        )
        // innerJoin is safe: the FK is `on delete cascade`, so a conflict cannot
        // outlive the connection whose feed produced it.
        .innerJoin(
          channelConnection,
          and(
            eq(channelConnection.id, syncConflict.channelConnectionId),
            eq(channelConnection.tenantId, syncConflict.tenantId),
          ),
        )
        .where(
          and(
            eq(syncConflict.tenantId, tenantId),
            eq(syncConflict.status, query.status),
            query.propertyId ? eq(property.id, query.propertyId) : undefined,
          ),
        )
        .orderBy(desc(syncConflict.lastSeenAt), asc(syncConflict.id)),
    );
  }

  /**
   * The bookings currently occupying the nights each conflict wants - DERIVED, never
   * stored, because which booking blocks changes as the owner works (they cancel one,
   * a hold lapses).
   *
   * The overlap test is the SAME `daterange(check_in, check_out, '[)') &&` the
   * `booking_no_overlap` exclusion constraint uses, over the SAME `OCCUPYING_STATUSES`
   * its WHERE names (db-design §4.2/4.3). That identity is the point: this list has to
   * be exactly the set of rows that caused the refusal, or the inbox would send an
   * owner to cancel a booking that was never in the way.
   *
   * One query for the whole page, keyed back to the conflict by id (not N+1).
   */
  async findBlockingBookings(
    conflictIds: string[],
  ): Promise<BlockingBookingRow[]> {
    if (conflictIds.length === 0) return [];
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select({
          conflictId: syncConflict.id,
          id: booking.id,
          source: booking.source,
          status: booking.status,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guestName: booking.guestName,
        })
        .from(syncConflict)
        .innerJoin(
          booking,
          and(
            eq(booking.unitId, syncConflict.unitId),
            eq(booking.tenantId, syncConflict.tenantId),
            inArray(booking.status, [...OCCUPYING_STATUSES]),
            sql`daterange(${booking.checkIn}, ${booking.checkOut}, '[)')
                && daterange(${syncConflict.checkIn}, ${syncConflict.checkOut}, '[)')`,
          ),
        )
        .where(
          and(
            eq(syncConflict.tenantId, tenantId),
            inArray(syncConflict.id, conflictIds),
          ),
        )
        .orderBy(asc(booking.checkIn), asc(booking.id)),
    );
  }

  /**
   * Dismiss one conflict: a guarded UPDATE that matches only an `open` row of this
   * tenant, so a cross-tenant id updates nothing (RLS would already have hidden it -
   * this is the second layer).
   *
   * 0 rows is ambiguous on its own (unknown id, or a row that was already closed), so
   * a second read disambiguates into 404 vs an idempotent no-op. Both statements are
   * tenant-scoped, so the existence check cannot become a cross-tenant oracle.
   */
  async dismiss(id: string): Promise<DismissOutcome> {
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx) => {
      const [updated] = await tx
        .update(syncConflict)
        .set({ status: 'dismissed', closedAt: new Date() })
        .where(
          and(
            eq(syncConflict.id, id),
            eq(syncConflict.tenantId, tenantId),
            eq(syncConflict.status, 'open'),
          ),
        )
        .returning({
          status: syncConflict.status,
          closedAt: syncConflict.closedAt,
        });
      if (updated) {
        return { kind: 'closed', ...updated };
      }

      const [existing] = await tx
        .select({
          status: syncConflict.status,
          closedAt: syncConflict.closedAt,
        })
        .from(syncConflict)
        .where(
          and(eq(syncConflict.id, id), eq(syncConflict.tenantId, tenantId)),
        )
        .limit(1);
      return existing ? { kind: 'closed', ...existing } : { kind: 'not_found' };
    });
  }
}
