-- Guest contact becomes STRUCTURED (#48, ADR: WhatsApp is the confirmation
-- channel, so M3's wa.me deeplink needs a real phone - not one free-text blob).
-- A rename, not a drop+add: guest_contact already held phone-shaped strings, so
-- the existing values ARE the phone. All three stay nullable - "required" is an
-- API-boundary rule for source=direct, exactly like guest_name.
ALTER TABLE "booking" RENAME COLUMN "guest_contact" TO "guest_phone";--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "guest_email" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "guest_count" integer;--> statement-breakpoint
-- Party size, when set, is a real headcount. Null-tolerant so manual_block and
-- imports (which carry no count) are allowed; the boundary enforces
-- 1 <= guest_count <= unit.max_guests, and this backstops the lower half.
ALTER TABLE "booking" ADD CONSTRAINT "booking_guest_count_positive" CHECK ("booking"."guest_count" IS NULL OR "booking"."guest_count" > 0);
