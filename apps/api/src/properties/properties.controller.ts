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
  createPropertyRequestSchema,
  updatePropertyRequestSchema,
  type CreatePropertyRequest,
  type PropertyResponse,
  type UpdatePropertyRequest,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PropertiesService } from './properties.service';

// Tenant-scoped property CRUD (FR-PROP-1/3, api-spec §4.1-4.4). Guard seeds
// the TenantContext; the service scopes every query by tenant_id.
@Controller('properties')
@UseGuards(JwtAuthGuard)
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Get()
  list(): Promise<PropertyResponse[]> {
    return this.properties.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<PropertyResponse> {
    return this.properties.get(id);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createPropertyRequestSchema))
    dto: CreatePropertyRequest,
  ): Promise<PropertyResponse> {
    return this.properties.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePropertyRequestSchema))
    dto: UpdatePropertyRequest,
  ): Promise<PropertyResponse> {
    return this.properties.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.properties.remove(id);
  }
}
