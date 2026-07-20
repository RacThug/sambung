import { Body, Controller, Post } from '@nestjs/common';
import {
  type CreateBookingRequest,
  type CreateBookingResponse,
} from '@sambung/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ThrottleSensitive } from '../common/throttle/throttle.decorator';
import { BookingsService } from './bookings.service';
import { apiCreateBookingRequestSchema } from './public-booking.schema';

/**
 * The guest funnel's checkout (api-spec §5.3, page-spec §3.2) - the third
 * unauthenticated route, and the WRITE half of boss fight #1.
 *
 * No JwtAuthGuard: a Visitor has no token. The unit id is in the BODY (not the
 * path), and the SERVICE enters the tenant scope from it (PublicScope), so this
 * controller stays HTTP only. ZodValidationPipe rejects a malformed body -
 * bad dates, a non-phone contact, an out-of-range guest count - as a 400 naming
 * the field, before the service touches the database. @Post defaults to 201.
 *
 * The pipe validates against `apiCreateBookingRequestSchema` (the server-only
 * per-country phone validity gate, #124), NOT the shared shape schema directly -
 * see public-booking.schema.ts. The response type is unchanged.
 */
@Controller('public/bookings')
export class PublicBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  // No-auth write → the tighter `sensitive` throttler (api-spec §8.3, #59). One
  // real guest posts once; a script flooding holds to grief the calendar is what
  // this stops (its dead holds would sweep, but the row-flood and lock churn are
  // the abuse). Its own per-handler bucket, independent of the auth routes'.
  @ThrottleSensitive()
  @Post()
  create(
    @Body(new ZodValidationPipe(apiCreateBookingRequestSchema))
    body: CreateBookingRequest,
  ): Promise<CreateBookingResponse> {
    return this.bookings.createPublicBooking(body);
  }
}
