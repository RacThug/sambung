-- ▼▼▼ The sync-conflict inbox (#38, boss fight #3, ADR-0027, db-design §4.8) ▼▼▼
-- When an OTA sells nights that overlap an existing occupying booking, a real-world
-- double-sell happened out there and `booking_no_overlap` refuses the import (23P01).
-- The refusal is correct - but the losing VEVENT then exists NOWHERE: no booking row,
-- and the feed is transient. This table is the one thing Sambung stores because it
-- genuinely cannot derive it.
--
-- An OPS INBOX, not an availability source: no availability or booking query reads
-- this table, so invariant #3 is untouched and a conflict blocks nothing. It asks a
-- human to pick the loser in the real world - money and a guest are attached to both
-- sides, so the machine must never auto-cancel (ADR 2026-07-16).
--
-- Three statuses, because dismiss and resolve are different KINDS of fact:
--   open      an imported VEVENT the constraint still refuses
--   resolved  the world fixed itself (blocking booking cancelled / OTA withdrew the
--             event) - a MEASUREMENT, which the next sync may re-take (→ open again)
--   dismissed the owner JUDGED it a non-issue - re-detection must never undo that,
--             or a dismissed item resurrects every 30 minutes forever (ADR-0027)
--
-- No raw VEVENT column: ADR-0025's parser drops SUMMARY/DESCRIPTION so imported guest
-- PII cannot enter through the feed, and storing the raw block would re-admit exactly
-- that through a side door.
CREATE TYPE "public"."sync_conflict_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TABLE "sync_conflict" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_connection_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"external_uid" text NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"status" "sync_conflict_status" DEFAULT 'open' NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "sync_conflict_connection_uid_uniq" UNIQUE("channel_connection_id","external_uid"),
	CONSTRAINT "sync_conflict_stay_nonempty" CHECK ("sync_conflict"."check_out" > "sync_conflict"."check_in")
);
--> statement-breakpoint
ALTER TABLE "sync_conflict" ADD CONSTRAINT "sync_conflict_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sync_conflict" ADD CONSTRAINT "sync_conflict_channel_connection_id_channel_connection_id_fk" FOREIGN KEY ("channel_connection_id") REFERENCES "public"."channel_connection"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sync_conflict" ADD CONSTRAINT "sync_conflict_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sync_conflict" ADD CONSTRAINT "sync_conflict_unit_tenant_fk" FOREIGN KEY ("unit_id","tenant_id") REFERENCES "public"."unit"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_conflict_tenant_status_idx" ON "sync_conflict" USING btree ("tenant_id","status");--> statement-breakpoint
-- ▼▼▼ RLS - not expressible in Drizzle, hand-written like every policy (#74) ▼▼▼
-- A new tenant-owned table without a policy is a boss-fight-#5 regression: the app
-- role would read every tenant's conflicts. Same `nullif(..., '')` form migration
-- 0002 established - `set_config(..., true)` reverts at COMMIT to '' (not NULL) for
-- a GUC already set once on that pooled connection, so the nullif is what makes an
-- unset tenant fail CLOSED (zero rows) on a warm connection as well as a cold one.
-- The comparison stays uuid = uuid, so sync_conflict_tenant_status_idx stays usable.
--
-- The IMPORT writes this table on the RLS-BYPASSED owner connection (ADR-0025), so
-- this policy guards the read/dismiss side (the owner's authed RLS connection). On
-- the write side the guard is the composite FK above, which makes a wrong tenant_id
-- unrepresentable rather than merely filtered.
ALTER TABLE "sync_conflict" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sync_conflict"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- The app role's DML grants were applied with `GRANT ... ON ALL TABLES` at role setup
-- (scripts/setup-app-role.ts), which does NOT cover tables created afterwards. That
-- script also ran ALTER DEFAULT PRIVILEGES, which DOES cover new tables created by the
-- same owner role - the role running this migration - so in the normal case this is
-- redundant. It is here because this is the first migration since the baseline to
-- create a table, so that path has never actually been exercised, and the failure mode
-- is a permission denied at runtime rather than at migrate time.
--
-- CONDITIONAL, because ordering is not guaranteed: on a fresh database `db:migrate`
-- runs BEFORE `db:setup-role`, so the role may not exist yet. An unconditional GRANT
-- would abort the migration; this no-ops and setup-role's ON ALL TABLES then covers it.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sambung_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "sync_conflict" TO "sambung_app";
  END IF;
END $$;