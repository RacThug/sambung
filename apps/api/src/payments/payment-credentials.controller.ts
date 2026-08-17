import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import {
  savePaymentCredentialRequestSchema,
  type PaymentCredentialStatusResponse,
  type SavePaymentCredentialRequest,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PaymentCredentialsService } from './payment-credentials.service';

/**
 * The Tenant's payment-gateway credentials (REQ-PA-04, ADR-0039) - addressed
 * under /settings because that is where the owner lives, owned by the payments
 * module because that is whose domain a gateway key is (the channels precedent:
 * route path and owning module need not match).
 *
 * Owner-only in BOTH directions (`@Roles` on read AND write - unlike
 * GET /settings): a credential is the shape of the Tenant's money, the
 * ADR-0032 verb line's clearest case. Staff get a 403 before any lookup.
 *
 * PUT, the codebase's first: a save is a WHOLESALE idempotent replace of one
 * addressable resource - PUT's exact contract - where PATCH would promise a
 * partial merge nothing here performs.
 */
@Controller('settings/payment-credentials')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentCredentialsController {
  constructor(private readonly credentials: PaymentCredentialsService) {}

  @Get()
  @Roles('owner')
  list(): Promise<PaymentCredentialStatusResponse[]> {
    return this.credentials.list();
  }

  @Put(':provider')
  @Roles('owner')
  save(
    @Param('provider') provider: string,
    @Body(new ZodValidationPipe(savePaymentCredentialRequestSchema))
    dto: SavePaymentCredentialRequest,
  ): Promise<PaymentCredentialStatusResponse> {
    return this.credentials.save(provider, dto);
  }
}
