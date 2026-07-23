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

# 2. one-time: install the browser binary (Chromium only; not a postinstall,
#    so people who never run e2e don't download it)
pnpm --filter e2e exec playwright install chromium

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

---

## Conventions (follow these in new tests)

- **Baseline vs per-test data.** The seed is a **read-only Baseline** (Seminyak's
  slug, the demo logins). Read/browse tests lean on it. A test that **writes**
  creates its **own** data - a fresh far-future booking, a `uniqueName()` guest -
  so tests are independent, and leftovers are harmless (the next run re-seeds).
  Never mutate Baseline rows.
- **Parallel-safe writes need a unique (unit, date), not just a unique name.**
  The suite runs `fullyParallel`. A `uniqueName()` guest keeps a row *findable*,
  but two write-tests that pick the same unit + `futureIso(n)` would contend for
  the same nights and one would 409. So a new write-test must also claim a
  **unit + date-offset no other write-test uses**.
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
  funnel/           availability -> checkout · i18n switch · checkout-payment (stubbed)
  dashboard/        manual-booking (owner walk-in) · staff-scope (RBAC)
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
  handoff up to the provider (stubbed at `page.route`); the `/booking/:id`
  reconcile page (which polls the real provider) is not driven. To cover it, add
  a `PAYMENT_GATEWAY=fake` env seam in the API - never drive the real Snap UI.
- **Firefox, and WebKit on the dashboard.** WebKit already covers the funnel; add
  more projects in `playwright.config.ts` if desktop-Safari coverage is wanted.
- **Prod-build / edge target.** Point `baseURL` at `vite preview` or the
  `--profile edge` Caddy origin.
- **Per-test reseed.** Not needed - per-test data ownership keeps tests isolated
  without it.
