# Sambung — Database Design (teaching edition)

> **Audience:** you (RacThug), building this to sharpen engineering.
> **Approach:** SQL-first. We design the data model, constraints, and integrity rules in raw PostgreSQL — because that's where you *see* the engineering. Mapping to Drizzle comes after and is mechanical.
> **Target:** PostgreSQL 14+ (Supabase / Neon). Uses `daterange`, GiST exclusion constraints, `citext`.

---

## 1. Three design principles

Everything below follows from three rules. Internalize these; they generalize far beyond this project.

1. **Single source of truth.** Availability is *derived* from bookings, never stored separately. Two stores = two things that drift apart = bugs.
2. **Integrity at the data layer.** The database is the last line of defense. If app logic has a race condition, a constraint should still refuse the bad write. Correctness lives as close to the data as possible.
3. **Tenant isolation by construction.** Every tenant-owned row carries `tenant_id`. Isolation is enforced structurally (and optionally by RLS), not by remembering to add a `WHERE` clause everywhere.

---

## 2. Entity map

```
tenant ──┬── app_user ──── user_property ──┐
         │                                  │
         ├── property ───── unit ───────────┤
         │                   │              │
         │                   ├── booking ───┘   (source: direct|airbnb|booking_com|vrbo|manual_block)
         │                   │     └── payment ── payment_event
         │                   └── channel_connection
```

- A **tenant** is one owner account (the SaaS customer).
- **app_user** belongs to a tenant; role `owner` or `staff`. Staff are scoped to specific properties via **user_property**.
- **property** → **unit** (a bookable thing: a whole villa, or a room).
- **booking** is the heart. Direct bookings, OTA-imported blocks, and manual blocks are *all* booking rows — just different `source`.
- **channel_connection** stores an OTA's iCal URL per unit.
- **payment** + **payment_event** handle money and idempotent webhooks.

---

## 3. The schema (full DDL)

```sql
-- Extensions ----------------------------------------------------------------
create extension if not exists btree_gist;  -- lets us mix '=' and '&&' in one exclusion constraint
create extension if not exists citext;       -- case-insensitive email
-- gen_random_uuid() is built into Postgres 13+; on older versions: create extension pgcrypto;

-- Tenancy -------------------------------------------------------------------
create table tenant (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create type user_role as enum ('owner', 'staff');

create table app_user (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id) on delete cascade,
  email         citext not null unique,
  password_hash text not null,
  role          user_role not null default 'staff',
  created_at    timestamptz not null default now()
);

-- Inventory -----------------------------------------------------------------
create table property (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  name        text not null,
  address     text,
  latitude    double precision,
  longitude   double precision,
  description text,
  license_no  text,        -- NIB / KBLI 55193 → drives the "Verified" badge
  created_at  timestamptz not null default now()
);

-- staff scoping: which properties a staff user may touch
create table user_property (
  app_user_id uuid not null references app_user(id) on delete cascade,
  property_id uuid not null references property(id) on delete cascade,
  primary key (app_user_id, property_id)
);

create table unit (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references property(id) on delete cascade,
  tenant_id      uuid not null references tenant(id) on delete cascade,  -- denormalized (see §4.4)
  name           text not null,
  base_price_idr bigint not null check (base_price_idr >= 0),            -- integer rupiah, never float (see §4.5)
  max_guests     int not null default 2 check (max_guests > 0),
  min_stay       int not null default 1 check (min_stay >= 1),
  created_at     timestamptz not null default now()
);

-- Channels ------------------------------------------------------------------
create type sync_status as enum ('never', 'ok', 'error');

create table channel_connection (
  id              uuid primary key default gen_random_uuid(),
  unit_id         uuid not null references unit(id) on delete cascade,
  tenant_id       uuid not null references tenant(id) on delete cascade,
  channel         text not null,            -- 'airbnb' | 'booking_com' | 'vrbo'
  import_ical_url text not null,
  last_synced_at  timestamptz,
  last_status     sync_status not null default 'never',
  last_error      text,
  created_at      timestamptz not null default now()
);

-- Bookings (the heart) ------------------------------------------------------
create type booking_source as enum ('direct', 'airbnb', 'booking_com', 'vrbo', 'manual_block');
create type booking_status as enum ('pending_payment', 'confirmed', 'cancelled', 'expired');

create table booking (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id) on delete cascade,   -- denormalized for RLS
  unit_id               uuid not null references unit(id) on delete cascade,
  source                booking_source not null,
  status                booking_status not null,
  stay                  daterange not null,        -- half-open: [check_in, check_out)
  guest_name            text,                      -- null for manual_block / some imports
  guest_contact         text,
  total_price_idr       bigint check (total_price_idr >= 0),
  external_uid          text,                      -- iCal VEVENT UID, for idempotent re-sync
  channel_connection_id uuid references channel_connection(id) on delete set null,
  hold_expires_at       timestamptz,               -- when a pending_payment hold lapses
  created_at            timestamptz not null default now(),

  constraint stay_nonempty check (not isempty(stay)),

  -- ▼▼▼ THE boss fight, enforced by the DB itself ▼▼▼
  -- No two "occupying" bookings may overlap on the same unit.
  constraint no_overlap exclude using gist (
    unit_id with =,
    stay    with &&
  ) where (status in ('pending_payment', 'confirmed'))
);

-- Idempotent imports: one feed event = exactly one row per connection
create unique index booking_external_uid_uniq
  on booking (channel_connection_id, external_uid)
  where external_uid is not null;

-- Common lookups
create index booking_unit_status_idx on booking (unit_id, status);
create index booking_tenant_idx on booking (tenant_id);

-- Payments ------------------------------------------------------------------
create type payment_status as enum ('pending', 'paid', 'failed');

create table payment (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references booking(id) on delete cascade,
  provider     text not null,             -- 'midtrans' | 'xendit'
  provider_ref text,                       -- order_id / transaction id
  amount_idr   bigint not null check (amount_idr >= 0),
  status       payment_status not null default 'pending',
  raw_payload  jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Idempotent webhooks: record each processed provider event exactly once
create table payment_event (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  provider_event_id text not null,
  booking_id        uuid references booking(id) on delete set null,
  received_at       timestamptz not null default now(),
  unique (provider, provider_event_id)
);
```

