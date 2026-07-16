# @sambung/db

Prisma schema, migrations, and client for Sambung. **Imported only by `apps/api`** (never `apps/web` — invariant #1).

## Why some integrity rules are hand-written SQL

Prisma's schema language cannot express three things this project depends on. They are added **by hand** in the migration SQL, and Prisma leaves them alone (it doesn't track CHECK/EXCLUDE constraints), so they won't cause drift:

1. **The `no_overlap` GiST exclusion constraint** — the real double-booking guard (boss fight #1).
2. **CHECK constraints** — `check_out > check_in`, and `>= 0` on money columns.
3. **Composite tenant-consistency FKs** (`tenant_consistency_fks` migration, issue #40) - `booking (unit_id, tenant_id) → unit (id, tenant_id)`, plus `unit → property` and `channel_connection → unit`. They make the denormalized `tenant_id` (db-design §4.5) self-enforcing; Prisma can't model a second, composite FK over an existing relation. FK checks bypass RLS, so the `sambung_app` role is unaffected.
4. (Partial indexes, if we ever want them — currently `@@unique` covers the iCal dedupe because Postgres treats NULLs as distinct.)

Extensions (`btree_gist`, `citext`) **are** declared in `schema.prisma` and created automatically by Prisma's migration.

## The constraint we model on an expression (Approach A)

We keep `check_in` / `check_out` as normal Prisma `@db.Date` columns — **no `stay` column**. The daterange is computed inside the constraint, so Prisma fully owns every column and there's no generated-column drift:

```
EXCLUDE USING gist (unit_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
  WHERE (status IN ('pending_payment','confirmed'))
```

Half-open `[)` so checkout day = next check-in day does **not** conflict (db-design §4.2). `pending_payment` is included so a checkout-in-progress holds the dates (db-design §4.4); expiring those holds is a cron job in #17, not the DB's job.

---

## ▶ Driver task (#3) — what to build

> Runway is done (schema models, Docker, env, client generation). You write the migration's raw SQL + the test. Reference DDL: **docs/db-design.md §3** (note: adapt to the **expression** form above — there is no `stay` column).

### Steps
1. **Start Docker Desktop**, then bring up Postgres:
   ```
   docker compose up -d
   ```
2. Create the migration **without applying it** (generates the SQL from the models):
   ```
   pnpm --filter @sambung/db db:migrate:create --name init_schema
   ```
3. **Hand-edit** the generated file at `packages/db/prisma/migrations/<ts>_init_schema/migration.sql`:
   add, after the `CREATE TABLE "booking"` statement —
   - [ ] the `no_overlap` `EXCLUDE USING gist (...)` constraint (expression form, with the `WHERE` on status)
   - [ ] `CHECK (check_out > check_in)` on `booking`
   - [ ] `CHECK (... >= 0)` on `unit.base_price_idr`, `booking.total_price_idr`, `payment.amount_idr`
4. Apply it:
   ```
   pnpm --filter @sambung/db db:migrate
   ```

### Then prove the AC (write an integration test against the running DB)
A test (in `apps/api` or `packages/db`) that asserts:
- [ ] migration applied; can insert a `confirmed` booking `[10,13)`.
- [ ] a second overlapping `confirmed` booking `[12,15)` on the **same unit** → Postgres error **`23P01`** (exclusion_violation).
- [ ] the **changeover** case `[13,16)` on the same unit → **succeeds** (proves half-open).
- [ ] the same overlap on a **different unit** → succeeds.
- [ ] a `cancelled` booking does **not** block its dates (proves the `WHERE`).

I'll review the migration + test against this checklist, then a fresh reviewer does the Two-Session Review before merge.

## Tenant isolation (RLS) — boss fight #5

Defense-in-depth lives at the DB layer too. Row-Level Security policies (in the
`rls_tenant_isolation` migration) scope every tenant-owned table by
`current_setting('app.tenant_id')` — **fail-closed**: no GUC → zero rows.

Two database identities:
- **owner** (`sambung`, `DATABASE_URL`) — migrations, seed, and system ops
  (auth/registration creates a tenant *before* a tenant context exists). Bypasses RLS.
- **app role** (`sambung_app`, `APP_DATABASE_URL`) — runtime tenant-scoped queries.
  Non-owner, so RLS applies. The API's `TenantPrismaService` connects as this role
  and sets `app.tenant_id` per transaction (parameterized `set_config`).

After `db:migrate`, run **`db:setup-role`** once to create the app role + grants
(roles aren't portable schema, so they live in a script, not a migration).

## Commands
```
pnpm --filter @sambung/db db:generate       # regenerate client after schema edits
pnpm --filter @sambung/db db:migrate        # create + apply a migration (dev)
pnpm --filter @sambung/db db:setup-role     # create the non-owner app role (RLS)
pnpm --filter @sambung/db db:studio         # browse data
pnpm --filter @sambung/db db:reset          # drop + replay all migrations
```

> **Neon later:** hosted Postgres needs a `shadowDatabaseUrl` (it can't create databases on the fly). Local Docker doesn't — the `sambung` superuser creates the shadow DB itself.
