-- Staff invites + property-scoped RBAC (#57, ADR-0032 + ADR-0033).
--
-- Two things land here, and only the first is ordinary DDL:
--   1. `staff_invite` / `staff_invite_property`, and the tenant-consistency
--      follow-up #40 deferred on `user_property`.
--   2. A SECOND AXIS in row-level security. Until now RLS answered one question
--      per row - "does this belong to the current Tenant?" It now answers two:
--      "...and may the current USER see this Property?" That is the whole
--      mechanism behind "staff sees assigned properties only, in every list AND
--      by direct id" (#57 AC #1), and it is why that acceptance criterion needed
--      no change to any of the ~30 authenticated routes.
--
-- ▼▼▼ Part 1: tables and constraints ▼▼▼
--
-- FIRST, because it is the target every composite FK below points at. drizzle-kit
-- emitted this statement LAST, which fails: "there is no unique constraint
-- matching given keys for referenced table app_user". Hand-moved, and this note
-- is here so a future `db:generate` re-ordering it is recognised as a regression
-- rather than a diff to accept.
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_id_tenant_uniq" UNIQUE("id","tenant_id");--> statement-breakpoint
CREATE TABLE "staff_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invite_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "staff_invite_id_tenant_uniq" UNIQUE("id","tenant_id")
);
--> statement-breakpoint
CREATE TABLE "staff_invite_property" (
	"invite_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "staff_invite_property_invite_id_property_id_pk" PRIMARY KEY("invite_id","property_id")
);
--> statement-breakpoint
-- NULLABLE first, then backfilled, then NOT NULL. drizzle-kit generated this as
-- a single `ADD COLUMN ... NOT NULL`, which aborts on any table that already has
-- rows. `user_property` is empty on every database today (nothing has ever
-- written to it - staff accounts arrive with this migration), so the three-step
-- form is defensive rather than necessary. It costs one extra statement and
-- removes the class of failure entirely, including on a database someone
-- hand-seeded.
ALTER TABLE "user_property" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
UPDATE "user_property" up
  SET "tenant_id" = p."tenant_id"
  FROM "property" p
  WHERE p."id" = up."property_id" AND up."tenant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "user_property" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_created_by_tenant_fk" FOREIGN KEY ("created_by","tenant_id") REFERENCES "public"."app_user"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invite_property" ADD CONSTRAINT "staff_invite_property_invite_id_staff_invite_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."staff_invite"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_invite_property" ADD CONSTRAINT "staff_invite_property_property_id_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."property"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_invite_property" ADD CONSTRAINT "staff_invite_property_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_invite_property" ADD CONSTRAINT "staff_invite_property_invite_tenant_fk" FOREIGN KEY ("invite_id","tenant_id") REFERENCES "public"."staff_invite"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invite_property" ADD CONSTRAINT "staff_invite_property_property_tenant_fk" FOREIGN KEY ("property_id","tenant_id") REFERENCES "public"."property"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invite_live_email_uniq" ON "staff_invite" USING btree ("tenant_id","email") WHERE "accepted_at" is null and "revoked_at" is null;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_app_user_tenant_fk" FOREIGN KEY ("app_user_id","tenant_id") REFERENCES "public"."app_user"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_property_tenant_fk" FOREIGN KEY ("property_id","tenant_id") REFERENCES "public"."property"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ▼▼▼ Part 2: the second RLS axis (hand-written - boss fight #5, ADR-0032) ▼▼▼
