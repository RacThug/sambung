import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  listBookingsQuerySchema,
  type BookingRow,
  type ListBookingsQuery,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { BookingsQueryService } from './bookings-query.service';

/**
 * The authed reservations read - `GET /bookings` (api-spec §5.5). The one
 * booking-read path (ADR-0010), feeding the unified calendar (#49) and the
 * reservations list (#51). Guard seeds the TenantContext; the service/repository
 * scope every row by tenant_id. HTTP only - the ZodValidationPipe rejects a bad
 * window / a lone `from` / a >366-night range as a 400 naming the field.
 */
@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private readonly bookings: BookingsQueryService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listBookingsQuerySchema))
    query: ListBookingsQuery,
  ): Promise<BookingRow[]> {
    return this.bookings.list(query);
  }
}
