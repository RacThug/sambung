-- The Deposit setting (#52, ADR-0015): share of a booking's total collected
-- online at checkout, per-Property. DEFAULT 100 = pay in full, so every existing
-- property keeps today's behaviour with no backfill. CHECK 1-100 mirrors
-- depositPctSchema in @sambung/shared; 0 is excluded because "pay nothing to
-- book" is not this pay-to-confirm funnel.
ALTER TABLE "property" ADD COLUMN "deposit_pct" smallint DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "property" ADD CONSTRAINT "property_deposit_pct_range" CHECK ("property"."deposit_pct" between 1 and 100);