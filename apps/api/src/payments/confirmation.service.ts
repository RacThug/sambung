import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  bookingConfirmationResponseSchema,
  buildWaMeLink,
  toRupiah,
  type BookingConfirmationResponse,
} from '@sambung/shared';
import { BookingsRepository } from '../bookings/bookings.repository';
import { PublicScope } from '../common/public-scope.service';
import { TenantDbService } from '../db/tenant-db.service';
import { PaymentWebhookService } from './payment-webhook.service';
import {
  PaymentsRepository,
  type ConfirmationView,
} from './payments.repository';

/**
 * The confirmation page's read - `GET /public/bookings/:id` (api-spec §6.3,
 * page-spec §3.3, #54). The page the guest lands on after paying: live status
 * that RECONCILES against the Provider on read, so a lost webhook still confirms
 * here (risk R3).
 *
 * The shape (ADR-0020):
 *  1. Resolve the tenant from the booking id (the third pure resolver, ADR-0008)
 *     - an unknown id is a 404 at the door.
 *  2. Reconcile if still pending: pull the Provider's status and drive the SAME
 *     idempotent transition the webhook does (PaymentWebhookService.reconcile, on
 *     the owner connection). Then opportunistically sweep a lapsed hold so an
 *     unpaid, past-TTL booking reads as `expired` immediately, not on the next
 *     cron tick (ADR-0009). Both best-effort - a provider hiccup must not break
 *     the read.
 *  3. Read the (possibly just-confirmed) view under the Visitor's RLS scope and
 *     frame it, building the wa.me deeplink (FR-NOTIF-2).
 */
@Injectable()
export class ConfirmationService {
  private readonly logger = new Logger(ConfirmationService.name);

  constructor(
    private readonly scope: PublicScope,
    private readonly db: TenantDbService,
    private readonly repo: PaymentsRepository,
    private readonly bookings: BookingsRepository,
    private readonly webhook: PaymentWebhookService,
  ) {}

  async getConfirmation(
    bookingId: string,
  ): Promise<BookingConfirmationResponse> {
    // Resolve the tenant (404s an unknown id, ADR-0008). Everything after runs
    // under RLS as that tenant.
    await this.scope.enterFromBookingId(bookingId);

    await this.reconcileOnRead(bookingId);

    return this.db.run(async () => {
      const view = await this.repo.readConfirmationView(bookingId);
      if (!view) {
        // Resolved a tenant a moment ago but the row is gone - unreachable in
        // practice (a booking with history is never hard-deleted, ADR-0002).
        throw new NotFoundException('Booking not found');
      }
      return this.frame(view);
    });
  }

  /**
   * Reconcile-on-read (risk R3): if the booking is still pending, ask the
   * Provider and apply the same confirm the webhook would, then sweep a lapsed
   * hold. Every step is best-effort - the read must render the DB's current truth
   * even if the Provider is unreachable (the client polls and retries).
   */
  private async reconcileOnRead(bookingId: string): Promise<void> {
    // One RLS read: is there anything to reconcile, and which unit to sweep?
    const info = await this.db.run(async () => {
      const bk = await this.repo.readStatusAndUnit(bookingId);
      if (!bk || bk.status !== 'pending_payment') return null;
      const orderId = await this.repo.findPendingPaymentOrderId(bookingId);
      return { unitId: bk.unitId, orderId };
    });
    if (!info) return; // already terminal (confirmed/expired/cancelled) - nothing to do

    // Pull the Provider's status and apply the shared idempotent transition, on
    // the owner connection (ADR-0018). Only when a payment session actually
    // exists - otherwise the Provider has no order to report on.
    if (info.orderId) {
      try {
        await this.webhook.reconcile(info.orderId);
      } catch (err) {
        this.logger.warn(
          `reconcile-on-read failed for booking ${bookingId}: ${String(err)}`,
        );
      }
    }

    // Opportunistic hold-sweep (ADR-0009), AFTER reconcile: a booking the reconcile
    // just confirmed is no longer pending_payment, so the status-guarded sweep
    // skips it; an unpaid, past-TTL hold flips to `expired` so the page tells the
    // truth now, not on the 5-min cron.
    try {
      await this.db.run(() => this.bookings.expireLapsedHolds(info.unitId));
    } catch (err) {
      this.logger.warn(
        `hold sweep on read failed for booking ${bookingId}: ${String(err)}`,
      );
    }
  }

  /** Frame the 200 (api-spec §6.3). Money through toRupiah (invariant #6); the
   * wa.me deeplink is built from the guest's own number (FR-NOTIF-2), null when
   * there is no usable phone. Parsed on the way out so the payload can't widen. */
  private frame(v: ConfirmationView): BookingConfirmationResponse {
    return bookingConfirmationResponseSchema.parse({
      status: v.status,
      checkIn: v.checkIn,
      checkOut: v.checkOut,
      propertyName: v.propertyName,
      unitName: v.unitName,
      totalPriceIdr:
        v.totalPriceIdr === null ? null : toRupiah(v.totalPriceIdr),
      amountPaidIdr: toRupiah(v.amountPaidIdr),
      // Clamped at zero: a settlement above the total is a reconciliation problem
      // for the owner (the paid-but-lapsed inbox exists for that family of case),
      // not a negative number to show a guest.
      balanceIdr:
        v.totalPriceIdr === null
          ? null
          : toRupiah(
              v.totalPriceIdr > v.amountPaidIdr
                ? v.totalPriceIdr - v.amountPaidIdr
                : 0n,
            ),
      waLink: buildWaMeLink({
        phone: v.guestPhone,
        guestName: v.guestName,
        propertyName: v.propertyName,
        unitName: v.unitName,
        checkIn: v.checkIn,
        checkOut: v.checkOut,
      }),
    });
  }
}
