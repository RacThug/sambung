import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isPublishable,
  isVerified,
  type CreatePropertyRequest,
  type PropertyResponse,
  type UpdatePropertyRequest,
} from '@sambung/shared';
import { TenantContext } from '../common/tenant-context.service';
import {
  PropertiesRepository,
  type PropertyRow,
} from './properties.repository';

@Injectable()
export class PropertiesService {
  constructor(
    private readonly repo: PropertiesRepository,
    private readonly tenant: TenantContext,
  ) {}

  async list(): Promise<PropertyResponse[]> {
    const rows = await this.repo.findAllByTenant(this.tenant.tenantId);
    return rows.map((row) => this.toResponse(row));
  }

  async get(id: string): Promise<PropertyResponse> {
    const row = await this.repo.findByIdForTenant(id, this.tenant.tenantId);
    // 404 (not 403) for another tenant's id — don't reveal that it exists.
    if (!row) {
      throw new NotFoundException('Property not found');
    }
    return this.toResponse(row);
  }

  async create(dto: CreatePropertyRequest): Promise<PropertyResponse> {
    const row = await this.repo.create({
      ...dto,
      tenantId: this.tenant.tenantId,
    });
    return this.toResponse(row);
  }

  async update(
    id: string,
    dto: UpdatePropertyRequest,
  ): Promise<PropertyResponse> {
    // PATCH semantics: absent = leave alone. Strip undefined so an omitted
    // field can never overwrite a column, and short-circuit an empty patch
    // (Drizzle rejects an empty SET; the 404 behavior must hold regardless).
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(patch).length === 0) {
      return this.get(id);
    }
    const row = await this.repo.update(id, this.tenant.tenantId, patch);
    if (!row) {
      throw new NotFoundException('Property not found');
    }
    return this.toResponse(row);
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.deleteWithGuard(id, this.tenant.tenantId);
    if (!result.found) {
      throw new NotFoundException('Property not found');
    }
    if (!result.deleted) {
      const n = result.futureBookings;
      // Deleting live inventory must be an explicit two-step (api-spec §4.4):
      // the count tells the owner exactly what to cancel first.
      throw new ConflictException(
        `Cannot delete: ${n} future booking${n === 1 ? '' : 's'} - cancel them first`,
      );
    }
  }

  private toResponse(row: PropertyRow): PropertyResponse {
    const { pricedUnitCount, createdAt, ...columns } = row;
    return {
      ...columns,
      verified: isVerified(row.licenseNo),
      // TODO(#39): photoCount is 0 until photo storage lands - no property is
      // publishable before it can show a photo, which is exactly the rule.
      publishable: isPublishable({ photoCount: 0, pricedUnitCount }),
      createdAt: createdAt.toISOString(),
    };
  }
}
