import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  createOwnerBookingRequestSchema,
  listBookingsQuerySchema,
  type BookingDetail,
  type BookingRow,
  type CancelBookingResponse,
  type CreateOwnerBookingRequest,
  type CreateOwnerBookingResponse,
  type ListBookingsQuery,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { NoBody } from '../common/decorators/no-body.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { BookingsQueryService } from './bookings-query.service';
import { BookingsService } from './bookings.service';

/**
 * The authed booking surface - `/bookings` (api-spec §5.4-5.7). Reads (list,
 * detail) go through BookingsQueryService; writes (owner create, cancel) through
 * BookingsService. The guard seeds the TenantContext, so every service call runs
 * on the owner RLS connection and scopes by tenant_id. HTTP only - validation is
 * the ZodValidationPipe / ParseUUIDPipe; the FSM and overlap guards live below.
 */
@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(
    private readonly reads: BookingsQueryService,
    private readonly writes: BookingsService,
  ) {}

  // The one booking-read path (ADR-0010): the unified calendar (#49) and the
  // reservations list (#51). A bad window / lone `from` / >366-night range → 400.
  @Get()
  list(
    @Query(new ZodValidationPipe(listBookingsQuerySchema))
    query: ListBookingsQuery,
  ): Promise<BookingRow[]> {
    return this.reads.list(query);
  }

  // CSV twin of the list (api-spec §5.5, #59) - the SAME filters, `text/csv`.
  // Declared BEFORE `:id` so `export.csv` is a literal route, not a booking id.
  // `@Header` makes Nest send the returned string as a CSV attachment, not JSON.
  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="reservations.csv"')
  exportCsv(
    @Query(new ZodValidationPipe(listBookingsQuerySchema))
    query: ListBookingsQuery,
  ): Promise<string> {
    return this.reads.exportCsv(query);
  }

  // Manual block / walk-in (api-spec §5.4, ADR-0011). Body is discriminated on
  // `source`; born confirmed. Overlap → 409; archived unit → 409; unknown → 404.
  @Post()
  create(
    @Body(new ZodValidationPipe(createOwnerBookingRequestSchema))
    dto: CreateOwnerBookingRequest,
  ): Promise<CreateOwnerBookingResponse> {
    return this.writes.createOwnerBooking(dto);
  }

  // Booking detail (api-spec §5.7) - the deep-linkable single-booking read behind
  // /app/bookings/:id. Unknown / cross-tenant id → 404 (404-over-403).
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BookingDetail> {
    return this.reads.getById(id);
  }

  // Cancel (api-spec §5.6). Verb-subresource, like archive; FSM-guarded. 200 +
  // { status, refund }; already-terminal → 409; unknown → 404.
  @Post(':id/cancel')
  @HttpCode(200)
  @NoBody()
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CancelBookingResponse> {
    return this.writes.cancel(id);
  }
}
