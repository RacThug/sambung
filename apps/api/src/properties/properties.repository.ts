import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { property } from '@sambung/db';
import { TenantDbService } from '../db/tenant-db.service';

// Dumb repository: Drizzle queries only, via the tenant-scoped (RLS) client.
// Two layers guard isolation: the explicit tenant_id filter here (UX-correct
// 404s) AND the database RLS policy (defense-in-depth — even a forgotten filter
// returns nothing).
@Injectable()
export class PropertiesRepository {
  constructor(private readonly db: TenantDbService) {}

  findAllByTenant(tenantId: string) {
    return this.db.run((tx) =>
      tx
        .select()
        .from(property)
        .where(eq(property.tenantId, tenantId))
        .orderBy(asc(property.createdAt)),
    );
  }

  async findByIdForTenant(id: string, tenantId: string) {
    const rows = await this.db.run((tx) =>
      tx
        .select()
        .from(property)
        .where(and(eq(property.id, id), eq(property.tenantId, tenantId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }
}
