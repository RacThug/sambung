import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  createUnitRequestSchema,
  updateUnitRequestSchema,
  type CreateUnitRequest,
  type UnitResponse,
  type UpdateUnitRequest,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { NoBody } from '../common/decorators/no-body.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { UnitsService } from './units.service';

/**
 * Units nested under their property (api-spec §4.6, #14/#15).
 *
 * Two controllers, one module, because the spec splits the routes: creating and
 * listing are questions about a property ("what's in it?", "add one to it"),
 * while updating and deleting address a unit directly by its own id.
 */
@Controller('properties/:propertyId/units')
@UseGuards(JwtAuthGuard)
export class PropertyUnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  list(
    @Param('propertyId', ParseUUIDPipe) propertyId: string,
  ): Promise<UnitResponse[]> {
    return this.units.listByProperty(propertyId);
  }

  @Post()
  create(
    @Param('propertyId', ParseUUIDPipe) propertyId: string,
    @Body(new ZodValidationPipe(createUnitRequestSchema))
    dto: CreateUnitRequest,
  ): Promise<UnitResponse> {
    return this.units.create(propertyId, dto);
  }
}

/** Units addressed directly (api-spec §4.6, #16). */
@Controller('units')
@UseGuards(JwtAuthGuard)
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  // Flat tenant-wide list (api-spec §5.5-adjacent, #49). The unified calendar
  // composes its Unit rows from this + GET /properties + GET /bookings (ADR-0010).
  @Get()
  list(): Promise<UnitResponse[]> {
    return this.units.listAll();
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateUnitRequestSchema))
    dto: UpdateUnitRequest,
  ): Promise<UnitResponse> {
    return this.units.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @NoBody()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.units.remove(id);
  }

  // Archive / unarchive (api-spec §4.8, ADR-0005). Verb-subresources, not a PATCH
  // field: archive is a transition, and archivedAt is in no request schema. 200 +
  // the updated resource; idempotent.
  @Post(':id/archive')
  @HttpCode(200)
  @NoBody()
  archive(@Param('id', ParseUUIDPipe) id: string): Promise<UnitResponse> {
    return this.units.archive(id);
  }

  @Post(':id/unarchive')
  @HttpCode(200)
  @NoBody()
  unarchive(@Param('id', ParseUUIDPipe) id: string): Promise<UnitResponse> {
    return this.units.unarchive(id);
  }
}
