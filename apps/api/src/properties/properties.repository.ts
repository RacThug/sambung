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

export type DeleteWithGuardResult =
  | { found: false }
  | { found: true; deleted: false; futureBookings: number }
  | { found: true; deleted: true };

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
   * Atomic guarded delete (api-spec §4.4): count future occupying bookings and
   * delete only when there are none, in one transaction. "Occupying" = status
   * pending_payment|confirmed; "future" = check_out > today (half-open stays:
   * an in-house guest still counts, today's checkout doesn't).
   *
   * The FOR UPDATE locks make the guard sound, not best-effort: an INSERT
   * referencing a locked row takes FOR KEY SHARE on it, which conflicts with
   * FOR UPDATE. Locking the property row blocks new units appearing under it
   * mid-delete; locking its unit rows blocks new bookings on them. A booking
   * insert racing this delete therefore waits, and if the delete wins it fails
   * its FK instead of being silently cascaded away.
   */
  deleteWithGuard(
    id: string,
    tenantId: string,
  ): Promise<DeleteWithGuardResult> {
    return this.db.run(async (tx): Promise<DeleteWithGuardResult> => {
      const found = await tx
        .select({ id: property.id })
        .from(property)
        .where(and(eq(property.id, id), eq(property.tenantId, tenantId)))
        .limit(1)
        .for('update');
      if (!found.length) return { found: false };

      await tx
        .select({ id: unit.id })
        .from(unit)
        .where(eq(unit.propertyId, id))
        .for('update');

      const [{ futureBookings }] = await tx
        .select({ futureBookings: count() })
        .from(booking)
        .innerJoin(unit, eq(booking.unitId, unit.id))
        .where(
          and(
            eq(unit.propertyId, id),
            inArray(booking.status, ['pending_payment', 'confirmed']),
            gt(booking.checkOut, sql`current_date`),
          ),
        );
      if (futureBookings > 0) {
        return { found: true, deleted: false, futureBookings };
      }

      await tx.delete(property).where(eq(property.id, id));
      return { found: true, deleted: true };
    });
  }
}
