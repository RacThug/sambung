import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  gt,
  inArray,
  sql,
} from 'drizzle-orm';
import { booking, property, unit, type Property } from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

export type PropertyRow = Property & { pricedUnitCount: number };

// Units under this property with a real price (> 0 - a zero-rupiah unit is a
// placeholder, not a sellable listing). One of the two inputs to `publishable`;
// the photo count joins it with #39. Computed via LEFT JOIN + conditional
// count rather than a correlated subquery: in a single-table select Drizzle
// strips table qualifiers from columns inside sql`` field fragments, which
// silently re-scopes the correlation to the inner table. A join keeps every
// column qualified.
const pricedUnitCount = count(
  sql`case when ${unit.basePriceIdr} > 0 then 1 end`,
);

const propertyColumns = getTableColumns(property);

// Dumb repository: Drizzle queries only, via the tenant-scoped (RLS) client.
//
// The tenant is ambient (TenantContext), never a parameter. It used to be both:
// callers passed tenantId AND TenantDbService read the same id from context, so
// it travelled two paths into one transaction with nothing checking they agreed.
//
// Every query still filters by tenant_id (architecture §3.3 point 3). That is
// NOT redundancy with the ambient read - both now come from the same place, so
// they cannot disagree. What the filter guards is RLS not being in force at
// all: boot against DATABASE_URL instead of APP_DATABASE_URL and the owner role
// bypasses every policy, leaving this WHERE as the only thing standing. That is
// one env var, and properties.spec.ts proves each layer holds without the other.
@Injectable()
export class PropertiesRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  findAll(): Promise<PropertyRow[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select({ ...propertyColumns, pricedUnitCount })
        .from(property)
        .leftJoin(
          unit,
          and(eq(unit.propertyId, property.id), eq(unit.tenantId, tenantId)),
        )
        .where(eq(property.tenantId, tenantId))
        // Grouping by the PK lets Postgres accept the ungrouped property
        // columns (functional dependency).
        .groupBy(property.id)
        .orderBy(asc(property.createdAt)),
    );
  }

  async findById(id: string): Promise<PropertyRow | null> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ ...propertyColumns, pricedUnitCount })
        .from(property)
        .leftJoin(
          unit,
          and(eq(unit.propertyId, property.id), eq(unit.tenantId, tenantId)),
        )
        .where(and(eq(property.id, id), eq(property.tenantId, tenantId)))
        .groupBy(property.id)
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async create(
    values: Omit<typeof property.$inferInsert, 'tenantId'>,
  ): Promise<PropertyRow> {
    const tenantId = this.tenant.tenantId;
    const [row] = await this.db.run((tx) =>
      tx
        .insert(property)
        .values({ ...values, tenantId })
        .returning(),
    );
    // A brand-new property has no units yet - no second query needed.
    return { ...row, pricedUnitCount: 0 };
  }

  async update(
    id: string,
    patch: Partial<Omit<typeof property.$inferInsert, 'tenantId'>>,
  ): Promise<PropertyRow | null> {
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx) => {
      const [row] = await tx
        .update(property)
        .set(patch)
        .where(and(eq(property.id, id), eq(property.tenantId, tenantId)))
        .returning();
      if (!row) return null;
      const [counts] = await tx
        .select({ pricedUnitCount: count() })
        .from(unit)
        .where(
          and(
            eq(unit.propertyId, id),
            eq(unit.tenantId, tenantId),
            sql`${unit.basePriceIdr} > 0`,
          ),
        );
      return { ...row, pricedUnitCount: counts.pricedUnitCount };
    });
  }

  /**
   * Lock a property and everything that could add bookings under it, so a
   * caller can decide whether to delete it. Returns false when the id is
   * unknown or belongs to another tenant.
   *
   * Call this FIRST in the unit of work: the locks are what make the caller's
   * guard sound rather than best-effort. An INSERT referencing a locked row
   * takes FOR KEY SHARE on it, which conflicts with FOR UPDATE. Locking the
   * property row blocks new units appearing under it mid-delete; locking its
   * unit rows blocks new bookings on them. A booking insert racing the delete
   * therefore waits, and if the delete wins it fails its FK instead of being
   * silently cascaded away.
   *
   * Both locks are taken here, in this order, because their order is a
   * persistence detail - callers should not be able to get it wrong.
   *
   * Only meaningful inside a caller's `db.run`: a lock taken in its own
   * transaction is released the moment that transaction commits, so a
   * standalone call would return true having locked nothing. Asserted rather
   * than documented, because the failure is otherwise silent.
   */
  async lockForDelete(id: string): Promise<boolean> {
    this.db.assertInTransaction('PropertiesRepository.lockForDelete');
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx) => {
      const found = await tx
        .select({ id: property.id })
        .from(property)
        .where(and(eq(property.id, id), eq(property.tenantId, tenantId)))
        .limit(1)
        .for('update');
      if (!found.length) return false;

      await tx
        .select({ id: unit.id })
        .from(unit)
        .where(and(eq(unit.propertyId, id), eq(unit.tenantId, tenantId)))
        .for('update');
      return true;
    });
  }

  /**
   * Count bookings under this property that still occupy dates in the future.
   * "Occupying" = status pending_payment|confirmed (the same set as the
   * booking_no_overlap constraint's WHERE); "future" = check_out > today,
   * evaluated as current_date in the database so the day boundary is the
   * server's, not the caller's. Half-open stays: an in-house guest still
   * counts, today's checkout doesn't.
   */
  async countFutureOccupying(propertyId: string): Promise<number> {
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx) => {
      const [{ futureBookings }] = await tx
        .select({ futureBookings: count() })
        .from(booking)
        .innerJoin(unit, eq(booking.unitId, unit.id))
        .where(
          and(
            eq(unit.propertyId, propertyId),
            eq(booking.tenantId, tenantId),
            inArray(booking.status, ['pending_payment', 'confirmed']),
            gt(booking.checkOut, sql`current_date`),
          ),
        );
      return futureBookings;
    });
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.tenant.tenantId;
    await this.db.run((tx) =>
      tx
        .delete(property)
        .where(and(eq(property.id, id), eq(property.tenantId, tenantId))),
    );
  }
}
