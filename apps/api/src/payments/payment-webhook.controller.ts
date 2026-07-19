import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { PaymentWebhookService } from './payment-webhook.service';

/**
 * The payment provider's webhook - `POST /webhooks/payment/:provider` (api-spec
 * §6.2, boss fight #4, #53). UNAUTHENTICATED: the caller is a payment Provider,
 * not a user - there is no token. It is NOT a `/public` funnel route either; it
 * is a machine-to-machine webhook, so it lives under `/webhooks`.
 *
 * Thin as ever: the service verifies the signature, translates the payload, and
 * runs the idempotent transaction. The body is typed `unknown` on purpose - it is
 * external input, validated at the port (zod) before anything trusts it.
 *
 * `@HttpCode(200)`: a POST defaults to 201, but a provider expects 2xx and, for a
 * duplicate, "already processed" is a 200 - not a "created". Deliberately NOT
 * `@ThrottleSensitive`: a 429 to a provider that treats non-2xx as failure just
 * triggers an endless retry storm (ADR-0014). The generous `default` throttler,
 * which every route carries, is enough.
 */
@Controller('webhooks/payment')
export class PaymentWebhookController {
  constructor(private readonly webhook: PaymentWebhookService) {}

  @Post(':provider')
  @HttpCode(200)
  async handle(
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<{ received: true }> {
    await this.webhook.handle(provider, body);
    return { received: true };
  }
}
