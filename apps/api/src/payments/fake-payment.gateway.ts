import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { PaymentProvider } from '@sambung/shared';
import { midtransOutcome } from './midtrans.gateway';
import type {
  CreateSessionInput,
  ParsedPaymentEvent,
  PaymentGateway,
  PaymentSession,
} from './payment-gateway';

/**
 * A test webhook body the fake understands. Deliberately the app's own shape,
 * not Midtrans's wire format - a test builds an event by intent (which order,
 * which status, how much) without recomputing an HMAC. `signatureValid: false`
 * simulates the one thing only the real crypto can produce: a bad signature.
 */
export interface FakeWebhookBody {
  orderId: string;
  transactionId: string;
  transactionStatus: string;
  grossAmountIdr: number;
  signatureValid?: boolean;
}

/**
 * The test / offline binding for the Provider boundary (ADR-0015). Bound in place
 * of MidtransGateway via `.overrideProvider(PAYMENT_GATEWAY)`, so the pay endpoint
 * and the webhook run end-to-end with no live Midtrans (api-spec §6.1 AC #3, #53).
 *
 * Deterministic and inspectable: it echoes the `orderId` into the session so a
 * test can assert which payment row was charged, and counts calls so a test can
 * prove a retry REUSES the open session (gateway called once, not twice).
 */
export class FakePaymentGateway implements PaymentGateway {
  readonly provider: PaymentProvider = 'midtrans';
  readonly calls: CreateSessionInput[] = [];

  createSession(input: CreateSessionInput): Promise<PaymentSession> {
    this.calls.push(input);
    return Promise.resolve({
      token: `fake-token-${input.orderId}`,
      redirectUrl: `https://sandbox.example/pay/${input.orderId}`,
    });
  }

  /**
   * Mirror MidtransGateway.verifyAndParse without the crypto (#53). Reuses the
   * real `midtransOutcome` so the webhook service's transition handling is
   * exercised against the SAME status→outcome mapping prod uses - the fake stands
   * in for the signature, not the semantics.
   */
  verifyAndParse(body: unknown): ParsedPaymentEvent {
    const b = (body ?? {}) as Partial<FakeWebhookBody>;
    if (
      typeof b.orderId !== 'string' ||
      typeof b.transactionId !== 'string' ||
      typeof b.transactionStatus !== 'string' ||
      typeof b.grossAmountIdr !== 'number'
    ) {
      throw new BadRequestException('Malformed webhook payload');
    }
    if (b.signatureValid === false) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return {
      providerEventId: `${b.transactionId}:${b.transactionStatus}`,
      orderId: b.orderId,
      outcome: midtransOutcome(b.transactionStatus),
      // Money as bigint (invariant #6) - the test body carries a plain number for
      // convenience; widen it here, the one place the fake meets the port.
      grossAmountIdr: BigInt(b.grossAmountIdr),
      raw: body,
    };
  }
}
