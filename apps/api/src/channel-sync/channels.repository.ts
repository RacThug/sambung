import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import {
  booking,
  channelConnection,
  unit,
  type ChannelConnection,
} from '@sambung/db';
import type { Channel } from '@sambung/shared';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

/** The confirmed booking rows the export feed needs - and NOTHING else. Selecting
 * only these three columns is half the "no PII in the .ics" guarantee (the other
 * half is buildCalendar having no field for it). */
export interface ExportableBooking {
  id: string;
  checkIn: string;
  checkOut: string;
}

/**
 * Dumb repository: Drizzle queries only, via the tenant-scoped (RLS) client. The
 * tenant is ambient (TenantContext, #76) and every query ALSO filters by
 * tenant_id - the two layers of every repository (architecture §3.3), guarding
 * the one env var (DATABASE_URL vs APP_DATABASE_URL) that would boot without RLS
 * in force. It reaches into `unit` for the ownership check and `booking` for the
 * export/keep counts the same way units.repository reaches into `property`:
 * repositories query tables, not modules.
 */
@Injectable()
export class ChannelsRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /** True when the unit exists AND belongs to the caller's tenant (drives the
   * 404-over-403 for an unknown / foreign unit id). */
  async unitExists(unitId: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ id: unit.id })
        .from(unit)
        .where(and(eq(unit.id, unitId), eq(unit.tenantId, tenantId)))
        .limit(1),
    );
    return rows.length > 0;
  }

  /** The existing connection for this (unit, channel), or null - the app-level
   * pre-check that gives a friendly 409 without a wasted smoke fetch. The
   * `channel_connection_unit_channel_uniq` constraint is the real guard behind it
   * (a race can slip between this read and the insert). */
  async findByUnitAndChannel(
    unitId: string,
    channel: Channel,
  ): Promise<ChannelConnection | null> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select()
        .from(channelConnection)
        .where(
          and(
            eq(channelConnection.unitId, unitId),
            eq(channelConnection.channel, channel),
            eq(channelConnection.tenantId, tenantId),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async create(
    values: Omit<typeof channelConnection.$inferInsert, 'tenantId'>,
  ): Promise<ChannelConnection> {
    const tenantId = this.tenant.tenantId;
    const [row] = await this.db.run((tx) =>
      tx
        .insert(channelConnection)
        .values({ ...values, tenantId })
        .returning(),
    );
    return row;
  }

  /** Every connection on this unit, stable order (created_at then id, so rows
   * inserted in one transaction don't tie into heap order). */
  findByUnit(unitId: string): Promise<ChannelConnection[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select()
        .from(channelConnection)
        .where(
          and(
            eq(channelConnection.unitId, unitId),
            eq(channelConnection.tenantId, tenantId),
          ),
        )
        .orderBy(asc(channelConnection.createdAt), asc(channelConnection.id)),
    );
  }

  async findById(id: string): Promise<ChannelConnection | null> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select()
        .from(channelConnection)
        .where(
          and(
            eq(channelConnection.id, id),
            eq(channelConnection.tenantId, tenantId),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /** How many bookings were imported through this connection (api-spec §7.4). The
   * disconnect KEEPS them - the `booking.channel_connection_id` FK is `set null`,
   * so they survive the delete - and this count is reported so the owner can clean
   * up deliberately. Counted BEFORE the delete, or the set-null makes it zero. */
  async countImportedBookings(connectionId: string): Promise<number> {
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx) => {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(booking)
        .where(
          and(
            eq(booking.channelConnectionId, connectionId),
            eq(booking.tenantId, tenantId),
          ),
        );
      return n;
    });
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.tenant.tenantId;
    await this.db.run((tx) =>
      tx
        .delete(channelConnection)
        .where(
          and(
            eq(channelConnection.id, id),
            eq(channelConnection.tenantId, tenantId),
          ),
        ),
    );
  }

  /**
   * The export feed's read (api-spec §7.6): every CONFIRMED booking on this unit
   * - direct, imported, and manual blocks (all born/settled `confirmed`) - as the
   * three PII-free columns buildCalendar needs. NOT `pending_payment` holds: a
   * transient 15-min hold is not a stay to publish to an OTA.
   *
   * Runs under the Visitor scope PublicScope.enterFromUnitId minted, so RLS scopes
   * it to the resolved tenant; the explicit tenant_id WHERE is the second layer.
   * Ordered by check-in so the .ics is stable across pulls (helps client dedup).
   */
  findConfirmedBookingsForExport(unitId: string): Promise<ExportableBooking[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select({
          id: booking.id,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        })
        .from(booking)
        .where(
          and(
            eq(booking.unitId, unitId),
            eq(booking.tenantId, tenantId),
            eq(booking.status, 'confirmed'),
            // Only nights an OTA still cares about: drop stays that fully ended
            // before today, so the feed doesn't grow unbounded with years of
            // history. `>= current_date` (inclusive) keeps an in-progress stay -
            // its check_out is still in the future - and errs to the safe side of
            // any timezone slop, which is fine for a coarse availability feed.
            sql`${booking.checkOut} >= current_date`,
          ),
        )
        .orderBy(asc(booking.checkIn), asc(booking.id)),
    );
  }
}
