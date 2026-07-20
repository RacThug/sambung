import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import type { BookingConfirmationResponse } from '@sambung/shared';
import { ConfirmationService } from './confirmation.service';

/**
 * The confirmation page's read - `GET /public/bookings/:id` (api-spec §6.3,
 * page-spec §3.3, #54). The FIFTH unauthenticated route. No JwtAuthGuard: the
 * guest has no token; the unguessable booking UUID is the v1 access control.
 *
 * The SERVICE enters the tenant scope from the id (PublicScope.enterFromBookingId)
 * and reconciles on read, so this controller stays HTTP only. ParseUUIDPipe
 * rejects a non-UUID id as a 400 before any lookup; an unknown-but-valid UUID is
 * a 404 at the resolver. No @ThrottleSensitive: this is a read the guest polls
 * every ~5s while pending (page-spec §3.3), so the generous `default` limit fits.
 */
@Controller('public/bookings')
export class PublicConfirmationController {
  constructor(private readonly confirmation: ConfirmationService) {}

  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BookingConfirmationResponse> {
    return this.confirmation.getConfirmation(id);
  }
}
