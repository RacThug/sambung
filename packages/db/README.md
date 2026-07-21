# @sambung/db

Drizzle schema, migrations, and client for Sambung. **Imported only by `apps/api`** (never `apps/web` — invariant #1).

## Layout

```
src/schema.ts      the schema, in TypeScript (tables, enums, FKs, checks, indexes)
src/index.ts       createDb() + shared owner client + pg error helpers
drizzle/           SQL migrations + drizzle-kit journal (meta/)
scripts/           seed, reset, app-role setup (dev/infra, not part of the build)
```

## How schema changes work

1. Edit `src/schema.ts`.
2. `pnpm --filter @sambung/db db:generate` → drizzle-kit writes a new `.sql` file under `drizzle/`.
3. Review the generated SQL (hand-edit if needed — that is a supported, normal part of the workflow).
4. `pnpm --filter @sambung/db db:migrate` applies it.

**Why there is no drift hazard here:** drizzle-kit generates migrations by diffing schema *snapshots* (in `drizzle/meta/`) against each other — it never diffs against the live database. Hand-written SQL inside a migration file is therefore invisible to the generator and can never be "reverted" by a later generated migration. (This was a real footgun in the Prisma era of this package; see ADR 2026-07-16 and issue #41.)

## What lives in schema.ts vs hand-written SQL

Drizzle models almost everything, including the parts Prisma could not:

- **Composite tenant-consistency FKs** (db-design §4.5, #40) — `booking (unit_id, tenant_id) → unit (id, tenant_id)`, plus `unit → property` and `channel_connection → unit`. A row whose denormalized `tenant_id` disagrees with its parent chain is unrepresentable. FK checks bypass RLS, so the app role is unaffected.
- **CHECK constraints** — `check_out > check_in`, `>= 0` on money columns, `max_guests > 0`, `min_stay >= 1`.
- **Partial unique index** for idempotent iCal imports — `(channel_connection_id, external_uid) WHERE external_uid IS NOT NULL` (db-design §4.7).

Two things remain hand-written SQL in `drizzle/0000_init.sql` (clearly marked):

1. **The `booking_no_overlap` GiST exclusion constraint** — the real double-booking guard (boss fight #1). Expression form — no `stay` column; the daterange is computed inside the constraint:
   ```
   EXCLUDE USING gist (unit_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
     WHERE (status IN ('pending_payment','confirmed'))
   ```
   Half-open `[)` so checkout day = next check-in day does **not** conflict (db-design §4.2). `pending_payment` is included so a checkout-in-progress holds the dates (db-design §4.4); expiring those holds is a cron job, not the DB's job.
2. **The RLS policies** (boss fight #5, defense-in-depth) — see below.

Extensions (`btree_gist`, `citext`) are also hand-written at the top of the baseline (drizzle-kit does not emit them).

## Tenant isolation (RLS) — boss fight #5

Row-Level Security policies scope every tenant-owned table by
`current_setting('app.tenant_id')` — **fail-closed**: no GUC → zero rows.

Two database identities:
- **owner** (`sambung`, `DATABASE_URL`) — migrations, seed, and system ops
  (auth/registration creates a tenant *before* a tenant context exists). Bypasses RLS.
- **app role** (`sambung_app`, `APP_DATABASE_URL`) — runtime tenant-scoped queries.
  Non-owner, so RLS applies. The API's `TenantDbService` connects as this role and
  sets `app.tenant_id` per transaction (parameterized `set_config`).

After migrating a fresh database, run **`db:setup-role`** once to create the app
role + grants (roles aren't portable schema, so they live in a script, not a migration).

## Dates are strings on purpose

`check_in` / `check_out` map to plain `'YYYY-MM-DD'` strings (`mode: "string"`).
A stay is a *calendar date*, not an instant — JS `Date` objects drag timezones
into interval logic and invite off-by-one bugs at UTC boundaries.

## Commands

```
pnpm --filter @sambung/db db:generate      # diff schema.ts -> new SQL migration
pnpm --filter @sambung/db db:migrate       # apply pending migrations
pnpm --filter @sambung/db db:setup-role    # create the non-owner app role (RLS)
pnpm --filter @sambung/db db:seed          # 2 tenants, 3 properties, demo-ready bookings (docs/demo.md)
pnpm --filter @sambung/db db:reset         # drop everything, replay migrations, role + seed
pnpm --filter @sambung/db db:studio        # browse data
pnpm --filter @sambung/db test             # constraint/RLS integration tests (needs Docker)
```

Copy `.env.example` to `.env` first — the tests need **two** connections. `DATABASE_URL` is the
owner (migrations, seed, and the constraint tests); `APP_DATABASE_URL` is the non-owner role, and
it is the only way to exercise the RLS policies, because the owner is exempt from them. Run
`db:setup-role` before `test`, or the app role won't exist.

| Test file | Seam it guards |
|---|---|
| `overlap.test.ts` | `booking_no_overlap` — one test per clause of the exclusion constraint |
| `tenant-consistency.test.ts` | the composite FKs that make a wrong `tenant_id` unrepresentable |
| `rls.test.ts` | all 9 RLS policies: scoping, `WITH CHECK`, and fail-closed on a **warm** connection (#74) |
| `demo-dates.test.ts` | the seed's date model (`scripts/demo-dates.ts`): every seeded stay lands in the future on any day of the year, no two stays in one unit overlap, and the seeded sync conflict overlaps its blocking booking only partially (#60). Pure - the one file here that needs no database |