---

## 4. Design decisions & rationale (the part that teaches)

### 4.1 Availability is derived, not stored
There is no `availability` table. To answer "is unit X free for these dates?", you query `booking` for any `&&` (overlapping) row with status in (`pending_payment`,`confirmed`). 

**Why:** a separate availability table is a second copy of the truth. Every booking, cancellation, and iCal change would have to update both, in sync, forever. The moment one write succeeds and the other fails, you have a ghost — a date that's "available" in one place and "booked" in another. Deriving availability from the one table that records reality removes a whole category of bug.

**Trade-off you're accepting:** availability queries do range scans instead of point lookups. At this scale, irrelevant; the GiST index makes overlap checks fast. (At Guesty scale you'd add a materialized cache — but that's a *deliberate* optimization layered on top, not the default.)

### 4.2 Half-open date intervals `[check_in, check_out)`
A guest checking out on the 13th frees the 13th for the next guest checking in. If you model stays as closed intervals `[13, 13]` you'll double-block changeover days — the single most common booking-calendar bug.

`daterange(check_in, check_out, '[)')` (the default bound for `daterange`) encodes exactly this: lower bound included, upper excluded. Two stays `[10,13)` and `[13,16)` do **not** overlap. The `&&` operator and the exclusion constraint understand this for free. You get correct changeover behavior without writing a single off-by-one check.

### 4.3 Overlap prevention lives in the database
```sql
exclude using gist (unit_id with =, stay with &&)
  where (status in ('pending_payment', 'confirmed'))
```
Read it as: "for rows matching the WHERE, forbid any two where `unit_id` is equal **and** `stay` overlaps." `btree_gist` is what lets us combine an equality (`=` on uuid) with an overlap (`&&` on range) in one index.

**Why at the DB and not just in app code:** your app will check availability before inserting. But between your check and your insert, another request can slip in (a race). App-layer checks are necessary for good UX (friendly error) but *insufficient* for correctness. The constraint is the wall that cannot be raced — even two simultaneous transactions cannot both commit an overlapping row.

### 4.4 Holds, expiry, and why a cron job is unavoidable
Notice `pending_payment` is inside the exclusion's WHERE. That's a **pessimistic hold**: the moment a guest starts paying, the dates are blocked so a second guest can't race them to the same nights.

