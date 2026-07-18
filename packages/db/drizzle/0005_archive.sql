-- ▼▼▼ Archive: retire inventory that has history (ADR-0005, #84) ▼▼▼
-- The verb ADR-0002 named and deferred. ADR-0002 made a Unit/Property that any
-- booking ever referenced undeletable (to protect the ledger), which left an
-- owner who stops renting a room no way to hide it. archived_at is that exit.
--
-- NULL = active. Effective-archived is DERIVED, never cascaded:
--   unit is archived  ==  unit.archived_at IS NOT NULL
--                      OR its property.archived_at IS NOT NULL
-- so archiving a Property touches only the property row, and unarchiving it
-- restores exactly the Units that weren't retired on their own account - no
-- cascade write, no restore-marker (see ADR-0005 for why that beats cascading).
--
-- Nullable, no default, no backfill: every existing row is active, which is
-- exactly what NULL already means. No partial index yet - at this scale the
-- filter is free, and an index would be a perf tool, not the correctness guard
-- (that is the booking chokepoint, §5.3).
ALTER TABLE "property" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "unit" ADD COLUMN "archived_at" timestamp with time zone;
