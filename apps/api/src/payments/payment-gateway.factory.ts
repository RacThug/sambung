import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FakePaymentGateway } from './fake-payment.gateway';
import { MidtransGateway } from './midtrans.gateway';
import type { PaymentGateway } from './payment-gateway';

/**
 * Choose the payment adapter from the environment (#167 part b). Prod and dev bind
 * the real `MidtransGateway`; `PAYMENT_GATEWAY=fake` binds the deterministic,
 * signature-free `FakePaymentGateway`, so the e2e stack can drive a booking to
 * `confirmed` (reconcile-on-read / a fake webhook POST) with NO outbound call to
 * Midtrans - the real gateway reconciles against a live Snap status API and the
 * webhook verifies a real signature, neither of which a browser can produce.
 *
 * This DELIBERATELY departs from ADR-0015, which kept the fake OUT of the DI graph
 * ("a fake wired into prod would be a foot-gun") and swapped it only in jest via
 * `.overrideProvider`. That mechanism cannot reach a REAL running API process -
 * which is exactly what Playwright boots - so a browser-drivable seam has to be an
 * env switch. The foot-gun ADR-0015 named is closed by `validateEnv` refusing to
 * boot with `PAYMENT_GATEWAY=fake` (the same fail-fast shape ADR-0029 uses for
 * STORAGE_BOOTSTRAP). That refusal originally required `NODE_ENV=production`,
 * which nothing in this repo sets - so the "structural, not discipline" claim
 * rested on a variable an operator had to remember. Since #193 the guard fires
 * whenever the process cannot prove it is a local sandbox (`deployment-env.ts`),
 * so any box that sends a guest's browser to a public host refuses to boot with
 * the fake bound. Only the literal `fake` selects the fake; every other value
 * (and unset) is the real gateway - fail safe, not fail open. Binding the fake is
 * announced with a WARN so an unexpected fake in any log is loud.
 *
 * A factory over the previous `useClass`, mirroring `createMailer` (the mailer's
 * env-selected binding). Tests still `.overrideProvider(PAYMENT_GATEWAY)`, which
 * replaces the token regardless of whether it is bound by class or factory - so
 * no existing suite changes.
 *
 * The `'fake'` comparison is `.trim()`ed to match `validateEnv` byte-for-byte -
 * the same string decides "bind the fake here" and "refuse to boot in prod", so
 * the two must never disagree about which values count (a whitespace-padded value
 * that bound the fake but slipped past the guard would be the exact drift this
 * avoids).
 */
export function createPaymentGateway(config: ConfigService): PaymentGateway {
  if (config.get<string>('PAYMENT_GATEWAY')?.trim() === 'fake') {
    new Logger('PaymentGateway').warn(
      'PAYMENT_GATEWAY=fake - binding FakePaymentGateway (no live Midtrans). ' +
        'This is an e2e-only seam and must never happen in production ' +
        '(validateEnv refuses it).',
    );
    return new FakePaymentGateway();
  }
  return new MidtransGateway(config);
}
