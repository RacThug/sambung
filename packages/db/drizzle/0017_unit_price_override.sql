-- ▼▼▼ Date-based pricing (PRD-product P0-2, page-spec app-properties-propertyId §8) ▼▼▼
-- A dated price layered over unit.base_price_idr: a night in [from_date, to_date)
-- costs nightly_price_idr, every other night the base. Only quote() reads it, so
-- the public availability read, the guest booking write and the owner walk-in all
-- reprice together by construction. CONFIG, not ledger (ADR-0002 does not apply):
-- a booking snapshots total_price_idr at creation, so cascading an override away
-- can never rewrite what was sold.
CREATE TABLE "unit_price_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"nightly_price_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_override_range_nonempty" CHECK ("unit_price_override"."to_date" > "unit_price_override"."from_date"),
	CONSTRAINT "price_override_nightly_range" CHECK ("unit_price_override"."nightly_price_idr" between 1 and 1000000000)
);
--> statement-breakpoint
ALTER TABLE "unit_price_override" ADD CONSTRAINT "unit_price_override_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "unit_price_override" ADD CONSTRAINT "unit_price_override_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "unit_price_override" ADD CONSTRAINT "price_override_unit_tenant_fk" FOREIGN KEY ("unit_id","tenant_id") REFERENCES "public"."unit"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ▼▼▼ Overlap guard (hand-written - not expressible in Drizzle) ▼▼▼
-- No two overrides may overlap on the same unit, so "which override covers this
-- night" always has exactly one answer and quote() never breaks a tie. The
-- booking_no_overlap pattern (btree_gist already installed by 0000):
--   (a) unit_id WITH =               → only the SAME unit conflicts
--   (b) daterange(...,'[)') WITH &&  → half-open, so back-to-back seasons
--                                      ("high until Jul 1" / "peak from Jul 1")
--                                      do not falsely clash
-- No WHERE predicate, unlike booking's: an override has no status axis - a
-- retired price is deleted, not flipped. The GiST index this creates is also the
-- index the quote's "overrides overlapping this window" read wants - no separate
-- btree needed.
ALTER TABLE "unit_price_override" ADD CONSTRAINT "price_override_no_overlap"
  EXCLUDE USING gist (
    "unit_id" WITH =,
    daterange("from_date", "to_date", '[)') WITH &&
  );--> statement-breakpoint
-- ▼▼▼ RLS - not expressible in Drizzle, hand-written like every policy (#74) ▼▼▼
-- A new tenant-owned table without a policy is a boss-fight-#5 regression. Both
-- axes, both fail-closed (0002's nullif form; 0015's property term): the table
-- carries unit_id, not property_id, so it reaches app_property_visible one join
-- out through `unit`, whose own policy also applies - the booking/
-- channel_connection/sync_conflict shape, copied not improvised. Staff pricing an
-- assigned Unit is OPERATING it (the ADR-0032 verb line reserves tenant-shape
-- verbs), so there is no role term here and no @Roles guard on the routes.
ALTER TABLE "unit_price_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "unit_price_override"
  USING (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "unit" u
      WHERE u."id" = "unit_price_override"."unit_id" AND "app_property_visible"(u."property_id")
    )
  )
  WITH CHECK (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "unit" u
      WHERE u."id" = "unit_price_override"."unit_id" AND "app_property_visible"(u."property_id")
    )
  );--> statement-breakpoint
-- Conditional, for the same reason 0012 spelled out: on a fresh database
-- `db:migrate` runs BEFORE `db:setup-role`, so the role may not exist yet.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sambung_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "unit_price_override" TO "sambung_app";
  END IF;
END $$;