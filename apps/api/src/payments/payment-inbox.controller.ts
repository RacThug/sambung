import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  LapsedPayment,
  MarkPaymentHandledResponse,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { PaymentInboxService } from './payment-inbox.service';

/**
 * The owner's paid-but-lapsed payment inbox - `/payments` (#120, ADR-0022). The
 * late-settlement reconciliation surface: a guest paid after their hold lapsed or
 * was cancelled, so money is captured for a booking that no longer holds its dates.
 *
 * Authed and owner-only (unlike the rest of the payments module, which is the
 * public guest funnel + the no-principal webhook): the guard mints the
 * UserPrincipal and seeds the TenantContext, so both routes run on the owner RLS
 * connection and scope by `tenant_id`. HTTP only - the tenant scoping and the
 * ledger-preserving marker live in the service/repository below.
 */
@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentInboxController {
  constructor(private readonly service: PaymentInboxService) {}

  // The inbox list (AC a). A literal segment, so it never collides with a
  // `:id`-shaped route (there is no `GET /payments/:id`).
  @Get('lapsed')
  listLapsed(): Promise<LapsedPayment[]> {
    return this.service.listLapsed();
  }

  // Mark one handled (AC b) - a verb-subresource like /bookings/:id/cancel and
  // /properties/:id/archive. Idempotent: handling twice returns the same 200.
  // Unknown / cross-tenant / non-inbox id → 404.
  @Post(':id/handle')
  @HttpCode(200)
  handle(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarkPaymentHandledResponse> {
    return this.service.markHandled(id);
  }
}
