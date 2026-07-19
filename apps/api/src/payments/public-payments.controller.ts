import { Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { PaymentSessionResponse } from '@sambung/shared';
import { ThrottleSensitive } from '../common/throttle/throttle.decorator';
import { PaymentsService } from './payments.service';

/**
 * The guest funnel's pay step (api-spec §6.1, page-spec §3.2) - the FOURTH
 * unauthenticated route. No JwtAuthGuard: a Guest has no token. The booking id is
 * in the path (an unguessable UUID the guest holds from the create response), and
 * the SERVICE enters the tenant scope from it (PublicScope.enterFromBookingId), so
 * this controller stays HTTP only. ParseUUIDPipe rejects a non-UUID id as a 400
 * before the service touches the database. @Post defaults to 201.
 */
@Controller('public/bookings')
export class PublicPaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // No-auth write that triggers an external Provider call → the tighter
  // `sensitive` throttler (api-spec §8.3, ADR-0014), alongside the booking create.
  // A retry is cheap (it reuses the open session, no second Provider call), so a
  // real guest clicking "pay" a few times never trips it.
  @ThrottleSensitive()
  @Post(':id/pay')
  pay(@Param('id', ParseUUIDPipe) id: string): Promise<PaymentSessionResponse> {
    return this.payments.pay(id);
  }
}
