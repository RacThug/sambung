import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConfirmationService } from './confirmation.service';
import { MidtransGateway } from './midtrans.gateway';
import { PAYMENT_GATEWAY } from './payment-gateway';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PublicConfirmationController } from './public-confirmation.controller';
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
 * BookingsModule is imported for BookingsRepository - the pay path AND the
 * confirmation read reuse its opportunistic hold-sweep (ADR-0009), the one
 * definition of that sweep. NotificationsModule provides the FR-NOTIF-1 email
 * seam the webhook fires on confirm (#54). DbModule and CommonModule (PublicScope,
 * TenantContext) are @Global.
 */
@Module({
  imports: [BookingsModule, NotificationsModule],
  controllers: [
    PublicPaymentsController,
    PublicConfirmationController,
    PaymentWebhookController,
  ],
  providers: [
    PaymentsService,
    PaymentsRepository,
    PaymentWebhookService,
    ConfirmationService,
    { provide: PAYMENT_GATEWAY, useClass: MidtransGateway },
  ],
})
export class PaymentsModule {}
