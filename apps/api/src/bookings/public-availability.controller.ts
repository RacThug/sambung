import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  availabilityQuerySchema,
  type AvailabilityQuery,
  type AvailabilityResponse,
} from '@sambung/shared';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AvailabilityService } from './availability.service';

/**
 * The availability quote (api-spec §5.1, page-spec §3.1) - the second
 * unauthenticated route in the API, and the read half of boss fight #2.
 *
 * No JwtAuthGuard: a Visitor has no token. The tenant scope comes from the unit
 * id (PublicScope.enterFromUnitId, ADR-0003/0008), entered by the SERVICE - so
 * this controller stays HTTP only. ParseUUIDPipe rejects a malformed unit id as a
 * 400 before any lookup; ZodValidationPipe rejects a bad window (from >= to,
 * >366 nights, a non-calendar date) as a 400 naming the field.
 */
@Controller('public/units')
export class PublicAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get(':id/availability')
  getAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema))
    query: AvailabilityQuery,
  ): Promise<AvailabilityResponse> {
    return this.availability.getPublicQuote(id, query);
  }
}