--
-- THE SHAPE. Two session GUCs, set together with `app.tenant_id` by
-- TenantDbService.run, both derived from the one principal that request acts for:
--
--   app.property_scope   'all'      - an Owner, a Visitor, or a system caller.
--                        'assigned' - a staff member.
--   app.staff_user_id    the staff user's uuid, set only when scope='assigned'.
--
-- WHY TWO GUCS AND NOT ONE. The obvious design is a single GUC holding either
-- the literal 'all' or the staff uuid, and a policy reading
-- `guc = 'all' OR EXISTS (... = guc::uuid)`. That is a bug waiting for a plan
-- change: Postgres does not guarantee the evaluation order of OR, so it is free
-- to evaluate `'all'::uuid` and raise 22P02. Which is precisely the trap #74
-- fixed on the tenant axis, in a new costume. Two GUCs, one text and one uuid,
-- have no cast that can ever run on the wrong value.
--
-- FAIL-CLOSED, LIKE THE TENANT AXIS. If BOTH GUCs are unset (or reset to '' by
-- a pooled connection - see 0002), `app.property_scope` is not 'all' and
-- `app.staff_user_id` is NULL, so the EXISTS matches nothing and the row is
-- filtered. Zero rows, not "everything". A forgotten set_config leaks nothing on
-- either axis; the scope has to be granted, never merely un-restricted.
--
-- ONE AUTHORITY FOR THE RULE. The predicate lives in a single function rather
-- than being copied into eight policies. Copies drift, and a drifted copy here
-- is a silent cross-property read. `stable` (it reads tables, so not immutable)
-- and `parallel safe`; SECURITY INVOKER by default, deliberately - the lookup
-- must run with the caller's rights so `user_property`'s own policy applies to
-- it too, which is what confines a staff member to reading their OWN grants.
CREATE FUNCTION "app_property_visible"("p_property_id" uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT current_setting('app.property_scope', true) = 'all'
        OR EXISTS (
             SELECT 1 FROM "user_property" up
             WHERE up."property_id" = "p_property_id"
               AND up."app_user_id" = nullif(current_setting('app.staff_user_id', true), '')::uuid
           );
  $$;--> statement-breakpoint

-- `user_property` FIRST, and it is the one policy that does NOT call the helper.
--
-- Two reasons, both load-bearing. It now has its own tenant_id, so it no longer
-- needs the EXISTS over `property` that 0000/0002 gave it - and it MUST not have
-- it, because `property`'s new policy reads `user_property`: were user_property's
-- policy still to read `property`, the two would reference each other and the
-- planner would recurse. Denormalizing tenant_id onto this table is what breaks
-- that cycle (see the schema comment).
--
-- The second term is not isolation, it is discretion: a staff member reads their
-- own grants, not the roster of who else can see what. Owners ('all') see the
-- whole table, which is what the team screen renders.
ALTER POLICY "tenant_isolation" ON "user_property"
  USING (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND (
      current_setting('app.property_scope', true) = 'all'
      OR "app_user_id" = nullif(current_setting('app.staff_user_id', true), '')::uuid
    )
  )
  WITH CHECK (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND current_setting('app.property_scope', true) = 'all'
  );--> statement-breakpoint

-- The tenant term is UNCHANGED on every policy below - the property term is
-- ANDed onto it. Tenant isolation is not weakened, relaxed, or re-expressed by
-- this migration; a second, narrower gate is added inside it.
ALTER POLICY "tenant_isolation" ON "property"
  USING (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND "app_property_visible"("property"."id")
  )
  WITH CHECK (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND "app_property_visible"("property"."id")
  );--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "unit"
  USING (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND "app_property_visible"("unit"."property_id")
  )
  WITH CHECK (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND "app_property_visible"("unit"."property_id")
  );--> statement-breakpoint

-- booking / channel_connection / sync_conflict carry unit_id, not property_id,
-- so they reach the rule one join further out. The EXISTS reads `unit`, whose
-- own policy also applies - the answer is the same either way, and letting it
-- apply is cheaper to reason about than a security-definer shortcut.
ALTER POLICY "tenant_isolation" ON "booking"
  USING (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "unit" u
      WHERE u."id" = "booking"."unit_id" AND "app_property_visible"(u."property_id")
    )
  )
  WITH CHECK (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "unit" u
      WHERE u."id" = "booking"."unit_id" AND "app_property_visible"(u."property_id")
    )
  );--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "channel_connection"
  USING (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "unit" u
      WHERE u."id" = "channel_connection"."unit_id" AND "app_property_visible"(u."property_id")
    )
  )
  WITH CHECK (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "unit" u
      WHERE u."id" = "channel_connection"."unit_id" AND "app_property_visible"(u."property_id")
    )
  );--> statement-breakpoint

ALTER POLICY "tenant_isolation" ON "sync_conflict"
  USING (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "unit" u
      WHERE u."id" = "sync_conflict"."unit_id" AND "app_property_visible"(u."property_id")
    )
  )
  WITH CHECK (
    "tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM "unit" u
      WHERE u."id" = "sync_conflict"."unit_id" AND "app_property_visible"(u."property_id")
    )
  );--> statement-breakpoint

-- `payment` and `payment_event` are DELIBERATELY UNTOUCHED, and that is a claim
-- worth stating rather than leaving as an apparent omission.
--
-- Neither has a tenant_id; both already resolve one through a subquery over
-- `booking`. A policy expression runs with the querying user's rights, so the
-- referenced table's OWN policies apply inside it - and `booking`'s policy was
-- just tightened above. The property term therefore reaches payment rows without
-- being restated here.
--
-- Restating it would be a second copy of the rule, which is the drift this
-- codebase keeps refusing (ADR-0012, ADR-0026). But "it follows from a rewriter
-- subtlety" is not something to take on faith for a money table, so the
-- inheritance is PINNED BY A TEST rather than by this comment: rls.test.ts
-- asserts a staff session cannot read a payment belonging to an unassigned
-- Property. If a future Postgres ever changed that behaviour, that test goes red
-- instead of the isolation silently opening.
--
-- ▼▼▼ Part 3: RLS for the new tables ▼▼▼
--
-- Tenant-only, with no property term. An invite is not property-owned - it is an
-- offer of a seat at the Tenant - and every route that touches these tables is
-- @Roles('owner'), which is the authority. A property term here would be a
-- second authorization path to reconcile with the first (the mistake #67's
-- RolesGuard was built to avoid), guarding a table the guarded role can already
-- see all of.
ALTER TABLE "staff_invite" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_invite"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "staff_invite_property" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "staff_invite_property"
  USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Conditional, for the same reason 0012 spelled out: on a fresh database
-- `db:migrate` runs BEFORE `db:setup-role`, so the role may not exist yet.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sambung_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "staff_invite" TO "sambung_app";
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "staff_invite_property" TO "sambung_app";
    GRANT EXECUTE ON FUNCTION "app_property_visible"(uuid) TO "sambung_app";
  END IF;
END $$;
