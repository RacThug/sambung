import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { appUser, booking, payment, property, unit } from '@sambung/db';
import { DbService } from '../db/db.service';
import type { ConfirmationEmailData } from './confirmation-email';

/**
 * Reads the confirmation email's data on the OWNER connection (DbService, RLS
 * bypassed). This runs from the payment webhook's post-commit seam, which - like
 * the reconcile it rides on (ADR-0018) - carries no principal and is PK-targeted
 * by booking id, so it belongs on the owner connection, not TenantDbService. The
 * tenant a booking belongs to is incidental here, not a scope confining the read.
 */
@Injectable()
export class NotificationsRepository {
  constructor(private readonly dbs: DbService) {}

  /**
   * Everything the confirmation email needs for `bookingId`, or null if the
   * booking is gone. Joins the property/unit names and sums the settled payments
   * (the Deposit taken online). Owner emails are the tenant's `owner`-role users.
   */
  async readConfirmationData(
    bookingId: string,
  ): Promise<ConfirmationEmailData | null> {
    const [row] = await this.dbs.db
      .select({
        bookingId: booking.id,
        tenantId: booking.tenantId,
        guestName: booking.guestName,
        guestEmail: booking.guestEmail,
        propertyName: property.name,
        unitName: unit.name,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        totalPriceIdr: booking.totalPriceIdr,
        // Sum of settled payments for this booking, as bigint text (COALESCE 0).
        // `::text` keeps it exact across the wire from pg - never a float.
        amountPaidIdr: sql<string>`coalesce((
          select sum(${payment.amountIdr})
          from ${payment}
          where ${payment.bookingId} = ${booking.id}
            and ${payment.status} = 'paid'
        ), 0)::text`,
      })
      .from(booking)
      .innerJoin(unit, eq(unit.id, booking.unitId))
      .innerJoin(property, eq(property.id, unit.propertyId))
      .where(eq(booking.id, bookingId))
      .limit(1);

    if (!row) return null;

    const owners = await this.dbs.db
      .select({ email: appUser.email })
      .from(appUser)
      .where(
        and(eq(appUser.tenantId, row.tenantId), eq(appUser.role, 'owner')),
      );

    return {
      bookingId: row.bookingId,
      guestName: row.guestName,
      guestEmail: row.guestEmail,
      ownerEmails: owners.map((o) => o.email),
      propertyName: row.propertyName,
      unitName: row.unitName,
      checkIn: row.checkIn,
      checkOut: row.checkOut,
      totalPriceIdr: row.totalPriceIdr,
      amountPaidIdr: BigInt(row.amountPaidIdr),
    };
  }
}
