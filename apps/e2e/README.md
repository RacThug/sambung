# `@sambung/e2e` - end-to-end tests

Playwright tests that drive the **whole stack** (web + api + db) through a real
browser, the way a guest or an owner does. This is the reusable foundation:
config, DB provisioning, auth-state, fixtures, and two reference journeys to copy.

> New test? Read **Conventions** below first - they are what keep the suite fast,
> deterministic, and isolated from your dev data.

---

## Run it

```bash
# 1. the local stack must be up (Postgres + Garage) - same as for pnpm test
docker compose up -d

# 2. one-time: install the browser binaries (not a postinstall, so people who
#    never run e2e don't download them). Chromium runs everything; WebKit runs
#    the Mobile-Safari funnel project.
pnpm --filter e2e exec playwright install chromium webkit

# 3. run (from the repo root). Turbo builds @sambung/shared + @sambung/db first.
pnpm test:e2e
```

Debugging:

```bash
pnpm --filter e2e test:e2e:ui       # Playwright UI mode (watch, time-travel)
pnpm --filter e2e test:e2e:report   # open the HTML report of the last run
```

> **Stop `pnpm dev` first.** The suite starts its own web + api on ports 5173 /
> 3000 pointed at an isolated database. `reuseExistingServer` is deliberately
> off, so if a dev server is holding those ports the run fails loudly rather than
> silently testing your dev database. This is intentional (see
> `playwright.config.ts`).

`pnpm test:e2e` is **not** part of `pnpm test` and **not** in the pre-push hook -
it needs docker and a browser, so it is a deliberate, separate command.

### Run lanes in parallel (`SAMBUNG_E2E_LANE`)

A single run uses one database (`sambung_e2e`) and fixed ports (web 5173, api
3000), so two `pnpm test:e2e` on one machine would collide. One env var isolates
a whole stack:

```bash
SAMBUNG_E2E_LANE=1 pnpm test:e2e   # DB sambung_e2e_1, web 5174, api 3001
SAMBUNG_E2E_LANE=2 pnpm test:e2e   # DB sambung_e2e_2, web 5175, api 3002
```

`SAMBUNG_E2E_LANE=<n>` derives the database name (`sambung_e2e_<n>`) and offsets
both ports by `n`, wiring the web dev server's `/api` proxy at its own lane's api.
**Unset = the base lane = today's exact values**, so a single run is unchanged.
Every derived value still has an individual override (`SAMBUNG_E2E_DB`,
`SAMBUNG_E2E_API_PORT`, `SAMBUNG_E2E_WEB_PORT`, `SAMBUNG_E2E_WEB_URL`,
`SAMBUNG_E2E_API_PROXY_TARGET`). All of this lives in `setup/e2e-config.ts`.

