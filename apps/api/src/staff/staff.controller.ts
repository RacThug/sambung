import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  updateStaffRequestSchema,
  type ListStaffResponse,
  type StaffMemberDto,
  type UpdateStaffRequest,
} from '@sambung/shared';
import { JwtAuthGuard } from '../auth/auth.guard';
import { NoBody } from '../common/decorators/no-body.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RolesGuard } from '../common/roles.guard';
import { StaffService } from './staff.service';

/**
 * The Team roster (#57, api-spec §3.6).
 *
 * `@Roles('owner')` on the CLASS: every route here is about who may see what,
 * which is the owner's decision by definition - there is no read half a staff
 * member needs. That is the opposite call from `/settings`, where the read is
 * open because the property workbench needs the gallery cap.
 *
 * A staff member calling any of these gets 403, not 404. Nothing is being
 * hidden: they know their own tenant has a team, they are on it. "You lack the
 * role" is the honest, actionable answer, and the existence-hiding convention
 * exists for CROSS-TENANT reads, which this is not (api-spec §1).
 */
@Controller('staff')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  async list(): Promise<ListStaffResponse> {
    return { staff: await this.staff.list() };
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateStaffRequestSchema))
    dto: UpdateStaffRequest,
  ): Promise<StaffMemberDto> {
    return this.staff.updateAssignments(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @NoBody()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.staff.remove(id);
  }
}
