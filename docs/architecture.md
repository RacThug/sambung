# Sambung — Architecture (teaching edition)

> **Stack (final):** Vite + React + TypeScript + Tailwind (FE, SPA) · NestJS + TypeScript + PostgreSQL (BE) · pnpm + Turborepo monorepo.
> **Approach:** same as the DB doc — every decision comes with the *why*, because the goal is to sharpen your engineering, not just ship.

---

## 1. The one principle everything follows

**The frontend never touches the database. All data flows through the NestJS API.**

```
React SPA  ──REST(JSON)──►  NestJS API  ──►  PostgreSQL
   │                            ├─ scheduler  (pull iCal, sweep expired holds)
   │                            └─ webhooks   (payment provider → confirm)
   └─ render, routing, i18n, auth session, call API
```

This hard boundary is the whole reason we split FE/BE. The SPA is "dumb" presentation; the API is the brain — it owns business rules, multi-tenancy, money, and all the long-running jobs. For a portfolio, a cleanly separated API signals "I can build a real backend," not just a fullstack app where the layers blur.

---

## 2. Monorepo layout

```
sambung/
├── apps/
│   ├── web/                 # Vite + React SPA — public booking + owner dashboard
│   └── api/                 # NestJS — REST API + scheduler + webhooks
├── packages/
│   ├── shared/              # shared TS types + zod schemas (the FE⇄BE contract)
│   ├── db/                  # Drizzle schema + migrations + client  (imported ONLY by api)
│   └── config/              # eslint / tsconfig / tailwind presets
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

**Teaching point — `packages/shared` is the contract.** Request/response types and zod schemas live here. `api` validates incoming data against the zod schema; `web` imports the *same* types so a wrong field name is a compile error, not a runtime surprise. One source of truth for the API shape.

**Teaching point — `web` may import `shared`, never `db`.** This enforces §1 at the dependency level: the frontend physically cannot import the DB client. Boundaries you can *accidentally* cross aren't boundaries.

---

## 3. Backend (NestJS)

### 3.1 Layering
Every request flows through three layers. Keep each honest:

```
Controller  → HTTP only: parse, validate (zod/DTO), return. No logic.
Service     → business rules, transactions, the boss fights.
Repository  → Drizzle queries. No business rules.
```
Thin controllers, fat services, dumb repositories. The most common junior mistake is logic leaking into controllers; resist it.

### 3.2 Module map
```
api/src/
├── common/
│   ├── guards/            JwtAuthGuard, RolesGuard
│   ├── interceptors/      TenantContextInterceptor
│   ├── decorators/        @CurrentPrincipal()
│   └── filters/           global exception filter (consistent error shape)
└── modules/
    ├── auth/              register, login, refresh, JWT issuing
    ├── property/          property CRUD
    ├── unit/              unit CRUD, pricing rules
    ├── booking/           availability + booking — THE core (boss fights #1, #2)
    ├── channel-sync/      iCal import scheduler + export feed (boss fight #3)
    ├── payment/           payment init + idempotent webhook (boss fight #4)
    └── notification/      email + WhatsApp deeplink
```

### 3.3 Multi-tenancy enforcement (boss fight #5)
1. `JwtAuthGuard` validates the access token, mints the `Principal` (JWT's `sub` becomes `userId` here — the token's vocabulary stops at the guard), attaches `req.user`, and seeds `TenantContext`.
2. `TenantContext` owns the principal: its type, its storage (AsyncLocalStorage via `nestjs-cls`), and its key. Everything reads the tenant from there — services, repositories, and `TenantDbService` — so nothing threads a `tenant_id` parameter that someone could forget, or pass wrong. No principal → it throws; a request with no tenant is a bug, not a query.
3. **Every** repository query filters by `tenant_id`. No exceptions, because the denormalized column (DB doc §4.5) makes it one cheap `WHERE`. This is not redundant with the ambient read — both come from the same place, so they cannot disagree. It guards **RLS not being in force at all**: boot against `DATABASE_URL` instead of `APP_DATABASE_URL` and the owner role bypasses every policy, leaving this `WHERE` as the only thing standing. That's one env var.
4. (Defense in depth) Postgres RLS policies `using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)` — `TenantDbService.run` sets the GUC per transaction, on a non-owner role. Even a forgotten `WHERE` returns nothing instead of leaking.
   The `nullif` is load-bearing, not noise: `set_config(..., is_local => true)` reverts at COMMIT to the GUC's *reset* value, which for a custom GUC already set once on that session is the **empty string, not NULL**. Without it, a query with no tenant returns zero rows on a fresh connection but errors `22P02` on a pooled one that has served a request — so "fail-closed" held only until the pool warmed up (#74).

**The public path (no token) — same machinery, different mint.** A Visitor has no JWT, so step 1 never runs and steps 2–4 would throw. The funnel's entry is also *cross-tenant*: you can't scope by tenant before finding the property, because the property is what tells you the tenant. So `PublicScope.enterFromSlug` runs **one** statement on the owner connection — `select tenant_id from property where slug = $1` — and seeds `TenantContext` with `{ kind: 'visitor', tenantId }`. From there, steps 2–4 are untouched: same `run`, same RLS, same `WHERE`. The Visitor is a principal, not an exception to the rule ([ADR-0003](adr/0003-a-visitor-is-a-principal.md), #77).

`Principal` is a union — `UserPrincipal | VisitorPrincipal` — so `principal.role` doesn't compile until the Visitor case is handled. A Visitor can't drift into a role check by looking close enough to an Owner. The one unscoped statement reads a single column keyed by a deliberately-public value and returns nothing renderable: when `property` grows a payout account, that step can't leak it, because it doesn't select it.

> The portfolio money-shot: a test that logs in as tenant A, requests tenant B's booking by ID, and asserts 404. Two layers (app guard + RLS) both have to fail for a leak.
>
> Both layers are tested **alone**, because a claim about two layers is worth nothing if either is only ever exercised behind the other. `properties.spec.ts` proves RLS scopes a query with no `WHERE`, and proves the `WHERE` scopes with RLS bypassed (repository over an owner-role connection). `packages/db/test/rls.test.ts` covers all 9 policies at the DB seam.

### 3.4 The scheduler (why NestJS, not serverless)
`channel-sync` uses `@nestjs/schedule`:
- **`@Cron('*/30 * * * *')`** — pull every `channel_connection`'s iCal, reconcile bookings.
- **`@Cron('*/5 * * * *')`** — sweep `pending_payment` rows past `hold_expires_at` → `expired` (the piece the exclusion constraint can't do itself; DB doc §4.4).

This is the concrete reason we didn't go Next.js-fullstack: these jobs need an **always-on process**. Serverless functions are the wrong tool for recurring background work.

### 3.5 API contract (representative endpoints)

**Auth**
```
POST /auth/register          → create tenant + owner
POST /auth/login             → access token (body) + refresh token (httpOnly cookie)
POST /auth/refresh           → new access token
```

**Owner (authenticated, tenant-scoped)**
```
GET    /properties                       PATCH /properties/:id
POST   /properties                       POST  /properties/:id/units
GET    /units/:id/calendar               POST  /bookings        (manual block / walk-in)
GET    /bookings?from=&to=&propertyId=
POST   /units/:id/channels               POST  /channels/:id/sync   (force "Sync now")
```

**Public (no auth — the booking funnel)**
```
GET  /public/properties/:slug
GET  /public/units/:id/availability?from=&to=     → price + free/blocked
POST /public/bookings                              → creates pending_payment + hold
POST /public/bookings/:id/pay                       → init Midtrans/Xendit session
GET  /public/units/:id/calendar.ics                 → export feed (paste back into OTAs)
```

**Webhooks**
```
POST /webhooks/payment/:provider   → idempotent (payment_event dedupe) → confirm
```

### 3.6 Object storage (photos)

S3-compatible API as the contract, backend swapped by env config: **Garage** in docker compose for dev, **Cloudflare R2 free tier** in prod (10 GB, zero egress; activation needs a card on file, stays $0 — flagged per invariant #8; fallback: Garage on the VPS, identical code path). Uploads use **presigned PUT URLs**: the API validates content type, size, and tenant ownership at presign time, then the browser talks to storage directly — the API never proxies bytes and the SPA never sees credentials. (Issue #39; Garage replaced the retired MinIO CE per the ADR log.)

---

## 4. Frontend (Vite + React SPA)

### 4.1 Structure
```
web/src/
├── main.tsx
├── router.tsx               TanStack Router (typed route tree)
├── lib/
│   ├── api-client.ts        fetch wrapper: base URL, attaches access token, refresh-on-401
│   └── query.ts             React Query (TanStack) client
├── features/
│   ├── public-booking/      property page, availability picker, checkout
│   └── dashboard/           calendar, reservations, channels, settings
├── components/              shared UI (Tailwind)
└── i18n/                    EN / ID / 中文
```

### 4.2 Two faces, one SPA
- **Public funnel** (`/p/:slug`) — no auth. SEO-relevant → see §6.
- **Dashboard** (`/app/*`) — behind an auth guard route; pure interactivity, zero SEO need. This is exactly where an SPA shines and Next would be overkill.

### 4.3 Server state = React Query, not Redux
Most "state" here is *server* state (bookings, availability). React Query handles caching, refetch, loading/error for you. Don't reach for a global store for data that lives on the server — a classic over-engineering trap. Local UI state stays in component `useState`.

### 4.4 Auth token handling (teaching nuance)
- **Access token:** short-lived (~15 min), kept **in memory** (a module variable / context), attached as `Authorization: Bearer`.
- **Refresh token:** **httpOnly, Secure cookie** scoped to the API domain — JS can't read it, so XSS can't steal it.
- On a `401`, `api-client` silently calls `/auth/refresh`, retries once.
- Same-origin in production (§7): Caddy serves the SPA and proxies `/api` on one domain, so the refresh cookie is plain first-party (`SameSite=Lax` works) and no CORS-with-credentials is needed. If web and api ever split origins (e.g. SPA moves to a CDN), the cookie needs `SameSite=None; Secure` and CORS must allow credentials - a real gotcha worth understanding either way.

> Avoid putting tokens in `localStorage`. It's readable by any script → XSS = full account takeover. Naming this trade-off in your README is a senior signal.

---

## 5. Three data flows (trace these until they're obvious)

**A. Direct booking (the race-condition path)**
```
1. GET /public/units/:id/availability      → service checks booking overlap
2. POST /public/bookings                     → TXN: re-check + INSERT pending_payment
                                                with hold_expires_at = now()+15min.
                                                Exclusion constraint is the real guard:
                                                a racing insert fails here, not in app code.
3. POST /public/bookings/:id/pay             → Midtrans Snap sandbox session
4. guest pays → POST /webhooks/payment/...   → idempotent → TXN: payment=paid,
                                                booking=confirmed → notify
   (unpaid holds expire via the 5-min sweeper)
```

**B. iCal sync (the integration path)**
```
@Cron 30m → for each channel_connection:
  fetch import_ical_url → parse VEVENTs (node-ical)
  parse unhealthy? → last_status=error, STOP (never reconcile a broken feed)
  per VEVENT, inside a savepoint:
    upsert booking by (channel_connection_id, external_uid), source=channel, status=confirmed
    ├─ exclusion violation (23P01) → record sync_conflict, continue  (db-design §4.8)
    └─ ok → close any open conflict for that uid
  uids in DB but ABSENT from the healthy feed → status=cancelled   (an OTA cancellation)
  update last_synced_at + last_status
Export: GET .../calendar.ics → build feed from confirmed bookings (ics lib)
```

**C. Payment webhook (the idempotency path)**
```
provider POSTs (maybe twice) → INSERT into payment_event (provider, provider_event_id)
  unique violation? → already processed → 200 OK, do nothing
  fresh? → TXN: update payment + booking, then commit
```

---

## 6. SEO for the public pages (the SPA trade-off)
SPA HTML is thin until JS runs → weaker SEO by default. Handle it in tiers (pick per ambition):
1. **Showcase-enough:** correct meta/OG tags per property. Modern Googlebot renders JS, so pages still index. **Built** (#46) — no dependency: React 19 hoists `<title>`/`<meta>` from anywhere in the tree into `<head>` natively, so the react-helmet this doc used to recommend is neither needed nor maintained.
2. **Shows you get SEO:** serve bots real HTML.
3. **Production-real:** SSR just the public pages via Astro (React islands) or Next, dashboard stays SPA.

> **Tier 1 is not enough here, and it's worth being precise about why.** Client-rendered OG tags are invisible to *every* link-preview crawler — WhatsApp, `facebookexternalhit`, Twitterbot, Telegram, LINE. They fetch raw HTML and never execute JS, so a forwarded villa previews as a blank card reading "Sambung". Googlebot is fine; the crawler this product lives on is not. Sambung's whole distribution model is a link pasted into a chat — in Indonesia, WhatsApp — so the gap sits exactly where the value is (#46, FR-NOTIF-2).
>
> Tier 2 is also cheaper than "Prerender / Puppeteer snapshot" implies, which is what made it look like a bigger step than it is: **social crawlers only read meta tags — they never render.** So Caddy can match their user agents and proxy to a small API route that returns a static OG stub, while humans and Googlebot get the real SPA. A template, not a headless browser on a $5 VPS. Tracked as #87.

For the portfolio, tier 1–2 + a README note "in production I'd SSR the public funnel" is the mature answer.

---

## 7. Deployment topology

Everything runs on **one small VPS** - the project's single recurring cost (~$5/mo, CLAUDE.md invariant #8 as amended):

```
                     ┌───────────────── VPS ─────────────────┐
Internet ── :443 ──► │ Caddy (auto-TLS)                       │
                     │   ├─ /*      → static SPA build (web)  │
                     │   └─ /api/*  → NestJS api (Docker)     │
                     │                 └─► PostgreSQL (Docker)│
                     └────────────────────────────────────────┘
```

- **Why a VPS, not free PaaS tiers:** the schedulers (§3.4) need an always-on process. Free tiers sleep on idle - cron silently stops firing, and the first request after sleep cold-starts for ~30-60s, which is exactly what you don't want mid-demo.
- **Why one origin:** the SPA and `/api` share a domain, so the refresh cookie is first-party (§4.4). No `SameSite=None`, no CORS credential dance.
- **Ops you own (and can showcase):** Docker Compose for api + Postgres, Caddy auto-TLS, nightly `pg_dump` copied off the box, ssh-key-only login + firewall + unattended upgrades.
- **Photos live off-box:** Cloudflare R2 (prod) / Garage (dev) — see §3.6. Zero egress keeps serving free, and the tiny VPS disk + backup stay lean.
- **Documented fallback (free, weaker):** SPA on Vercel/Netlify + api on Railway/Render + db on Neon - zero cost, but sleeping cron and cross-origin cookies.

---

## 8. Boss-fight → where it lives
| Boss fight | Module | Layer |
|---|---|---|
| #1 Race condition / double-booking | `booking` | service TXN + DB exclusion constraint + sweeper cron |
| #2 Availability interval logic | `booking` | service (daterange math) |
| #3 iCal sync reliability | `channel-sync` | scheduler + reconciliation |
| #4 Idempotent payment webhook | `payment` | controller + `payment_event` |
| #5 Multi-tenant isolation | `common` + every module | guard + interceptor + RLS |

---

## 9. Open decisions
1. **ORM:** decided 2026-07-16 - Drizzle, replacing Prisma (#41; see CLAUDE.md ADR log). Exclusion constraint + RLS stay hand-written SQL in the migration.
2. **Routing lib:** decided 2026-07-16 - TanStack Router (typed routes, zod-validated search params; see CLAUDE.md ADR log).
3. **UI kit:** shadcn/ui-style (copy-in components) vs build from Tailwind primitives.
4. **Validation sharing:** zod schemas in `packages/shared` consumed by both sides (recommended).

---

## 10. What this architecture teaches you
| Choice | Transferable skill |
|---|---|
| FE/BE hard split | Separation of concerns; API design |
| `shared` contract package | Type-safe boundaries; single source of truth |
| Thin controller / fat service | Layered architecture discipline |
| Guard + interceptor + RLS | Auth & security modeling |
| NestJS scheduler | When *not* to use serverless |
| React Query over Redux | Right tool for server state; avoiding over-engineering |
| In-memory access + httpOnly refresh | Browser security / XSS-resistant auth |
| Tiered SEO answer | Pragmatic trade-off reasoning |
| Single-VPS deploy (Caddy + Compose) | Running a real box: TLS, reverse proxy, backups, hardening |
