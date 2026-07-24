import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { BookingsModule } from '../bookings/bookings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConfirmationService } from './confirmation.service';
import { PAYMENT_GATEWAY } from './payment-gateway';
import { createPaymentGateway } from './payment-gateway.factory';
import { PaymentInboxController } from './payment-inbox.controller';
import { PaymentInboxRepository } from './payment-inbox.repository';
import { PaymentInboxService } from './payment-inbox.service';
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
 * The Provider boundary (ADR-0015): PAYMENT_GATEWAY is bound by `createPaymentGateway`,
 * which reads the environment - the real MidtransGateway in prod/dev, and the
 * FakePaymentGateway only when `PAYMENT_GATEWAY=fake` (the e2e-only seam, #167).
 * That env value is refused by `validateEnv` on any process that cannot prove it
 * is a local sandbox (#193), so the fake cannot bind on a live server. Tests
 * still `.overrideProvider(PAYMENT_GATEWAY).useValue(new
 * FakePaymentGateway())`, so no jest suite reaches live Midtrans either.
 *
 * BookingsModule is imported for BookingsRepository - the pay path AND the
 * confirmation read reuse its opportunistic hold-sweep (ADR-0009), the one
 * definition of that sweep. NotificationsModule provides the FR-NOTIF-1 email
 * seam the webhook fires on confirm (#54). AuthModule provides JwtAuthGuard for
 * the authed owner inbox (#120) - the rest of this module is the public funnel +
 * the no-principal webhook, so it is the first authed surface here. DbModule and
 * CommonModule (PublicScope, TenantContext) are @Global.
 */
@Module({
  imports: [AuthModule, BookingsModule, NotificationsModule],
  controllers: [
    PublicPaymentsController,
    PublicConfirmationController,
    PaymentWebhookController,
    PaymentInboxController,
  ],
  providers: [
    PaymentsService,
    PaymentsRepository,
    PaymentWebhookService,
    ConfirmationService,
    PaymentInboxService,
    PaymentInboxRepository,
    {
      provide: PAYMENT_GATEWAY,
      useFactory: createPaymentGateway,
      inject: [ConfigService],
    },
  ],
})
export class PaymentsModule {}
