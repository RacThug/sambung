-- ▼▼▼ Deleting inventory must never destroy the ledger (ADR-0002, #45) ▼▼▼
-- Until now `unit -> booking -> payment` was CASCADE the whole way down, so
-- DELETE /properties/:id returned 204 and silently took years of past bookings
-- and their payment rows with it. The service guard only counted FUTURE
-- OCCUPYING bookings, so it never saw them: it protected the calendar, not the
-- ledger.
--
-- The guard now refuses on ANY booking ever, and these FKs are the half that
-- makes it a guarantee rather than a convention (invariant #5: app checks are
-- for UX, the DB is for correctness). Under CASCADE the database was an
-- accomplice - it did the destroying.
--
-- BOTH FKs, or neither: booking references unit twice - once by unit_id, once
-- by the (unit_id, tenant_id) composite from #40. Leave either on CASCADE and
-- it deletes the booking first, so the other's check passes against zero rows.
-- A guard that looks installed and does nothing.
--
-- `no action` rather than `restrict`, but NOT for the reason usually given.
-- The folklore is "restrict fires immediately, no action defers, so restrict
-- would break deleting a tenant" (which legitimately cascades tenant ->
-- property -> unit -> booking). That is false. Measured on PG 16.14, with both
-- FKs swapped to RESTRICT:
--
--   delete the unit (has bookings)  -> ERROR 23503   (same as no action)
--   delete the tenant (closure)     -> DELETE 1      (cascade completed)
--
-- Both are non-deferrable AFTER-row triggers checked at end of statement, so
-- the tenant cascade has already removed the bookings before either check runs.
-- The real difference is narrower than the folklore: NO ACTION's check CAN be
-- deferred (DEFERRABLE INITIALLY DEFERRED); RESTRICT's can never be. These
-- constraints are not deferrable, so the two are equivalent here.
--
-- `no action` wins on tie-break only: it is Postgres's default and what
-- drizzle-kit emits from schema.ts, and it keeps deferral available if a future
-- migration ever needs it. The load-bearing change is cascade -> not-cascade.
--
-- payment.booking_id stays CASCADE deliberately: a booking can now only vanish
-- via tenant deletion, where losing the ledger along with the account is intent.
--
-- Free to do now (M1: zero bookings exist). After M2 it is a live-data change.
ALTER TABLE "booking" DROP CONSTRAINT "booking_unit_id_unit_id_fk";
--> statement-breakpoint
ALTER TABLE "booking" DROP CONSTRAINT "booking_unit_tenant_fk";
--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_unit_tenant_fk" FOREIGN KEY ("unit_id","tenant_id") REFERENCES "public"."unit"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- A Unit is ONE sellable thing (ADR-0001), so 8 identical rooms are 8 rows and
-- near-identical names are the common case. M4 wires an OTA iCal feed per unit
-- from a dropdown labelled by name (#28): two rows reading "Garden Room" and the
-- owner connects Airbnb's calendar for one into the other. That is a real
-- overbooking the exclusion constraint cannot catch - the stays don't overlap,
-- they are just on the wrong unit. zod cannot check this (it needs the other
-- rows), so the DB is the only layer that can.
ALTER TABLE "unit" ADD CONSTRAINT "unit_property_name_uniq" UNIQUE("property_id","name");
