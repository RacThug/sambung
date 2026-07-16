-- Tenant consistency: make the denormalized tenant_id self-enforcing
-- (db-design §4.5, issue #40).
--
-- unit, booking, and channel_connection each carry a denormalized tenant_id so
-- RLS policies and tenant-scoped queries hit one indexed column. Until now,
-- keeping that column consistent with the parent chain was an app-code
-- obligation; the failure mode is a row that RLS shows to the WRONG tenant.
-- These composite FKs move the obligation into the schema: a child whose
-- tenant_id disagrees with its parent is a constraint violation (23503).
--
-- Notes:
--   * Additive only. The Prisma-managed single-column FKs stay; Prisma cannot
--     model a second, composite FK over an existing relation, so (like the
--     no_overlap exclusion constraint) these live in hand-written SQL and
--     cause no drift.
--   * FK checks run with table-owner rights and bypass RLS, so the non-owner
--     app role (sambung_app) can still insert rows normally.
--   * The FK targets need real unique indexes: (id, tenant_id) is logically
--     implied by the PK on id, but Postgres requires the index to exist.
--   * ON DELETE CASCADE matches the existing single-column FKs, so delete
--     behavior is unchanged.

-- FK target for the unit -> property linkage
ALTER TABLE "property"
  ADD CONSTRAINT "property_id_tenant_uniq" UNIQUE ("id", "tenant_id");

-- unit.tenant_id must equal its property's tenant_id
ALTER TABLE "unit"
  ADD CONSTRAINT "unit_property_tenant_fk"
  FOREIGN KEY ("property_id", "tenant_id")
  REFERENCES "property" ("id", "tenant_id") ON DELETE CASCADE;

-- FK target for the booking / channel_connection -> unit linkage
ALTER TABLE "unit"
  ADD CONSTRAINT "unit_id_tenant_uniq" UNIQUE ("id", "tenant_id");

-- booking.tenant_id must equal its unit's tenant_id
ALTER TABLE "booking"
  ADD CONSTRAINT "booking_unit_tenant_fk"
  FOREIGN KEY ("unit_id", "tenant_id")
  REFERENCES "unit" ("id", "tenant_id") ON DELETE CASCADE;

-- channel_connection.tenant_id must equal its unit's tenant_id
ALTER TABLE "channel_connection"
  ADD CONSTRAINT "channel_connection_unit_tenant_fk"
  FOREIGN KEY ("unit_id", "tenant_id")
  REFERENCES "unit" ("id", "tenant_id") ON DELETE CASCADE;
