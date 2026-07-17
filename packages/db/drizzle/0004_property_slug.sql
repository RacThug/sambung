-- The public address: property.slug (#46, api-spec §4.7, ADR-0004).
--
-- drizzle-kit generated `ADD COLUMN "slug" text NOT NULL`, which cannot apply to
-- a table that has rows. Hand-written as the standard four steps instead:
-- add nullable -> backfill -> set not null -> constrain. The snapshot is
-- unchanged, so kit still sees the same end state (it diffs snapshots, never the
-- database).
ALTER TABLE "property" ADD COLUMN "slug" text;--> statement-breakpoint

-- Backfill: a PROVISIONAL slug, deliberately not derived from the name.
--
-- Reproducing slugifyName in SQL would put one rule in two languages, which the
-- ADR log keeps punishing (#80). It would also be effort spent prettifying rows
-- that are about to be deleted: there is no production, so the only rows this
-- can ever touch are dev rows, and `db:seed` wipes and re-inserts them with real
-- slugs on its next run.
--
-- The id, not a random token or its first 8 characters: unique by construction
-- with no collision handling, deterministic (re-running is a no-op), and
-- obviously a placeholder rather than something a reader mistakes for a
-- designed URL.
--
-- `replace(..., '-', '')` because uuid::text has dashes, and doubled or adjacent
-- dashes would fail property_slug_format below.
UPDATE "property" SET "slug" = 'property-' || replace("id"::text, '-', '')
  WHERE "slug" IS NULL;--> statement-breakpoint

ALTER TABLE "property" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint

-- THE check on slug uniqueness, not a backstop for one: RLS hides the rows an
-- app-level pre-check would need to see, so this index is the only thing that
-- can answer "is this slug taken?". The mint loop asks it with ON CONFLICT
-- (slug) DO NOTHING and retries with a new suffix when zero rows come back.
ALTER TABLE "property" ADD CONSTRAINT "property_slug_key" UNIQUE("slug");--> statement-breakpoint

-- Mirrors SLUG_PATTERN in @sambung/shared. Unlike the unit CHECKs (#45), this
-- does not guard external input - the slug is server-derived. It guards our own
-- slugify: a malformed slug is a broken public URL, and it should fail at the
-- write rather than 404 for a guest later.
ALTER TABLE "property" ADD CONSTRAINT "property_slug_format" CHECK ("property"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