> Object storage (Garage) is **shared** across lanes - it is not lane-scoped, and
> two things have to hold for that to be safe.
>
> **The objects.** The seed's photo keys are deterministic and per-tenant with
> identical bytes, each lane references only its own DB's keys, and the GC cron
> never runs in e2e. Two lanes seeding the same tenant just overwrite identical
> objects.
>
> **The bucket CORS.** A browser photo upload PUTs straight to Garage
> cross-origin, and a bucket's CORS policy is **global to the bucket** - one
> policy, shared by every lane. So the dev bootstrap (`STORAGE_BOOTSTRAP`)
> applies a policy that **allows any origin** (`AllowedOrigins: ["*"]`, `PUT`
> only): every API boot writes the same thing, so last-writer-wins has nothing to
> win and a lane never locks another lane out of its own uploads. It used to
> write `[WEB_ORIGIN]`, and whichever lane booted last silently 403'd the others'
> upload preflights (#182 - a lane no longer announces its origin at all). The
> presigned URL, not CORS, is what authorises the write, and this is a localhost
> dev bucket, so the widening costs nothing real here.
>
> It stays a **dev** policy by construction, not by deploy discipline: R2 rejects
> this call over the S3 API anyway (production CORS is set in the Cloudflare
> dashboard, `docs/r2-cutover.md`), and on the documented Garage-on-VPS fallback
> `validateEnv` refuses `STORAGE_BOOTSTRAP=true`. That refusal used to need
> `NODE_ENV=production`, which nothing in this repo sets; since **#193** it fires
> on any process that cannot prove it is a local sandbox - proof being that every
> browser-facing origin it declares (`WEB_BASE_URL`, `STORAGE_PUBLIC_BASE_URL`) is
> private, which is exactly what a lane declares and a *working* deployment
> cannot. (A deployment *can* declare private origins; it just has broken photos
> and a checkout that returns payers to `localhost`. That residue is stated in
> `deployment-env.ts` rather than papered over.)
>
> One consequence worth knowing before it surprises you: point `WEB_BASE_URL` at a
> **public** origin and the API refuses to boot until `STORAGE_BOOTSTRAP` is
> commented out. The tunnel pass in
> [`docs/og-verification.md`](../../docs/og-verification.md) is the one workflow
> that does this - and if a tunnel URL is left behind in `apps/api/.env`, the next
> `pnpm test:e2e` fails at API startup for that reason. Loud and correct, but it
> reads as a harness fault, and it is not. A LAN address (`192.168.x.x`) is
> private, so serving the funnel to a phone over wifi changes nothing.

---

## How it's wired

- **Database.** The suite runs against an isolated **`sambung_e2e`** database, so
  the destructive seed can never touch your dev `sambung` data.
  `setup/provision-db.ts` (run by the `test:e2e` script, before Playwright) creates
  it if missing, then runs the normal `db:reset` (migrate + role + seed) against
  it. It fails fast with an actionable message if Postgres isn't up.
- **App processes.** Playwright's `webServer` starts the API and web dev servers,
  pointing the API at `sambung_e2e` via `env`. `baseURL` (`http://localhost:5173`)
  is the single knob - aim the suite at a built preview or the Caddy edge later
  by changing only that.
- **Auth.** The `setup` project logs in once per role through the real `/login`
  UI and saves the session to `playwright/.auth/<role>.json` (the httpOnly refresh
  cookie; `ensureSession()` restores the session on load). Dashboard projects
  reuse it - no test re-logs in.
- **Browser matrix.** **Chromium desktop** (dashboard) + **Chromium mobile**
  (funnel) + **WebKit / Mobile Safari** (funnel read specs - real iOS guests,
  ADR-0007/0023). The funnel's one WRITE spec (checkout-payment) runs on Chromium
  only, so two engines never contend for the same nights.
- **Payments.** The api `webServer` sets `PAYMENT_GATEWAY=fake`, binding the
  deterministic, signature-free `FakePaymentGateway` (#167). So a spec can drive a
  booking to `confirmed` with **no outbound Midtrans call** and no real signature:
  create the hold → pay (returns a fake redirect, never real Snap) → simulate the
  provider callback by `POST /api/webhooks/payment/midtrans` with a `FakeWebhookBody`
  (`{ orderId, transactionId, transactionStatus, grossAmountIdr }`; `orderId` is the
  `payment.id`, which the fake echoes into the pay response's redirect URL). The seam
  is **off by default** and is refused in production by `validateEnv` - never drive
  the real Snap UI.

---

## Conventions (follow these in new tests)

- **Baseline vs per-test data.** The seed is a **read-only Baseline** (Seminyak's
  slug, the demo logins). Read/browse tests lean on it. A test that **writes**
  creates its **own** data - a fresh far-future booking, a `uniqueName()` guest -
  so tests are independent, and leftovers are harmless (the next run re-seeds).
  Never mutate Baseline rows - with **one** documented exception: the inbox flow
  (`tests/dashboard/inbox.spec.ts`) clears the two seeded inbox fixtures below,
  because neither can be produced through the UI at runtime. It is serial, and it
  touches nothing any other flow reads. Adding a second such flow needs the same
  written justification.
- **Parallel-safe writes need a unique (unit, date), not just a unique name.**
  The suite runs `fullyParallel`. A `uniqueName()` guest keeps a row *findable*,
  but two write-tests that pick the same unit + `futureIso(n)` would contend for
  the same nights and one would 409. So a new write-test must also claim a
  **unit + date-offset no other write-test uses**.
- **Never wait on the real network.** No spec may spend an assertion's budget on
  a resource we don't own - a DNS resolver, a third-party host. Their duration is
  set by how busy the machine is, so the suite passes alone and fails when two
  lanes run, which is how `retries: 0` starts lying. Outbound calls are stubbed
  (`page.route` for the payment handoff) or made structurally unnecessary: Flow 6
  connects a **private-LAN** iCal URL, which the SSRF guard refuses before opening
  a socket, reaching the same `error`-status branch with no lookup at all. It used
  to use `example.invalid` and waited on NXDOMAIN - 96ms when idle, but the
  smoke-fetch's full 8s ceiling once the machine was busy enough to queue
  `getaddrinfo` (#194).

  This is about budgets that **depend on host speed**, not about elapsed time as
  such. A fixed delay you inject into something you control is fine and sometimes
  necessary: `auth-session.spec.ts` holds a **mocked** `/api/properties` route
  open for 3s on purpose, because the window it needs to observe (cache RESET vs
  merely invalidated, ADR-0034) is otherwise too short to see. That delay is the
  same 3s on any machine. A DNS resolver's is not.

  **Known cost, and why it is structural.** Flow 6 was the only place in the repo
  where `HttpIcalFetcher` issued a real outbound `fetch`; after #194 nothing does,
  so undici-level realities (`redirect: 'manual'` semantics, `AbortSignal.timeout`)
  are asserted only against mocks in `ical-fetcher.spec.ts`. Do **not** "restore"
  that coverage by poking a hole in the guard - the AC of #194 forbids it, and it
  cannot work anyway: a test-controlled HTTP server must live on loopback, which
  the guard blocks *by design* (ADR-0016). Real-outbound coverage is therefore
  impossible in-repo without weakening the thing it would be testing around. The
  old coverage was an accident of picking a public-shaped hostname, not a design.
- **Locators: accessibility-first.** Prefer `getByRole` / `getByLabel` /
  `getByText` over CSS or `data-testid` - they assert what the user perceives and
  survive refactors. Reach for `data-testid` only when semantics are genuinely
  ambiguous.
- **The funnel is locale-pinned to EN.** `fixtures/test.ts` pins `sambung.lang=en`
  so English text locators are deterministic. Import `test`/`expect` from
  `fixtures/test.ts`, **not** from `@playwright/test`. Test i18n on purpose in a
  dedicated spec, don't let locale leak into unrelated funnel tests.
- **Drive URL-state pages via the URL.** Pages whose state lives in typed search
  params (the availability picker's `?unit&from&to`, the calendar's `?from&to`)
  are most robustly driven by navigating the URL - it's how the app itself treats
  them, and it sidesteps calendar-geometry flakiness.
- **Far-future dates for writes.** The seed packs stays into `[today+1, today+8)`.
  `futureIso(30+)` is guaranteed free on every unit, which is what keeps write
  journeys deterministic without reading seed rows.

### Seed fixtures the flows read (#167)

Two Baseline fixtures exist because a flow can't create them at runtime through
the UI. Both are re-seeded on every run, so a flow that consumes/mutates one is
clean on the next run.

- **A known-token staff invite** on Bali Breeze, scoped to Seminyak, addressed to
  an email with **no account** (so `/invite/<token>` drives the create-account
  accept path). The raw token is `KNOWN_INVITE_TOKEN` in `setup/e2e-config.ts`
  (mirrored from the seed, which stores its sha256); build the URL from it. The
  invite is single-use - one accept scenario per run.
- **A paid-but-lapsed payment** on Bali Breeze: a `paid` payment on an `expired`
  booking with `handled_at` NULL - the `/app/inbox` item Flow 7 handles.

Flow 7 also clears the **open `sync_conflict`** the demo seed has carried since
#38 - a refused Airbnb import on the Whole Villa, shaped as a deliberately
**partial** overlap with Wayan D.'s direct booking so the inbox has to show both
ranges rather than conflate them.

Those three are the **only** seeded rows any flow **mutates**: Flow 5 spends the
invite, and Flow 7 clears the two inbox items (`payment.handled_at`,
`sync_conflict.status`). No other flow reads those columns, and the next run's
re-seed restores all three.

---

## Layout

```
setup/
  e2e-config.ts     URLs, DB names, demo logins - written down once
  provision-db.ts   create + migrate + seed sambung_e2e (runs before Playwright)
fixtures/
  test.ts           the EN-locale-pinned `test`/`expect` every spec imports
  auth.setup.ts     the setup project: log in per role -> storageState
lib/
  helpers.ts        futureIso(), uniqueName()
tests/
  funnel/           availability -> checkout · i18n (the switch re-renders)
                    i18n-persistence (the choice survives a document load)
                    checkout-payment (stubbed handoff) · guest-booking (Flow 1:
                    book -> pay -> confirmed, incl. the localized 409)
  dashboard/        manual-booking (owner walk-in) · staff-scope (RBAC)
                    property-onboarding (Flow 2: register -> photo -> publishable)
                    calendar-booking-ops (Flow 3: walk-in / block / cancel / 409)
                    reservations (Flow 4: URL filters + CSV export)
                    staff-invite-scope (Flow 5: invite -> accept -> 404-not-403)
                    channel-lifecycle (Flow 6: connect / export .ics / disconnect)
                    inbox (Flow 7: dismiss / handle, serial)
                    auth-session (Flow 8: guard, refresh, logout, workspace switch)
playwright.config.ts
```

`@sambung/shared` and `@sambung/db` are declared as dependencies so
`turbo --filter=e2e` **builds** them before the app-under-test starts (the API
imports both; the web imports `@sambung/shared`). Specs may also import
`@sambung/shared` contract types/codes when they assert them.

---

## Non-goals (documented, with extension points)

These are deliberately **not** built here; each has a named way in:

- **The confirmation / reconcile flow.** `checkout-payment.spec.ts` covers the
  handoff up to the provider (stubbed at `page.route`). The full `/booking/:id`
  reconcile-to-`confirmed` journey is now **unblocked** by the `PAYMENT_GATEWAY=fake`
  seam (#167, see *Payments* above) and belongs to Flow 1 (#168) - still never
  drive the real Snap UI.
- **Firefox, and WebKit on the dashboard.** WebKit already covers the funnel; add
  more projects in `playwright.config.ts` if desktop-Safari coverage is wanted.
- **Prod-build / edge target.** Point `baseURL` at `vite preview` or the
  `--profile edge` Caddy origin.
- **Per-test reseed.** Not needed - per-test data ownership keeps tests isolated
  without it.
