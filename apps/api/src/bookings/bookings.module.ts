import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { PAYMENT_GATEWAY } from '../payments/payment-gateway';
import { createPaymentGateway } from '../payments/payment-gateway.factory';
import { AvailabilityRepository } from './availability.repository';
import { AvailabilityService } from './availability.service';
import { BookingsController } from './bookings.controller';
import { BookingsQueryRepository } from './bookings-query.repository';
import { BookingsQueryService } from './bookings-query.service';
import { BookingsRepository } from './bookings.repository';
import { BookingsService } from './bookings.service';
import { HoldSweeperService } from './hold-sweeper.service';
import { PublicAvailabilityController } from './public-availability.controller';
import { PublicBookingsController } from './public-bookings.controller';

// The booking domain (boss fights #1 and #2). #47 landed the availability quote;
// #48 the booking write (POST /public/bookings) + the hold-expiry sweeper; #49
// adds the authed reservations READ (GET /bookings), the one booking-read path
// shared by the calendar and reservations list (ADR-0010).
//
// AuthModule is imported for that read's JwtAuthGuard - the write/quote routes are
// public (a Visitor has no token), but the read is owner-only. DbModule and
// CommonModule (PublicScope, TenantContext) are @Global.
//
// AvailabilityService is exported because #48's booking write reuses quote() as
// its in-transaction availability re-check - the one interval authority.
// BookingsRepository is exported so the payments module (#52) reuses its
// opportunistic hold-sweep (expireLapsedHolds) - one definition of the sweep.
@Module({
  imports: [AuthModule], // provides JwtAuthGuard for the authed read
  controllers: [
    BookingsController,
    PublicAvailabilityController,
    PublicBookingsController,
  ],
  providers: [
    AvailabilityService,
    AvailabilityRepository,
    BookingsService,
    BookingsRepository,
    BookingsQueryService,
    BookingsQueryRepository,
    HoldSweeperService,
    // The SAME factory PaymentsModule binds (a file import - no @Module cycle):
    // the public booking write reads only `requiresCredentials` for the
    // payments_not_configured gate (REQ-PA-04, EARS GW-03). A spec's
    // `.overrideProvider(PAYMENT_GATEWAY)` replaces every binding of the token,
    // so fake-bound suites skip the gate exactly like the e2e env seam does.
    {
      provide: PAYMENT_GATEWAY,
      useFactory: createPaymentGateway,
      inject: [ConfigService],
    },
  ],
  exports: [AvailabilityService, BookingsRepository],
})
export class BookingsModule {}
