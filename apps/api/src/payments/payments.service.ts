import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  paymentSessionResponseSchema,
  toRupiah,
  type PaymentProvider,
  type PaymentSessionResponse,
} from '@sambung/shared';
import { bookingNotPayable } from '../common/db-error/conflicts';
import { PublicScope } from '../common/public-scope.service';
import { TenantDbService } from '../db/tenant-db.service';
import { BookingsRepository } from '../bookings/bookings.repository';
import { depositAmountIdr } from './deposit';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { PaymentsRepository } from './payments.repository';

/**
 * The guest funnel's pay step - `POST /public/bookings/:id/pay` (api-spec §6.1,
 * FR-PAY-1, ADR-0015). Turns a live Hold into a Provider checkout session.
 *
 * The shape (ADR-0015): one transaction, under the tenant the booking id resolves
 * to. Sweep this unit's lapsed holds so "hold expired" and "wrong status" collapse
 * into one post-sweep status read; reuse the booking's open payment session if one
 * exists (retry is idempotent); else mint one - the payment row's own id is the
 * Provider order id, and the amount charged is the Deposit share, snapshotted onto
 * the row so a later deposit-% edit can't change what an open session charges.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly scope: PublicScope,
    private readonly db: TenantDbService,
    private readonly repo: PaymentsRepository,
    private readonly bookings: BookingsRepository,
    private readonly config: ConfigService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async pay(bookingId: string): Promise<PaymentSessionResponse> {
    // Resolve the tenant from the booking id (ADR-0008: pure resolver - 404s an
    // unknown id, judges status nowhere). Everything after runs under RLS as that
    // tenant, so the payment insert/read pass the booking-scoped policy.
    await this.scope.enterFromBookingId(bookingId);

    return this.db.run(async () => {
      // Lock the booking row for the transaction, so concurrent pays serialise and
      // a retry reuses the first's row rather than minting a second.
      const ctx = await this.repo.lockAndLoad(bookingId);
      if (!ctx) {
        // Resolved a tenant a moment ago but the row is gone now - effectively
        // unreachable, since a booking with any history is never hard-deleted
        // (ADR-0002). Treat it as not payable (`expired`): whatever it was, it is
        // no longer a live hold, which is exactly what this 409 says.
        throw bookingNotPayable('expired');
      }

      // Opportunistic intra-tenant sweep (ADR-0009): flip this unit's lapsed-but-
      // unswept holds to `expired` BEFORE reading the status the decision rests on.
      await this.bookings.expireLapsedHolds(ctx.unitId);
      const status = await this.repo.readStatus(bookingId);

      // Payable iff still a live hold. A lapsed hold is now `expired`; a booking
      // that was confirmed/cancelled/expired carries its own status. The blocking
      // status rides as data so the UI says "already confirmed" vs "hold lapsed".
      if (status !== 'pending_payment') {
        throw bookingNotPayable(status ?? 'expired');
      }
      if (ctx.totalPriceIdr === null) {
        // A pending_payment hold always carries a price - a null is corruption,
        // not a booking. Fail loud (500), never charge an unknown amount.
        throw new InternalServerErrorException(
          'A pending booking is missing its price',
        );
      }

      // Idempotent retry: an open session is returned unchanged - no second
      // Provider call, no second order id.
      const open = await this.repo.findOpenSession(bookingId);
      if (open) {
        return this.toResponse(
          open.provider,
          open.token,
          open.redirectUrl,
          open.amountIdr,
          ctx.totalPriceIdr,
        );
      }

      // Mint. The amount is the Deposit share, floored (BigInt, invariant #6).
      const amountIdr = depositAmountIdr(ctx.totalPriceIdr, ctx.depositPct);

      // The payment id is generated FIRST and used as the Provider order id, so a
      // gateway failure below leaves no row (a clean retry), and the row we insert
      // already carries the session it returned.
      const paymentId = randomUUID();
      const webBase = this.config.get<string>('WEB_BASE_URL');
      const session = await this.gateway.createSession({
        orderId: paymentId,
        amountIdr: Number(toRupiah(amountIdr)),
        itemName: `${ctx.propertyName} - ${ctx.unitName}`,
        customer: {
          name: ctx.guestName,
          phone: ctx.guestPhone,
          email: ctx.guestEmail,
        },
        finishUrl: webBase ? `${webBase}/booking/${bookingId}` : null,
      });
      await this.repo.insertPaymentWithSession({
        id: paymentId,
        bookingId,
        provider: this.gateway.provider,
        amountIdr,
        session,
      });

      return this.toResponse(
        this.gateway.provider,
        session.token,
        session.redirectUrl,
        amountIdr,
        ctx.totalPriceIdr,
      );
    });
  }

  /**
   * Frame the 201 (api-spec §6.1). `deposit` is derived from the AMOUNTS, not the
   * current deposit %: it is true when what's charged now is less than the
   * booking's full total - which is what "is this a partial deposit" means, and is
   * robust to a deposit-% edit after the session was minted (the snapshot wins).
   * Parsed on the way out so the payload cannot silently widen.
   */
  private toResponse(
    provider: PaymentProvider,
    token: string,
    redirectUrl: string,
    amountIdr: bigint,
    totalPriceIdr: bigint,
  ): PaymentSessionResponse {
    return paymentSessionResponseSchema.parse({
      provider,
      token,
      redirectUrl,
      amountIdr: toRupiah(amountIdr),
      deposit: amountIdr < totalPriceIdr,
    });
  }
}
