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
// Two layers guard isolation: the explicit tenant_id filter here (UX-correct
// 404s) AND the database RLS policy (defense-in-depth — even a forgotten filter
// returns nothing).
@Injectable()
export class PropertiesRepository {
  constructor(private readonly db: TenantDbService) {}

  findAllByTenant(tenantId: string): Promise<PropertyRow[]> {
    return this.db.run((tx) =>
      tx
        .select({ ...propertyColumns, pricedUnitCount })
        .from(property)
        .leftJoin(unit, eq(unit.propertyId, property.id))
        .where(eq(property.tenantId, tenantId))
        // Grouping by the PK lets Postgres accept the ungrouped property
        // columns (functional dependency).
        .groupBy(property.id)
        .orderBy(asc(property.createdAt)),
    );
  }

  async findByIdForTenant(
    id: string,
    tenantId: string,
  ): Promise<PropertyRow | null> {
    const rows = await this.db.run((tx) =>
      tx
        .select({ ...propertyColumns, pricedUnitCount })
        .from(property)
        .leftJoin(unit, eq(unit.propertyId, property.id))
        .where(and(eq(property.id, id), eq(property.tenantId, tenantId)))
        .groupBy(property.id)
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async create(
    values: typeof property.$inferInsert & { tenantId: string },
  ): Promise<PropertyRow> {
    const [row] = await this.db.run((tx) =>
      tx.insert(property).values(values).returning(),
    );
    // A brand-new property has no units yet - no second query needed.
    return { ...row, pricedUnitCount: 0 };
  }

  async update(
    id: string,
    tenantId: string,
    patch: Partial<typeof property.$inferInsert>,
  ): Promise<PropertyRow | null> {
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
        .where(and(eq(unit.propertyId, id), sql`${unit.basePriceIdr} > 0`));
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
   */
  async lockForDelete(id: string, tenantId: string): Promise<boolean> {
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
        .where(eq(unit.propertyId, id))
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
    return this.db.run(async (tx) => {
      const [{ futureBookings }] = await tx
        .select({ futureBookings: count() })
        .from(booking)
        .innerJoin(unit, eq(booking.unitId, unit.id))
        .where(
          and(
            eq(unit.propertyId, propertyId),
            inArray(booking.status, ['pending_payment', 'confirmed']),
            gt(booking.checkOut, sql`current_date`),
          ),
        );
      return futureBookings;
    });
  }

  async delete(id: string, tenantId: string): Promise<void> {
    await this.db.run((tx) =>
      tx
        .delete(property)
        .where(and(eq(property.id, id), eq(property.tenantId, tenantId))),
    );
  }
}
