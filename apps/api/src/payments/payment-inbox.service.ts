import { Injectable, NotFoundException } from '@nestjs/common';
import {
  lapsedPaymentSchema,
  markPaymentHandledResponseSchema,
  toRupiah,
  type LapsedPayment,
  type MarkPaymentHandledResponse,
} from '@sambung/shared';
import {
  PaymentInboxRepository,
  type LapsedPaymentRow,
} from './payment-inbox.repository';

/**
 * The paid-but-lapsed payment inbox (#120, ADR-0022) - the owner's reconciliation
 * surface for the late-settlement case boss fight #4 handles silently (ADR-0018).
 * Thin: it turns DB rows into the wire shape and maps the handle outcome to HTTP.
 * The tenant scoping lives in the repository (RLS + `booking.tenant_id`); there is
 * no ownership check to run here because every row it can reach already belongs to
 * the caller's tenant.
 */
@Injectable()
export class PaymentInboxService {
  constructor(private readonly repo: PaymentInboxRepository) {}

  /** AC (a): the owner sees paid payments whose booking is not confirmed, with
   * enough to act (amount, guest, dates). */
  async listLapsed(): Promise<LapsedPayment[]> {
    const rows = await this.repo.listLapsed();
    return rows.map((row) => this.toWire(row));
  }

  /**
   * AC (b): mark one handled, removing it from the list without touching the
   * ledger. The repository's guarded UPDATE writes only `handled_at`; here we frame
   * the outcome: an unknown / cross-tenant / non-inbox id → 404 (404-over-403); a
   * genuine (or already-handled, idempotent) item → 200 with when it was handled.
   */
  async markHandled(id: string): Promise<MarkPaymentHandledResponse> {
    const outcome = await this.repo.markHandled(id);
    if (outcome.kind === 'not_found') {
      throw new NotFoundException('No lapsed payment with that id');
    }
    // Parse on the way out so the payload cannot silently widen.
    return markPaymentHandledResponseSchema.parse({
      paymentId: id,
      handledAt: outcome.handledAt.toISOString(),
    });
  }

  private toWire(row: LapsedPaymentRow): LapsedPayment {
    // Parse on the way out: bigint -> JSON number via toRupiah (invariant #6), and
    // an unexpected provider string (a row written outside the API) fails loud here
    // rather than reaching the client. The payload cannot silently widen.
    return lapsedPaymentSchema.parse({
      paymentId: row.paymentId,
      bookingId: row.bookingId,
      bookingStatus: row.bookingStatus,
      provider: row.provider,
      amountIdr: toRupiah(row.amountIdr),
      guestName: row.guestName,
      guestPhone: row.guestPhone,
      guestEmail: row.guestEmail,
      checkIn: row.checkIn,
      checkOut: row.checkOut,
      propertyName: row.propertyName,
      unitName: row.unitName,
      createdAt: row.createdAt.toISOString(),
    });
  }
}
