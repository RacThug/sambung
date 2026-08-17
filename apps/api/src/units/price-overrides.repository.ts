import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { unitPriceOverride, type UnitPriceOverride } from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

// Dumb repository: Drizzle queries only, via the tenant-scoped (RLS) client.
// The tenant is ambient (#76) and every query still filters by tenant_id anyway
// (architecture §3.3) - two layers, each proven to hold without the other.
@Injectable()
export class PriceOverridesRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * A unit's overrides, sorted by start date. No tiebreaker needed, unlike the
   * units list: `price_override_no_overlap` makes two ranges on one unit
   * disjoint, so their from_dates are strictly distinct.
   */
  findByUnit(unitId: string): Promise<UnitPriceOverride[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select()
        .from(unitPriceOverride)
        .where(
          and(
            eq(unitPriceOverride.unitId, unitId),
            eq(unitPriceOverride.tenantId, tenantId),
          ),
        )
        .orderBy(asc(unitPriceOverride.fromDate)),
    );
  }

  /**
   * The app half of the two-layer overlap refusal (§5.3): the SAME
   * `daterange && daterange` the exclusion constraint evaluates, asked first for
   * the friendly 409. The constraint stays the authority - a race between this
   * check and the INSERT is its to arbitrate.
   */
  async overlapExists(
    unitId: string,
    from: string,
    to: string,
  ): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ id: unitPriceOverride.id })
        .from(unitPriceOverride)
        .where(
          and(
            eq(unitPriceOverride.unitId, unitId),
            eq(unitPriceOverride.tenantId, tenantId),
            sql`daterange(${unitPriceOverride.fromDate}, ${unitPriceOverride.toDate}, '[)') && daterange(${from}::date, ${to}::date, '[)')`,
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  async create(values: {
    unitId: string;
    fromDate: string;
    toDate: string;
    nightlyPriceIdr: bigint;
  }): Promise<UnitPriceOverride> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .insert(unitPriceOverride)
        .values({ ...values, tenantId })
        .returning(),
    );
    return rows[0];
  }

  /** True when a row was deleted; false when the id is unknown to this tenant. */
  async delete(id: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .delete(unitPriceOverride)
        .where(
          and(
            eq(unitPriceOverride.id, id),
            eq(unitPriceOverride.tenantId, tenantId),
          ),
        )
        .returning({ id: unitPriceOverride.id }),
    );
    return rows.length > 0;
  }
}
