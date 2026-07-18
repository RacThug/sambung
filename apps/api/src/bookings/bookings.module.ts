import { Module } from '@nestjs/common';
import { AvailabilityRepository } from './availability.repository';
import { AvailabilityService } from './availability.service';
import { BookingsRepository } from './bookings.repository';
import { BookingsService } from './bookings.service';
import { HoldSweeperService } from './hold-sweeper.service';
import { PublicAvailabilityController } from './public-availability.controller';
import { PublicBookingsController } from './public-bookings.controller';

// The booking domain (boss fights #1 and #2). #47 landed the availability quote;
// #48 adds the booking write (POST /public/bookings) + the hold-expiry sweeper.
// No imports: DbModule and CommonModule (PublicScope, TenantContext) are @Global,
// and both routes are public, so there is no JwtAuthGuard to pull in.
//
// AvailabilityService is exported because #48's booking write reuses quote() as
// its in-transaction availability re-check - the one interval authority.
@Module({
  controllers: [PublicAvailabilityController, PublicBookingsController],
  providers: [
    AvailabilityService,
    AvailabilityRepository,
    BookingsService,
    BookingsRepository,
    HoldSweeperService,
  ],
  exports: [AvailabilityService],
})
export class BookingsModule {}
