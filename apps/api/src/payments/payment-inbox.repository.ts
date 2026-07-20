import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { booking, payment, property, unit } from '@sambung/db';
import type { BookingStatus } from '@sambung/shared';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

/** The DB-shaped row the inbox list returns; the service maps it to the wire
 * `LapsedPayment` (bigint -> number, Date -> ISO). Whole guest disclosure - the
 * owner owns the ledger (the mirror of the public read's clip, ADR-0010). */
export interface LapsedPaymentRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: BookingStatus;
  provider: string; // `payment.provider` is text; the service's zod narrows it
  amountIdr: bigint;
  guestName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
  checkIn: string;
  checkOut: string;
  propertyName: string;
  unitName: string;
  createdAt: Date;
}

/** The outcome of a handle. `handled` = the marker is set (freshly, or it already
 * was - idempotent), carrying WHEN; `not_found` = no lapsed-paid payment with that
 * id for this tenant (unknown, cross-tenant, or not an inbox item) → 404. */
export type HandleOutcome =
  | { kind: 'handled'; handledAt: Date }
  | { kind: 'not_found' };

/**
 * "Lapsed" here = a booking that no longer holds its dates but for which money was
 * captured: `expired` (hold swept) or `cancelled`. The two terminal, non-confirmed
 * states. Shared by the list and the handle guard so both mean exactly the same
 * thing by "lapsed" - one predicate, no drift (the reason `conditions()` is shared
 * between the bookings list and its CSV export).
 */
const LAPSED_STATUSES: readonly BookingStatus[] = ['expired', 'cancelled'];

/**
 * The paid-but-lapsed inbox's dumb repository (#120, ADR-0022). Drizzle only, via
 * the tenant-scoped (RLS) client. `payment` has no `tenant_id` of its own - its RLS
 * policy scopes through the booking join - so every method here ALSO joins/filters
 * by `booking.tenant_id`: the second layer beside RLS (architecture §3.3), the one
 * a reviewer greps for and the one that guards RLS not being in force. A reviewer
 * trying to read another tenant's paid-but-lapsed rows is refused by BOTH.
 */
@Injectable()
export class PaymentInboxRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * Every paid payment whose booking is lapsed (expired/cancelled) and which the
   * owner has NOT yet marked handled, with the booking/unit/property detail the
   * owner needs to act. Newest payment first. Scoped by `booking.tenant_id` on
   * every join key (beside RLS).
   */
  listLapsed(): Promise<LapsedPaymentRow[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select({
          paymentId: payment.id,
          bookingId: booking.id,
          bookingStatus: booking.status,
          provider: payment.provider,
          amountIdr: payment.amountIdr,
          guestName: booking.guestName,
          guestPhone: booking.guestPhone,
          guestEmail: booking.guestEmail,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          propertyName: property.name,
          unitName: unit.name,
          createdAt: payment.createdAt,
        })
        .from(payment)
        .innerJoin(
          booking,
          and(
            eq(booking.id, payment.bookingId),
            eq(booking.tenantId, tenantId),
          ),
        )
        .innerJoin(
          unit,
          and(eq(unit.id, booking.unitId), eq(unit.tenantId, booking.tenantId)),
        )
        .innerJoin(
          property,
          and(
            eq(property.id, unit.propertyId),
            eq(property.tenantId, booking.tenantId),
          ),
        )
        .where(
          and(
            eq(payment.status, 'paid'),
            isNull(payment.handledAt),
            inArray(booking.status, [...LAPSED_STATUSES]),
          ),
        )
        // Newest captured money first; id breaks ties for a stable order.
        .orderBy(desc(payment.createdAt), asc(payment.id)),
    );
  }

  /**
   * Mark one lapsed-paid payment handled. The write is a guarded UPDATE that sets
   * ONLY `handled_at` - it never touches `payment.status` (stays `paid`) or the
   * booking (stays expired/cancelled), so the ledger is untouched (ADR-0002). The
   * guard IS the inbox predicate (paid + lapsed + tenant-owned + not yet handled),
   * so a payment that isn't a genuine inbox item can never be marked.
   *
   * On 0 rows we distinguish idempotent-already-handled from truly-absent: a second
   * click (or a stale list) finds the same lapsed-paid row already handled and
   * returns its `handledAt` (200, no-op); anything else - unknown id, another
   * tenant's payment, a payment that isn't lapsed-paid - is `not_found` (404). A
   * cross-tenant id is invisible under RLS AND fails the `tenant_id` join, so it
   * reads as absent (404-over-403).
   */
  markHandled(id: string): Promise<HandleOutcome> {
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx): Promise<HandleOutcome> => {
      const updated = await tx
        .update(payment)
        .set({ handledAt: sql`now()` })
        .where(
          and(
            eq(payment.id, id),
            eq(payment.status, 'paid'),
            isNull(payment.handledAt),
            sql`exists (
              select 1 from ${booking} b
              where b.id = ${payment.bookingId}
                and b.tenant_id = ${tenantId}
                and b.status in (${sql.join(
                  LAPSED_STATUSES.map((s) => sql`${s}`),
                  sql`, `,
                )})
            )`,
          ),
        )
        .returning({ handledAt: payment.handledAt });
      if (updated.length > 0 && updated[0].handledAt) {
        return { kind: 'handled', handledAt: updated[0].handledAt };
      }

      // 0 rows: was it an already-handled lapsed-paid item for THIS tenant?
      // (idempotent) - vs unknown / cross-tenant / not-an-inbox-item (→ 404).
      const existing = await tx
        .select({ handledAt: payment.handledAt })
        .from(payment)
        .innerJoin(
          booking,
          and(
            eq(booking.id, payment.bookingId),
            eq(booking.tenantId, tenantId),
          ),
        )
        .where(
          and(
            eq(payment.id, id),
            eq(payment.status, 'paid'),
            inArray(booking.status, [...LAPSED_STATUSES]),
          ),
        )
        .limit(1);
      const row = existing[0];
      if (row?.handledAt) {
        return { kind: 'handled', handledAt: row.handledAt };
      }
      return { kind: 'not_found' };
    });
  }
}
