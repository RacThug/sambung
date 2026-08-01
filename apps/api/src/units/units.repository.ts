import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, getTableColumns, sql } from 'drizzle-orm';
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
/**
 * A Unit row plus its EFFECTIVE retirement state - the Unit's own `archived_at` OR
 * its Property's (ADR-0005).
 *
 * The derivation used to be the client's: `GET /units` and `GET /properties` each
 * carried their own `archivedAt` and the composing view OR-ed them. That was
 * api-spec §4.6's documented design, and the page-spec migration measured what it
 * cost - the same two-nullable-timestamps rule written out in three feature files,
 * driving six separate UI decisions, with nothing checking the copies agreed.
 *
 * So the server answers it once. The Unit's own `archivedAt` stays on the wire
 * beside it: they are different questions, and the archive/unarchive verb acts on
 * the Unit's own flag while the UI reads the effective one.
 */
export type UnitRow = Unit & { archived: boolean };

@Injectable()
export class UnitsRepository {
  constructor(
    private readonly db: TenantDbService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * Every Unit column plus the derived `archived`, joined to the parent Property.
   *
   * An INNER join, not a LEFT one: `unit_property_tenant_fk` makes a Unit without a
   * Property unrepresentable (#40), so a left join would only be inventing a NULL
   * branch that the schema forbids - and it would silently return `archived: false`
   * for a row that cannot exist rather than failing loudly if one ever did.
   */
  private unitColumns() {
    return {
      ...getTableColumns(unit),
      archived: sql<boolean>`(${unit.archivedAt} is not null or ${property.archivedAt} is not null)`,
    };
  }

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

  findByProperty(propertyId: string): Promise<UnitRow[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select(this.unitColumns())
        .from(unit)
        .innerJoin(property, eq(property.id, unit.propertyId))
        .where(
          and(eq(unit.propertyId, propertyId), eq(unit.tenantId, tenantId)),
        )
        // id is a tiebreaker, not decoration: created_at defaults to now(),
        // which is the TRANSACTION timestamp, so every unit inserted in one
        // transaction ties - the seed does exactly that. Postgres is then free
        // to return tied rows in heap order, and an UPDATE rewrites the row to
        // a new position, so editing a unit made the list visibly reorder.
        .orderBy(asc(unit.createdAt), asc(unit.id)),
    );
  }

  /**
   * Every Unit in the caller's tenant, ordered stably. The flat list the unified
   * calendar composes its rows from (ADR-0010), and that #50's manual-block dialog
   * and #51's filters reuse. Each row carries the derived `archived` - see UnitRow.
   */
  findAll(): Promise<UnitRow[]> {
    const tenantId = this.tenant.tenantId;
    return this.db.run((tx) =>
      tx
        .select(this.unitColumns())
        .from(unit)
        .innerJoin(property, eq(property.id, unit.propertyId))
        .where(eq(unit.tenantId, tenantId))
        .orderBy(asc(unit.createdAt), asc(unit.id)),
    );
  }

  async findById(id: string): Promise<UnitRow | null> {
    const tenantId = this.tenant.tenantId;
    const rows = await this.db.run((tx) =>
      tx
        .select(this.unitColumns())
        .from(unit)
        .innerJoin(property, eq(property.id, unit.propertyId))
        .where(and(eq(unit.id, id), eq(unit.tenantId, tenantId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Write, then re-read through the joined select, in ONE transaction.
   *
   * `.returning()` cannot answer `archived`: it hands back the row that was
   * written, and the effective flag also depends on the parent Property. Composing
   * the two inside a single `db.run` is what keeps the answer atomic - a second,
   * standalone read could observe a Property archived in between and describe a
   * Unit that never existed in that state.
   */
  private async writeThenRead(
    id: string,
    write: (
      tx: Parameters<Parameters<TenantDbService['run']>[0]>[0],
    ) => Promise<unknown>,
  ): Promise<UnitRow | null> {
    return this.db.run(async (tx) => {
      await write(tx);
      const rows = await tx
        .select(this.unitColumns())
        .from(unit)
        .innerJoin(property, eq(property.id, unit.propertyId))
        .where(and(eq(unit.id, id), eq(unit.tenantId, this.tenant.tenantId)))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  async create(
    values: Omit<typeof unit.$inferInsert, 'tenantId'>,
  ): Promise<UnitRow> {
    const tenantId = this.tenant.tenantId;
    return this.db.run(async (tx) => {
      const [created] = await tx
        .insert(unit)
        .values({ ...values, tenantId })
        .returning({ id: unit.id });
      const rows = await tx
        .select(this.unitColumns())
        .from(unit)
        .innerJoin(property, eq(property.id, unit.propertyId))
        .where(and(eq(unit.id, created.id), eq(unit.tenantId, tenantId)))
        .limit(1);
      return rows[0];
    });
  }

  async update(
    id: string,
    patch: Partial<Omit<typeof unit.$inferInsert, 'tenantId' | 'propertyId'>>,
  ): Promise<UnitRow | null> {
    const tenantId = this.tenant.tenantId;
    // The UPDATE's own row count is what decides 404 vs found - re-reading alone
    // would report "found" for a row the WHERE never matched.
    let updated = 0;
    const row = await this.writeThenRead(id, async (tx) => {
      const rows = await tx
        .update(unit)
        .set(patch)
        .where(and(eq(unit.id, id), eq(unit.tenantId, tenantId)))
        .returning({ id: unit.id });
      updated = rows.length;
    });
    return updated > 0 ? row : null;
  }

  /**
   * Set (or clear) this unit's retirement flag (ADR-0005, #84). Returns the
   * updated Unit, or null when the id is unknown or belongs to another tenant.
   *
   * Idempotent: archiving keeps the ORIGINAL archived_at (`coalesce`), so
   * re-archiving is a no-op that doesn't reset the "retired on" date; unarchiving
   * clears it. No FOR UPDATE lock - a single-row flag write has no cascade-away
   * race, and an in-flight booking is honoured, not raced (ADR-0005).
   */
  async setArchived(id: string, archived: boolean): Promise<UnitRow | null> {
    const tenantId = this.tenant.tenantId;
    let updated = 0;
    const row = await this.writeThenRead(id, async (tx) => {
      const rows = await tx
        .update(unit)
        .set({
          archivedAt: archived
            ? sql`coalesce(${unit.archivedAt}, now())`
            : null,
        })
        .where(and(eq(unit.id, id), eq(unit.tenantId, tenantId)))
        .returning({ id: unit.id });
      updated = rows.length;
    });
    return updated > 0 ? row : null;
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
