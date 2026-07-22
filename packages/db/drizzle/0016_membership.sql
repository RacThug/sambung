-- One identity, many memberships (#154, ADR-0034).
--
-- Until now `app_user` answered two questions at once: "who is signing in?" and
-- "who are they here?" Fusing them made `app_user.email` - which must be global,
-- because login carries no tenant - into a limit on the PERSON: one address, one
-- Tenant, forever. A property manager working for two villa owners is squarely
-- in Sambung's market, and #57 could only make that fail legibly (409 at invite
-- time), not work.
--
-- This migration splits the two questions apart:
--   `app_user`   - one human's login. Tenant-free.
--   `membership` - that human's place at ONE Tenant, and the role held there.
--
-- Owner and Staff become what a MEMBERSHIP is, not kinds of person. Nothing
-- about the tenant axis or the property axis of RLS changes shape; the tenant
-- term on `app_user` simply moves to where the tenant now lives.
--
-- ▼▼▼ Part 1: the table ▼▼▼
--
-- Composite PK (app_user_id, tenant_id): a User is a member of a Tenant once or
-- not at all. It is also the FK target the two composite FKs below repoint at,
-- which is why no surrogate id is minted - a surrogate would need a UNIQUE on
-- the same pair anyway, and then there would be two keys for one fact.
CREATE TABLE "membership" (
	"app_user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" "user_role" DEFAULT 'staff' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_app_user_id_tenant_id_pk" PRIMARY KEY("app_user_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_app_user_id_app_user_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint

-- THE BACKFILL, and it must run BEFORE the composite FKs are repointed below.
-- drizzle-kit emitted the repointed FKs with no data step between, which fails
-- on any non-empty database: `user_property` and `staff_invite` have rows whose
-- (user, tenant) pair would reference a `membership` table that is still empty.
-- Hand-inserted, and this note is here so a future `db:generate` dropping it is
-- recognised as a regression rather than a diff to accept.
--
-- `created_at` is carried over rather than defaulted: the membership is exactly
-- as old as the account was, and the default login membership is chosen by
-- (owner first, then oldest), so inventing `now()` here would reorder history.
INSERT INTO "membership" ("app_user_id", "tenant_id", "role", "created_at")
  SELECT "id", "tenant_id", "role", "created_at" FROM "app_user";--> statement-breakpoint

-- ▼▼▼ Part 2: the composite FKs move from app_user to membership ▼▼▼
--
-- Strictly stronger than what they replace. `app_user (id, tenant_id)` said "the
-- user's one tenant is this one"; `membership (app_user_id, tenant_id)` says
-- "the user is a MEMBER of this tenant" - which is the sentence those two FKs
-- were always trying to enforce, and it survives the person having a second
-- tenant. Ending a membership now cascades its Assignments away with it.
ALTER TABLE "staff_invite" DROP CONSTRAINT "staff_invite_created_by_tenant_fk";--> statement-breakpoint
ALTER TABLE "user_property" DROP CONSTRAINT "user_property_app_user_tenant_fk";--> statement-breakpoint
ALTER TABLE "app_user" DROP CONSTRAINT "app_user_id_tenant_uniq";--> statement-breakpoint
ALTER TABLE "app_user" DROP CONSTRAINT "app_user_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "staff_invite" ADD CONSTRAINT "staff_invite_created_by_tenant_fk" FOREIGN KEY ("created_by","tenant_id") REFERENCES "public"."membership"("app_user_id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_property" ADD CONSTRAINT "user_property_app_user_tenant_fk" FOREIGN KEY ("app_user_id","tenant_id") REFERENCES "public"."membership"("app_user_id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ▼▼▼ Part 3: row-level security ▼▼▼
--
-- BEFORE the columns are dropped, not after. `tenant_isolation` on `app_user` is
-- written on `app_user.tenant_id`, so Postgres refuses the DROP COLUMN while the
-- policy still depends on it ("cannot drop column tenant_id ... because other
-- objects depend on it"). drizzle-kit knows nothing about the hand-written
-- policies, so it emitted the drops first; the order below is deliberate.
--
-- `membership`'s policy is FLAT - its own columns and the GUCs, nothing else -
-- and that is load-bearing exactly as it was for `user_property` in 0015
-- (ADR-0032). `app_user`'s policy below reads `membership`; were membership's
-- policy to read `app_user` back, the two would reference each other and the
-- planner would recurse. Carrying tenant_id on this table is what breaks the
-- cycle, and there is nothing else to resolve it through.
--
-- The second term is discretion, not isolation, mirroring `user_property`: a
-- staff member reads their OWN membership, not the roster of who else works
-- here. Owners ('all') see the whole table, which is what the team screen
-- renders. Fail-closed on both axes, like every policy since 0002/0015: unset or
-- pool-reset ('') GUCs match nothing, so zero rows rather than everything.
--
-- WITH CHECK admits owners only. Nothing writes this table under RLS today -
-- register and invite-accept both run on the owner connection - but a policy
-- states what MAY happen, and a staff session minting itself a membership is not
-- something to leave merely un-attempted.
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "membership"
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

-- `app_user` loses the column its policy was written on, so the tenant term moves
-- to where the tenant now lives. This is the SAME question as before - "is this
-- row in my Tenant?" - asked of a row that no longer answers it by itself.
--
-- SECURITY INVOKER semantics apply to the subquery (a policy expression runs with
-- the querying user's rights), so `membership`'s own policy applies inside it.
-- That composes correctly: an owner sees every user of their tenant, a staff
-- member sees only themselves. No route reads another user's row from a staff
-- session today - `GET /staff` is @Roles('owner') - so this narrows nothing that
-- worked, and it is the honest answer if one ever tries.
--
-- WITH CHECK matches USING: a row is writable in this Tenant iff a membership
-- puts it here. Writes to app_user happen on the owner connection (register,
-- invite accept), so this guards a door nobody currently opens - deliberately.
ALTER POLICY "tenant_isolation" ON "app_user"
  USING (
    EXISTS (
      SELECT 1 FROM "membership" m
      WHERE m."app_user_id" = "app_user"."id"
        AND m."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "membership" m
      WHERE m."app_user_id" = "app_user"."id"
        AND m."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
  );--> statement-breakpoint

-- ▼▼▼ Part 4: the fused columns go ▼▼▼
--
-- Last, because the policy above had to stop depending on tenant_id first. After
-- this point `app_user` answers exactly one question - "who is signing in?" -
-- and `membership` answers the other.
ALTER TABLE "app_user" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN "role";--> statement-breakpoint

-- Conditional, for the same reason 0012/0015 spelled out: on a fresh database
-- `db:migrate` runs BEFORE `db:setup-role`, so the role may not exist yet.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sambung_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "membership" TO "sambung_app";
  END IF;
END $$;
