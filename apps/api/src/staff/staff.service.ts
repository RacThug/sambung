import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { StaffMemberDto, UpdateStaffRequest } from '@sambung/shared';
import { TenantContext } from '../common/tenant-context.service';
import { StaffRepository } from './staff.repository';

/**
 * The Team roster: who the staff are and what each of them can see (#57).
 *
 * Owner-only throughout (`@Roles('owner')` on the controller). The 403 is the
 * guard's; every refusal here is a 404, because past the role check the only
 * remaining question is whether a staff member by that id exists in this tenant -
 * and a cross-tenant id must be indistinguishable from a nonexistent one
 * (api-spec §1).
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly repo: StaffRepository,
    private readonly tenant: TenantContext,
  ) {}

  async list(): Promise<StaffMemberDto[]> {
    const rows = await this.repo.listStaff();
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
      properties: row.properties,
    }));
  }

  /**
   * Replace one staff member's Assignments.
   *
   * Existence is checked BEFORE the properties are, so a request naming an
   * unknown user and an unknown property 404s on the user - the resource in the
   * path - rather than leaking that the user is the part that was fine.
   */
  async updateAssignments(
    userId: string,
    dto: UpdateStaffRequest,
  ): Promise<StaffMemberDto> {
    if (!(await this.repo.staffExists(userId))) {
      throw new NotFoundException('Staff member not found');
    }
    const propertyIds = [...new Set(dto.propertyIds)];
    const visible = await this.repo.countVisibleProperties(propertyIds);
    if (visible !== propertyIds.length) {
      throw new NotFoundException('Property not found');
    }
    await this.repo.replaceAssignments(userId, propertyIds);
    const updated = (await this.list()).find((s) => s.id === userId);
    /* istanbul ignore next - existence was just established. */
    if (!updated) throw new NotFoundException('Staff member not found');
    return updated;
  }

  /**
   * Remove a staff account.
   *
   * The self-check is not paranoia about owners deleting themselves - the
   * repository's `role = 'staff'` predicate already makes that a 404. It is here
   * for the day this endpoint is widened, so "you cannot delete yourself" is a
   * stated rule with a test rather than an accident of another rule.
   */
  async remove(userId: string): Promise<void> {
    const principal = this.tenant.principal;
    if (principal?.kind === 'user' && principal.userId === userId) {
      throw new ForbiddenException('You cannot remove your own account');
    }
    if (!(await this.repo.removeStaff(userId))) {
      throw new NotFoundException('Staff member not found');
    }
  }
}
