import type { PaymentProvider } from '@sambung/shared';
import type {
  CreateSessionInput,
  PaymentGateway,
  PaymentSession,
} from './payment-gateway';

/**
 * The test / offline binding for the Provider boundary (ADR-0015). Bound in place
 * of MidtransGateway via `.overrideProvider(PAYMENT_GATEWAY)`, so the pay endpoint
 * runs end-to-end with no live Midtrans (api-spec §6.1 AC #3).
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
}
