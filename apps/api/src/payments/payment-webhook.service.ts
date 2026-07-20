import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  booking,
  payment,
  paymentEvent,
  pgError,
  type DbTx,
} from '@sambung/db';
import { paymentProviderSchema, type PaymentProvider } from '@sambung/shared';
import { DbService } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type ParsedPaymentEvent,
  type PaymentOutcome,
} from './payment-gateway';

/** The unique constraint on `payment_event (provider, provider_event_id)`. A
 * violation here is not an error - it is the idempotency mechanism firing
 * ("already processed"), caught OUTSIDE the transaction and turned into a 200. */
const PAYMENT_EVENT_UNIQ = 'payment_event_provider_event_uniq';

/** What one webhook delivery did, decided inside the transaction and acted on
 * (logs, the notification seam) only AFTER it commits. */
type ApplyResult =
  | { kind: 'unknown_order' }
  | {
      kind: 'amount_mismatch';
      bookingId: string;
      expected: bigint;
      got: bigint;
    }
  | { kind: 'settlement'; bookingId: string; confirmed: boolean }
  | { kind: 'failure'; bookingId: string }
  | { kind: 'noop'; outcome: PaymentOutcome };

/**
 * The idempotent payment webhook - boss fight #4 (api-spec §6.2, FR-PAY-2, #53).
 * The Provider delivers settlement AT-LEAST-ONCE, so this endpoint must be
 * duplicate-proof and race-proof.
 *
 * THE CONNECTION (ADR-0018). This runs on the OWNER connection (DbService, RLS
 * bypassed), like the cron sweepers - not under RLS via a resolver. A webhook is
 * a SYSTEM reconciliation of money the platform brokered, not an actor browsing
 * one tenant's data; it carries no principal, and every statement here is
 * PK-targeted on a row we resolved by its globally-unique id, so there is no
 * tenant-scoped WHERE for RLS to backstop. The tenant a payment belongs to is
 * incidental, not a scope the caller is confined to.
 *
 * THE IDEMPOTENCY (api-spec §6.2). Inside ONE transaction: INSERT the
 * `payment_event` row, then apply the state change. The event's unique
 * constraint is the arbiter - a redelivery, or the loser of two concurrent
 * deliveries, hits it and we return 200 having changed nothing. Because the
 * insert and the state change share the transaction, a crash between them rolls
 * back BOTH: the provider's redelivery is not seen as a duplicate and replays
 * cleanly. The duplicate is caught OUTSIDE the transaction (Postgres aborts the
 * whole transaction on any error, 25P02 - db-error interceptor docstring).
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly dbs: DbService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Handle one delivery. Always returns (200) for a well-formed, verified event -
   * including a duplicate; providers retry non-2xx forever. Throws only for the
   * signature (401), an unknown provider (404), a malformed body (400), or a
   * genuine server fault (500, which the provider then correctly retries).
   */
  async handle(providerParam: string, body: unknown): Promise<void> {
    // Unknown provider → 404 (api-spec §6.2). Verify + translate behind the port,
    // which throws 401 on a bad signature and 400 on a malformed body BEFORE
    // anything trusts the payload (invariant: trust no external input).
    const provider = this.resolveProvider(providerParam);
    const event = this.gateway.verifyAndParse(body);

    let result: ApplyResult;
    try {
      result = await this.dbs.db.transaction((tx) =>
        this.apply(tx, provider, event),
      );
    } catch (err) {
      if (pgError(err)?.constraint === PAYMENT_EVENT_UNIQ) {
        // The idempotency constraint fired: already processed. Changing nothing
        // is exactly right - return 200.
        this.logger.log(
          `Duplicate webhook ${provider}:${event.providerEventId} - no-op`,
        );
        return;
      }
      throw err;
    }

    await this.afterCommit(result, event);
  }

  /**
   * Reconcile-on-read (#54, api-spec §6.3, risk R3). The confirmation page PULLS
   * the Provider's current status for a still-pending booking; a lost webhook
   * still confirms here. This drives the EXACT SAME idempotent transition the
   * pushed webhook does - one `payment_event` insert keyed on
   * `(provider, provider_event_id)`, one status-guarded confirm - so whichever
   * path arrives first wins, and the confirmation (and its email) happens exactly
   * once. A redelivery, or the path that loses the race, hits the unique
   * constraint and no-ops BEFORE `afterCommit`, so it can never re-notify.
   *
   * Runs on the OWNER connection like `handle` (ADR-0018): it is the same system
   * reconciliation, PK-targeted by `order_id`, carrying no principal. The caller
   * (the confirmation view service, under the Visitor's RLS scope) swallows any
   * throw - a provider hiccup must not break the read.
   */
  async reconcile(orderId: string): Promise<void> {
    const event = await this.gateway.fetchStatus(orderId);
    if (!event) return; // provider has no record (guest hasn't paid) - nothing to do

    let result: ApplyResult;
    try {
      result = await this.dbs.db.transaction((tx) =>
        this.apply(tx, this.gateway.provider, event),
      );
    } catch (err) {
      if (pgError(err)?.constraint === PAYMENT_EVENT_UNIQ) {
        // Already processed (the webhook won, or a prior reconcile) - no-op.
        this.logger.log(
          `Reconcile ${this.gateway.provider}:${event.providerEventId} already processed - no-op`,
        );
        return;
      }
      throw err;
    }

    await this.afterCommit(result, event);
  }

  /**
   * Inside the transaction: resolve the payment by `order_id` (= `payment.id`,
   * ADR-0015), record the event, then apply the transition. The record comes
   * FIRST so a failure in `applyOutcome` rolls the event insert back with it.
   */
  private async apply(
    tx: DbTx,
    provider: PaymentProvider,
    event: ParsedPaymentEvent,
  ): Promise<ApplyResult> {
    const [pay] = await tx
      .select({
        id: payment.id,
        bookingId: payment.bookingId,
        amountIdr: payment.amountIdr,
      })
      .from(payment)
      .where(eq(payment.id, event.orderId))
      .limit(1);

    if (!pay) {
      // A validly-signed event for an order we don't have. Only the Provider
      // knows the server key, so this is anomalous (e.g. another environment
      // sharing the sandbox account). Ack it so it doesn't retry forever; the
      // WARN is logged after commit. Nothing recorded: no booking to reference.
      return { kind: 'unknown_order' };
    }

    // Record the event. A duplicate throws 23P01/23505 on this INSERT, aborting
    // the whole transaction - which is the idempotency guarantee, caught in
    // `handle`. The verified payload rides along for audit (migration 0010),
    // never overwriting payment.raw_payload (the open session a retry reads).
    await tx.insert(paymentEvent).values({
      provider,
      providerEventId: event.providerEventId,
      bookingId: pay.bookingId,
      rawPayload: event.raw,
    });

    return this.applyOutcome(tx, event, pay);
  }

  /**
   * The state transition, split out so it is a seam a test can fault to prove
   * the event insert and the state change are one atomic unit (AC #4). Every
   * UPDATE is guarded on the CURRENT status, so no re-ordering or replay can
   * un-confirm a paid booking or resurrect a dead one.
   */
  async applyOutcome(
    tx: DbTx,
    event: ParsedPaymentEvent,
    pay: { id: string; bookingId: string; amountIdr: bigint },
  ): Promise<ApplyResult> {
    // Cross-check the settled amount against the snapshot (defense in depth).
    // The signature already covers gross_amount, so a mismatch means our record
    // and the Provider disagree - refuse to confirm, record + flag for review.
    // Both sides are bigint (invariant #6): no float ever enters the comparison.
    if (event.grossAmountIdr !== pay.amountIdr) {
      return {
        kind: 'amount_mismatch',
        bookingId: pay.bookingId,
        expected: pay.amountIdr,
        got: event.grossAmountIdr,
      };
    }

    switch (event.outcome) {
      case 'settlement': {
        // pending → paid. Guarded so a stray later event can never flip a
        // paid/failed payment.
        await tx
          .update(payment)
          .set({ status: 'paid' })
          .where(and(eq(payment.id, pay.id), eq(payment.status, 'pending')));

        // pending_payment → confirmed. Guarded on STATUS, not hold_expires_at: a
        // past-TTL but still-pending hold occupied the nights continuously (the
        // exclusion constraint guaranteed it), so confirming it is safe and
        // correct. An already expired/cancelled booking matches 0 rows and is
        // NEVER resurrected - the late-settlement case, flagged after commit.
        const confirmed = await tx
          .update(booking)
          .set({ status: 'confirmed' })
          .where(
            and(
              eq(booking.id, pay.bookingId),
              eq(booking.status, 'pending_payment'),
            ),
          )
          .returning({ id: booking.id });

        return {
          kind: 'settlement',
          bookingId: pay.bookingId,
          confirmed: confirmed.length > 0,
        };
      }
      case 'failure': {
        // pending → failed. The booking stays pending_payment; the hold keeps
        // ticking until the sweeper expires it (api-spec §6.2). Guarded so a
        // failure after a settlement can't undo the paid state.
        await tx
          .update(payment)
          .set({ status: 'failed' })
          .where(and(eq(payment.id, pay.id), eq(payment.status, 'pending')));
        return { kind: 'failure', bookingId: pay.bookingId };
      }
      default:
        // pending / ignore: recorded for the audit trail, no state change.
        return { kind: 'noop', outcome: event.outcome };
    }
  }

  /**
   * Post-commit side effects (api-spec §6.2 step 3). Logs the outcome and, for a
   * fresh confirmation, fires the notification seam. NONE of this can fail the
   * webhook: the transaction already committed, and the provider must get its 200.
   */
  private async afterCommit(
    result: ApplyResult,
    event: ParsedPaymentEvent,
  ): Promise<void> {
    switch (result.kind) {
      case 'unknown_order':
        this.logger.warn(
          `Verified webhook for unknown order_id ${event.orderId} - acked, no payment found`,
        );
        return;
      case 'amount_mismatch':
        this.logger.error(
          `Amount mismatch on order ${event.orderId}: charged ${result.expected} IDR, ` +
            `provider reports ${result.got} - recorded, NOT confirmed. Manual review.`,
        );
        return;
      case 'settlement':
        if (result.confirmed) {
          await this.notifyConfirmed(result.bookingId);
        } else {
          // Late settlement: money in, but the hold was no longer pending
          // (swept to expired, or cancelled). Never resurrected (ADR-0018);
          // payment is recorded paid and this needs a manual refund/review.
          this.logger.warn(
            `Settlement for booking ${result.bookingId} that was not pending_payment - ` +
              `payment recorded paid, booking NOT confirmed. Manual review (refund?).`,
          );
        }
        return;
      case 'failure':
        this.logger.log(
          `Payment failed for booking ${result.bookingId}; hold keeps ticking until swept`,
        );
        return;
      case 'noop':
        this.logger.log(
          `Webhook ${event.providerEventId} (${result.outcome}) recorded, no state change`,
        );
        return;
    }
  }

  /**
   * The FR-NOTIF-1 seam (#54): confirmation email to guest + owner on `confirmed`.
   * Fires on the transition that happens EXACTLY ONCE across every delivery path
   * (webhook push AND reconcile-on-read pull both reach here only when the
   * status-guarded confirm actually flipped a row), so the email is once-per-
   * confirmation by construction.
   *
   * The invariant it must keep (api-spec §6.2 step 3): a side-effect failure can
   * NEVER fail the webhook - the booking is already confirmed and the money is in.
   * NotificationsService is itself best-effort (it catches and logs), and the
   * defensive try/catch here is a second guarantee that no rejection escapes to
   * the caller. It IS awaited (afterCommit awaits it) so the outcome is
   * deterministic and testable; awaiting a log-backed sender adds nothing the
   * provider will notice.
   */
  private async notifyConfirmed(bookingId: string): Promise<void> {
    try {
      await this.notifications.notifyBookingConfirmed(bookingId);
    } catch (err) {
      this.logger.error(
        `Confirmation notification failed for booking ${bookingId}: ${String(err)}`,
      );
    }
  }

  /**
   * Map the `:provider` path segment to a Provider, or 404 (api-spec §6.2).
   * Validated against the closed set in `@sambung/shared`, and asserted to be the
   * adapter actually bound - a future second provider must be wired, not silently
   * handled by the wrong gateway.
   */
  private resolveProvider(providerParam: string): PaymentProvider {
    const parsed = paymentProviderSchema.safeParse(providerParam);
    if (!parsed.success || parsed.data !== this.gateway.provider) {
      throw new NotFoundException(`Unknown payment provider: ${providerParam}`);
    }
    return parsed.data;
  }
}
