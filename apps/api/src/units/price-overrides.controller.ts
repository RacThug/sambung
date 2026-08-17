import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  createPriceOverrideRequestSchema,
  type CreatePriceOverrideRequest,
  type PriceOverrideResponse,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { NoBody } from '../common/decorators/no-body.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PriceOverridesService } from './price-overrides.service';

/**
 * Price overrides nested under their unit (PRD-product P0-2) - the channels
 * grain: list and create are questions about a unit, delete addresses an
 * override by its own id. No @Roles guard: Staff pricing an assigned unit is
 * operating it (EARS ISO-05), and RLS answers who sees which unit.
 */
@Controller('units/:unitId/price-overrides')
@UseGuards(JwtAuthGuard)
export class UnitPriceOverridesController {
  constructor(private readonly overrides: PriceOverridesService) {}

  @Get()
  list(
    @Param('unitId', ParseUUIDPipe) unitId: string,
  ): Promise<PriceOverrideResponse[]> {
    return this.overrides.list(unitId);
  }

  @Post()
  create(
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body(new ZodValidationPipe(createPriceOverrideRequestSchema))
    dto: CreatePriceOverrideRequest,
  ): Promise<PriceOverrideResponse> {
    return this.overrides.create(unitId, dto);
  }
}

/** Overrides addressed directly, like DELETE /channels/:id. */
@Controller('price-overrides')
@UseGuards(JwtAuthGuard)
export class PriceOverridesController {
  constructor(private readonly overrides: PriceOverridesService) {}

  @Delete(':id')
  @HttpCode(204)
  @NoBody()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.overrides.remove(id);
  }
}
