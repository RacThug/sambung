import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  updateTenantSettingsRequestSchema,
  type TenantSettingsResponse,
  type UpdateTenantSettingsRequest,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SettingsService } from './settings.service';

/**
 * Tenant settings (api-spec §4.9, #67). Singular resource - the tenant is
 * implicit in every authenticated request, exactly as it is for /properties.
 *
 * Guard order matters: JwtAuthGuard mints the principal, RolesGuard reads it.
 * RolesGuard is a no-op on the handler without `@Roles`, so the READ stays open
 * to staff - the property workbench needs the cap to render.
 */
@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(): Promise<TenantSettingsResponse> {
    return this.settings.get();
  }

  @Patch()
  @Roles('owner')
  update(
    @Body(new ZodValidationPipe(updateTenantSettingsRequestSchema))
    dto: UpdateTenantSettingsRequest,
  ): Promise<TenantSettingsResponse> {
    return this.settings.update(dto);
  }
}
