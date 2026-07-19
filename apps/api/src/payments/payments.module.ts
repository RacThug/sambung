import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { MidtransGateway } from './midtrans.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PublicPaymentsController } from './public-payments.controller';

/**
 * The payment domain (boss fight #4 lives here). #52 lands the pay step (the
 * Provider session + Deposit); #53 (webhook → confirmed) and #54 (confirmation
 * reconcile) join it.
 *
 * The Provider boundary (ADR-0015): PAYMENT_GATEWAY is bound to MidtransGateway in
 * prod/dev; tests `.overrideProvider(PAYMENT_GATEWAY).useValue(new
 * FakePaymentGateway())`, so no suite reaches live Midtrans. FakePaymentGateway is
 * deliberately NOT in this DI graph - a fake wired into prod would be a foot-gun;
 * the test constructs it directly and overrides the token.
 *
 * BookingsModule is imported for BookingsRepository - the pay path reuses its
 * opportunistic hold-sweep (ADR-0009), the one definition of that sweep. DbModule
 * and CommonModule (PublicScope, TenantContext) are @Global.
 */
@Module({
  imports: [BookingsModule],
  controllers: [PublicPaymentsController, PaymentWebhookController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    PaymentWebhookService,
    { provide: PAYMENT_GATEWAY, useClass: MidtransGateway },
  ],
})
export class PaymentsModule {}
