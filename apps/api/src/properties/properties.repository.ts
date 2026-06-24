import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Dumb repository: Prisma queries only. EVERY query is scoped by tenant_id
// (invariant #2). The id+tenantId pair means another tenant's id finds nothing.
@Injectable()
export class PropertiesRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAllByTenant(tenantId: string) {
    return this.prisma.property.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findByIdForTenant(id: string, tenantId: string) {
    return this.prisma.property.findFirst({ where: { id, tenantId } });
  }
}
