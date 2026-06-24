import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../prisma/tenant-prisma.service';

// Dumb repository: Prisma queries only, via the tenant-scoped (RLS) client.
// Two layers guard isolation: the explicit tenant_id filter here (UX-correct
// 404s) AND the database RLS policy (defense-in-depth — even a forgotten filter
// returns nothing).
@Injectable()
export class PropertiesRepository {
  constructor(private readonly db: TenantPrismaService) {}

  findAllByTenant(tenantId: string) {
    return this.db.client.property.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findByIdForTenant(id: string, tenantId: string) {
    return this.db.client.property.findFirst({ where: { id, tenantId } });
  }
}
