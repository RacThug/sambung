import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { tenant } from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

/**
 * Tenant settings, dumb repository (#67, ADR-0030). Drizzle only, via the
 * tenant-scoped (RLS) client.
 *
 * Every statement also carries `where tenant.id = <this tenant>` beside RLS -
 * the second layer architecture §3.3 asks for, and the one that still holds if
 * the API ever boots on `DATABASE_URL` (owner role, no policies). Here it reads
 * as belt-and-braces because the row IS the tenant, which is exactly why it must
 * be written down: an UPDATE with no WHERE would rewrite every tenant's cap.
 */
@Injectable()
export class SettingsRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * This tenant's gallery cap. Returns undefined only if the row is invisible -
   * an authenticated principal whose tenant was deleted mid-session - which the
   * service turns into a 404 rather than papering over with the default.
   */
  async getGalleryCap(): Promise<number | undefined> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ galleryCap: tenant.galleryCap })
        .from(tenant)
        .where(eq(tenant.id, tenantId))
        .limit(1),
    );
    return rows[0]?.galleryCap;
  }

  /**
   * Set the cap. The `tenant_gallery_cap_range` CHECK backstops the zod bound;
   * a value outside 1-100 therefore cannot be stored even if the schema were
   * bypassed - it raises, and the constraint interceptor turns an unmapped
   * violation into a loud 500 (ADR-0012), which is the right answer for a check
   * the boundary should already have made.
   */
  async setGalleryCap(galleryCap: number): Promise<number | undefined> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .update(tenant)
        .set({ galleryCap })
        .where(eq(tenant.id, tenantId))
        .returning({ galleryCap: tenant.galleryCap }),
    );
    return rows[0]?.galleryCap;
  }
}
