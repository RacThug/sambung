-- Hand-written prelude (drizzle-kit does not emit extensions):
-- btree_gist lets one index mix '=' (uuid) and '&&' (daterange) - needed by
-- the booking_no_overlap exclusion constraint below. citext = case-insensitive
-- email. Hand-added SQL in this file is safe from drift: drizzle-kit diffs
-- schema snapshots against each other, never against the database.
CREATE EXTENSION IF NOT EXISTS "btree_gist";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE TYPE "public"."booking_source" AS ENUM('direct', 'airbnb', 'booking_com', 'vrbo', 'manual_block');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending_payment', 'confirmed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('never', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'staff');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'staff' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "booking" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"source" "booking_source" NOT NULL,
	"status" "booking_status" NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"guest_name" text,
	"guest_contact" text,
	"total_price_idr" bigint,
	"external_uid" text,
	"channel_connection_id" uuid,
	"hold_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_stay_nonempty" CHECK ("booking"."check_out" > "booking"."check_in"),
	CONSTRAINT "booking_total_price_nonneg" CHECK ("booking"."total_price_idr" is null or "booking"."total_price_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "channel_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"import_ical_url" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_status" "sync_status" DEFAULT 'never' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"amount_idr" bigint NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_amount_nonneg" CHECK ("payment"."amount_idr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"booking_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_event_provider_event_uniq" UNIQUE("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "property" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"latitude" double precision,
	"longitude" double precision,
	"description" text,
	"license_no" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_id_tenant_uniq" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_price_idr" bigint NOT NULL,
	"max_guests" integer DEFAULT 2 NOT NULL,
	"min_stay" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_id_tenant_uniq" UNIQUE("id","tenant_id"),
	CONSTRAINT "unit_base_price_nonneg" CHECK ("unit"."base_price_idr" >= 0),
	CONSTRAINT "unit_max_guests_positive" CHECK ("unit"."max_guests" > 0),
	CONSTRAINT "unit_min_stay_positive" CHECK ("unit"."min_stay" >= 1)
);
--> statement-breakpoint
CREATE TABLE "user_property" (
	"app_user_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	CONSTRAINT "user_property_app_user_id_property_id_pk" PRIMARY KEY("app_user_id","property_id")
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_channel_connection_id_channel_connection_id_fk" FOREIGN KEY ("channel_connection_id") REFERENCES "public"."channel_connection"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_unit_tenant_fk" FOREIGN KEY ("unit_id","tenant_id") REFERENCES "public"."unit"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_unit_tenant_fk" FOREIGN KEY ("unit_id","tenant_id") REFERENCES "public"."unit"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payment_event" ADD CONSTRAINT "payment_event_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_property_tenant_fk" FOREIGN KEY ("property_id","tenant_id") REFERENCES "public"."property"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "booking_unit_status_idx" ON "booking" USING btree ("unit_id","status");--> statement-breakpoint
CREATE INDEX "booking_tenant_idx" ON "booking" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_external_uid_uniq" ON "booking" USING btree ("channel_connection_id","external_uid") WHERE "booking"."external_uid" is not null;--> statement-breakpoint
-- ▼▼▼ Boss fight #1: overlap guard (hand-written - not expressible in Drizzle) ▼▼▼
-- No two "occupying" bookings may overlap on the same unit. This is the real
-- double-booking guard: even two simultaneous transactions cannot both commit.
--   (a) unit_id WITH =        → only the SAME unit conflicts (needs btree_gist)
--   (b) daterange(...,'[)') WITH &&  → ranges that OVERLAP; half-open so a
--       checkout day frees up for the next guest's check-in (no false clash)
--   (c) WHERE status IN (...) → only live holds/bookings occupy; cancelled and
--       expired rows step aside so their dates can be rebooked
ALTER TABLE "booking" ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (
    "unit_id" WITH =,
    daterange("check_in", "check_out", '[)') WITH &&
  ) WHERE ("status" IN ('pending_payment', 'confirmed'));--> statement-breakpoint
-- ▼▼▼ Boss fight #5: Row-Level Security (hand-written - defense-in-depth) ▼▼▼
-- The app connects as a NON-OWNER role (sambung_app; scripts/setup-app-role.ts)
-- so these policies apply; migrations/seed run as the owner, which bypasses RLS.
-- Fail-closed: the app sets `app.tenant_id` per transaction (set_config). If it
-- is unset, current_setting(...,true) is NULL and every row comparison is false
-- → zero rows. A forgotten WHERE leaks nothing.
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant"
  USING ("id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "app_user"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "property" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "property"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "unit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "unit"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "channel_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "channel_connection"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "booking" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
-- Child tables without their own tenant_id: scope via their parent.
ALTER TABLE "user_property" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "user_property"
  USING (EXISTS (
    SELECT 1 FROM "property" p
    WHERE p."id" = "user_property"."property_id"
      AND p."tenant_id" = current_setting('app.tenant_id', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "property" p
    WHERE p."id" = "user_property"."property_id"
      AND p."tenant_id" = current_setting('app.tenant_id', true)::uuid
  ));--> statement-breakpoint
ALTER TABLE "payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment"
  USING (EXISTS (
    SELECT 1 FROM "booking" b
    WHERE b."id" = "payment"."booking_id"
      AND b."tenant_id" = current_setting('app.tenant_id', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "booking" b
    WHERE b."id" = "payment"."booking_id"
      AND b."tenant_id" = current_setting('app.tenant_id', true)::uuid
  ));--> statement-breakpoint
ALTER TABLE "payment_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_event"
  USING (
    "booking_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "booking" b
      WHERE b."id" = "payment_event"."booking_id"
        AND b."tenant_id" = current_setting('app.tenant_id', true)::uuid
    )
  )
  WITH CHECK (
    "booking_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "booking" b
      WHERE b."id" = "payment_event"."booking_id"
        AND b."tenant_id" = current_setting('app.tenant_id', true)::uuid
    )
  );