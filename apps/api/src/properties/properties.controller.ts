import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { PropertiesService } from './properties.service';

// Tenant-scoped, read-only for now (full CRUD is FR-PROP-1 / #9). Guard seeds
// the TenantContext; the service scopes every query by tenant_id.
@Controller('properties')
@UseGuards(JwtAuthGuard)
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Get()
  list() {
    return this.properties.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.properties.get(id);
  }
}
