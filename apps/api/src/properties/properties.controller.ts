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
  presignPhotoRequestSchema,
  updatePhotosRequestSchema,
  updatePropertyRequestSchema,
  type CreatePropertyRequest,
  type PresignPhotoRequest,
  type PresignPhotoResponse,
  type PropertyResponse,
  type UpdatePhotosRequest,
  type UpdatePropertyRequest,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RolesGuard } from '../common/roles.guard';
import { PropertiesService } from './properties.service';

/**
 * Tenant-scoped property CRUD (FR-PROP-1/3, api-spec §4.1-4.4). Guard seeds
 * the TenantContext; the service scopes every query by tenant_id.
 *
 * TWO axes of authorization meet on this controller, and they answer different
 * questions with different status codes (#57):
 *
 *   WHICH properties - RLS, invisibly. A staff member's session narrows every
 *   query to their assigned Properties (ADR-0032), so `list` returns fewer rows
 *   and `get` of an unassigned id finds none and 404s. No handler here filters
 *   anything; the database already did.
 *
 *   WHICH VERBS - `@Roles('owner')`, visibly, on four handlers. The line is
 *   whether the action changes the SHAPE of the tenant (which Properties exist)
 *   or merely OPERATES one: create, delete, archive and unarchive are the
 *   owner's; editing, photos, and everything under a Property are the staff's to
 *   do on what they are assigned.
 *
 * `create` is the clearest case, and it settles the others: a staff member who
 * created a Property would have no user_property row for it, so it would vanish
 * the instant it existed. A verb whose result is invisible to whoever used it is
 * not a permission worth granting.
 */
@Controller('properties')
@UseGuards(JwtAuthGuard, RolesGuard)
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
  @Roles('owner')
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
  @Roles('owner')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.properties.remove(id);
  }

  @Post(':id/photos/presign')
  presignPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(presignPhotoRequestSchema))
    dto: PresignPhotoRequest,
  ): Promise<PresignPhotoResponse> {
    return this.properties.presignPhoto(id, dto);
  }

  @Patch(':id/photos')
  updatePhotos(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePhotosRequestSchema))
    dto: UpdatePhotosRequest,
  ): Promise<PropertyResponse> {
    return this.properties.updatePhotos(id, dto);
  }

  // Archive / unarchive (api-spec §4.8, ADR-0005). Verb-subresources, not a PATCH
  // field: archive is a transition like POST /bookings/:id/cancel, and archivedAt
  // is in no request schema. 200 + the updated resource; idempotent.
  @Post(':id/archive')
  @Roles('owner')
  @HttpCode(200)
  archive(@Param('id', ParseUUIDPipe) id: string): Promise<PropertyResponse> {
    return this.properties.archive(id);
  }

  @Post(':id/unarchive')
  @Roles('owner')
  @HttpCode(200)
  unarchive(@Param('id', ParseUUIDPipe) id: string): Promise<PropertyResponse> {
    return this.properties.unarchive(id);
  }
}