But a hold must expire — otherwise an abandoned checkout blocks the calendar forever. The natural instinct is to write `where status = 'confirmed' or (status = 'pending_payment' and hold_expires_at > now())`. **You can't** — exclusion constraint predicates must be immutable, and `now()` is not. The DB can't "self-clean" on a clock.

So the design is: a scheduled job sweeps `pending_payment` rows past `hold_expires_at` and flips them to `expired`. Once flipped, they fall out of the exclusion's WHERE and stop blocking. This is the exact shape of boss-fight #1: **constraint (DB) + hold (model) + expiry sweep (job) + transaction (app)** working together. No single layer solves it alone.

> Open decision: pessimistic holds (above) vs **optimistic** (only `confirmed` blocks; two people can both reach payment, first to confirm wins, second's confirm fails the constraint and you refund/apologize). Pessimistic = better UX, needs the sweeper. Optimistic = simpler, rare ugly edge case. Recommendation: pessimistic with a short TTL (e.g. 15 min).

### 4.5 `tenant_id` is denormalized on `unit` and `booking`
You *could* reach a booking's tenant via `booking → unit → property → tenant`. Instead each row stores `tenant_id` directly.

**Why:** (1) Row-Level Security policies become trivial and fast — `using (tenant_id = current_tenant())` with no joins. (2) Every tenant-scoped query filters on one indexed column. The cost is a consistency obligation: when you insert a booking you must set the same `tenant_id` as its unit. That's a deliberate denormalization for security and performance — name it as such in your README, because reviewers respect a *justified* denormalization and frown on an accidental one.

### 4.6 Money as integer rupiah, never float
`bigint` minor units. IDR has no sub-unit in practice, so integer rupiah is clean. Floats lose pennies to rounding and must never touch money. This is a one-line decision that signals you've been burned before (or learned from people who were).

### 4.7 Idempotent integration points
Two places where the outside world will deliver the same thing twice:
- **iCal imports:** a feed is re-pulled every cycle. `unique (channel_connection_id, external_uid)` means re-importing the same VEVENT updates one row instead of duplicating it. Reconciliation strategy: per connection, upsert by `external_uid`; any previously-imported uid *absent* from the new pull = the OTA booking was cancelled → mark that row `cancelled`.
- **Payment webhooks:** providers guarantee *at-least-once* delivery, so duplicates happen. `payment_event` records each `provider_event_id` once; a duplicate hits the unique constraint and is safely ignored before you mutate booking state.

Idempotency is the single most important habit for integration code. Build it in from line one.

---

## 5. Status lifecycle (FSM)

```
direct booking:   (none) → pending_payment → confirmed
                                  │                │
                                  ├→ expired       └→ cancelled
                                  └→ cancelled

imported/manual:  (none) → confirmed → cancelled
```
Encoding status as an enum + transitions you enforce in code (not arbitrary updates) keeps the model honest. Imported and manual blocks skip the payment dance — they're born `confirmed`.

---

## 6. Open decisions (your call)
1. **Hold strategy:** pessimistic + TTL sweeper (recommended) vs optimistic.
2. **ORM mapping:** decided 2026-07-16 - Drizzle (#41, replacing Prisma). Composite FKs, CHECKs, and the partial unique index are modeled in `schema.ts`; the exclusion constraint and RLS policies stay hand-written SQL in the migration - drift-immune, because drizzle-kit diffs schema snapshots, never the database.
3. **RLS now or later:** ship app-layer tenant guard first; add Postgres RLS as defense-in-depth + a portfolio talking point.

---

## 7. What this design is teaching you
| Decision | Transferable skill |
|---|---|
| Derived availability | Single source of truth; derived vs materialized state |
| Half-open `daterange` | Interval semantics; killing off-by-one bugs |
| Exclusion constraint | Data-layer integrity; correctness near the data |
| Holds + expiry sweeper | Race conditions; why no single layer suffices |
| `tenant_id` denormalization | Justified denormalization; RLS design |
| Integer money | Financial data hygiene |
| `external_uid` / `payment_event` | Idempotency for integrations & webhooks |
| Status enum + FSM | Modeling state explicitly |
