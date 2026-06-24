import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContext } from '../common/tenant-context.service';
import { PropertiesRepository } from './properties.repository';

@Injectable()
export class PropertiesService {
  constructor(
    private readonly repo: PropertiesRepository,
    private readonly tenant: TenantContext,
  ) {}

  list() {
    return this.repo.findAllByTenant(this.tenant.tenantId);
  }

  async get(id: string) {
    const property = await this.repo.findByIdForTenant(
      id,
      this.tenant.tenantId,
    );
    // 404 (not 403) for another tenant's id — don't reveal that it exists.
    if (!property) {
      throw new NotFoundException('Property not found');
    }
    return property;
  }
}
