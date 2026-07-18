import { Body, Controller, Post } from '@nestjs/common';
import {
  createBookingRequestSchema,
  type CreateBookingRequest,
  type CreateBookingResponse,
} from '@sambung/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { BookingsService } from './bookings.service';

/**
 * The guest funnel's checkout (api-spec §5.3, page-spec §3.2) - the third
 * unauthenticated route, and the WRITE half of boss fight #1.
 *
 * No JwtAuthGuard: a Visitor has no token. The unit id is in the BODY (not the
 * path), and the SERVICE enters the tenant scope from it (PublicScope), so this
 * controller stays HTTP only. ZodValidationPipe rejects a malformed body -
 * bad dates, a non-phone contact, an out-of-range guest count - as a 400 naming
 * the field, before the service touches the database. @Post defaults to 201.
 */
@Controller('public/bookings')
export class PublicBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(createBookingRequestSchema))
    body: CreateBookingRequest,
  ): Promise<CreateBookingResponse> {
    return this.bookings.createPublicBooking(body);
  }
}
