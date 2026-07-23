import type { ConfigService } from '@nestjs/config';
import { FakePaymentGateway } from './fake-payment.gateway';
import { createPaymentGateway } from './payment-gateway.factory';
import { MidtransGateway } from './midtrans.gateway';

/**
 * The env-driven Provider binding (#167 part b). The factory picks the
 * signature-free FakePaymentGateway ONLY on the literal `PAYMENT_GATEWAY=fake`,
 * and the real MidtransGateway on everything else (unset, empty, any other
 * string) - fail safe, not fail open. The prod refusal of `fake` lives in
 * validateEnv (validate-env.spec); this proves the selection itself. Mirrors
 * `mailer.factory.spec`: the factory is a pure function of a fake ConfigService.
 */
describe('createPaymentGateway', () => {
  const config = (env: Record<string, string | undefined>) =>
    ({ get: (key: string) => env[key] }) as unknown as ConfigService;

  it.each(['fake', ' fake '])(
    'returns FakePaymentGateway on PAYMENT_GATEWAY=%p (trimmed, matching validateEnv)',
    (value) => {
      expect(
        createPaymentGateway(config({ PAYMENT_GATEWAY: value })),
      ).toBeInstanceOf(FakePaymentGateway);
    },
  );

  it('returns the real MidtransGateway when unset', () => {
    expect(createPaymentGateway(config({}))).toBeInstanceOf(MidtransGateway);
  });

  it.each(['', 'real', 'midtrans', 'Fake', 'FAKE'])(
    'returns the real MidtransGateway for %p (only the exact "fake" selects the fake)',
    (value) => {
      expect(
        createPaymentGateway(config({ PAYMENT_GATEWAY: value })),
      ).toBeInstanceOf(MidtransGateway);
    },
  );
});
