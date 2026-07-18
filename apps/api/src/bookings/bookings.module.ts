import { Module } from '@nestjs/common';
import { AvailabilityRepository } from './availability.repository';
import { AvailabilityService } from './availability.service';
import { PublicAvailabilityController } from './public-availability.controller';

// The booking domain (boss fights #1 and #2). #47 lands the availability quote;
// #48-51 add the booking write, cancel, calendar, and reservations here. No
// imports: DbModule and CommonModule (PublicScope, TenantContext) are @Global,
// and the availability route is public, so there is no JwtAuthGuard to pull in.
//
// AvailabilityService is exported because #48's booking write reuses quote() as
// its in-transaction availability re-check - the one interval authority.
@Module({
  controllers: [PublicAvailabilityController],
  providers: [AvailabilityService, AvailabilityRepository],
  exports: [AvailabilityService],
})
export class BookingsModule {}
