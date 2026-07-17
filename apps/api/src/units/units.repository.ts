import { Injectable } from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import { booking, property, unit, type Unit } from '@sambung/db';
import { TenantContext } from '../common/tenant-context.service';
import { TenantDbService } from '../db/tenant-db.service';

// Dumb repository: Drizzle queries only, via the tenant-scoped (RLS) client.
//
// The tenant is ambient (TenantContext), never a parameter (#76), and every
// query still filters by tenant_id anyway (architecture §3.3). That WHERE is not
// redundancy with the ambient read - both come from one place, so they cannot
// disagree. It guards RLS not being in force at all: boot against DATABASE_URL
// instead of APP_DATABASE_URL and the owner role bypasses every policy, leaving
// this filter as the only thing standing. units.spec.ts proves each layer holds
// without the other.
//
// This reaches into the `property` table for the ownership check rather than
// calling PropertiesService. Repositories query tables, not modules - the same
// way properties.repository reaches into `unit` for pricedUnitCount - so units
// depends on properties for nothing and there is no cycle to engineer around.
@Injectable()
export class UnitsRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /** True when the property exists AND belongs to the caller's tenant. */
  async propertyExists(propertyId: string): Promise<boolean> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select({ id: property.id })
        .from(property)
        .where(
          and(eq(property.id, propertyId), eq(property.tenantId, tenantId)),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  findByProperty(propertyId: string): Promise<Unit[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select()
        .from(unit)
        .where(
          and(eq(unit.propertyId, propertyId), eq(unit.tenantId, tenantId)),
        )
        .orderBy(asc(unit.createdAt)),
    );
  }

  async findById(id: string): Promise<Unit | null> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select()
        .from(unit)
        .where(and(eq(unit.id, id), eq(unit.tenantId, tenantId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async create(
    values: Omit<typeof unit.$inferInsert, 'tenantId'>,
  ): Promise<Unit> {
    const tenantId = this.tenant.tenantId;
    const [row] = await this.db.run((tx) =>
      tx
        .insert(unit)
        .values({ ...values, tenantId })
        .returning(),
    );
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<typeof unit.$inferInsert, 'tenantId' | 'propertyId'>>,
  ): Promise<Unit | null> {
    const tenantId = this.tenant.tenantId;
    const [row] = await this.db.run((tx) =>
      tx
        .update(unit)
        .set(patch)
        .where(and(eq(unit.id, id), eq(unit.tenantId, tenantId)))
        .returning(),
    );
    return row ?? null;
  }

  /**
   * Lock a unit so a caller can decide whether to delete it. Returns false when
   * the id is unknown or belongs to another tenant.
   *
   * Call this FIRST in the unit of work: the lock is what makes the caller's
   * guard sound rather than best-effort. An INSERT referencing this row takes
   * FOR KEY SHARE on it, which conflicts with FOR UPDATE - so a booking racing
   * the delete waits, and if the delete wins it fails its FK instead of being
   * let through behind the count's back.
   *
   * Only meaningful inside a caller's `db.run`: a lock taken in its own
   * transaction is released the instant that transaction commits, so a
   * standalone call would return true having locked nothing. Asserted rather
   * than documented, because the failure is otherwise silent.
   */
  async lockForDelete(id: string): Promise<boolean> {
    this.db.assertInTransaction('UnitsRepository.lockForDelete');
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx) => {
      const found = await tx
        .select({ id: unit.id })
        .from(unit)
        .where(and(eq(unit.id, id), eq(unit.tenantId, tenantId)))
        .limit(1)
        .for('update');
      return found.length > 0;
    });
  }

  /**
   * Count every booking that has ever referenced this unit - any status, any
   * date (ADR-0002).
   *
   * Deliberately NOT "future occupying". That older rule protected the calendar
   * and not the ledger: past and cancelled bookings were invisible to it, so the
   * delete took them - and their payment rows - with it. The question here is
   * "did anything ever happen on this unit", not "will a guest show up".
   */
  async countBookings(unitId: string): Promise<number> {
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx) => {
      const [{ bookings }] = await tx
        .select({ bookings: count() })
        .from(booking)
        .where(and(eq(booking.unitId, unitId), eq(booking.tenantId, tenantId)));
      return bookings;
    });
  }

  async delete(id: string): Promise<void> {
    const tenantId = this.tenant.tenantId;
    await this.db.run((tx) =>
      tx.delete(unit).where(and(eq(unit.id, id), eq(unit.tenantId, tenantId))),
    );
  }
}
