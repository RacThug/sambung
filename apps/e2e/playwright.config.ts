import { defineConfig, devices } from "@playwright/test";
import {
  API_PORT,
  API_PROXY_TARGET,
  API_READY_URL,
  APP_DATABASE_URL,
  OWNER_DATABASE_URL,
  OWNER_STATE,
  WEB_BASE_URL,
  WEB_PORT,
} from "./setup/e2e-config";

/**
 * Sambung e2e config. Drives the whole stack (web + api + db) through a browser.
 * Read apps/e2e/README.md first - it explains the conventions these projects
 * assume (Baseline vs per-test data, the locale pin, the auth-state pattern).
 *
 * The database is provisioned by `setup/provision-db.ts`, which the `test:e2e`
 * script runs BEFORE this config launches the servers (see that file for why).
 */
export default defineConfig({
  // Every write-test owns its own data (a fresh far-future booking, a unique
  // guest name), so tests never collide - parallelism is free correctness.
  fullyParallel: true,

  // retries: 0 on purpose. There is no CI to absorb a retry, and the house
  // standard is that flakiness fails loudly rather than being laundered green.
  // If a dev-server warm-up flake ever appears, fix the wait, don't add a retry.
  retries: 0,

  reporter: [["html", { open: "never" }], ["list"]],

  use: {
    baseURL: WEB_BASE_URL,
    // A full time-travel trace + screenshot + video, but only when a test FAILS
    // (traces are heavy; nothing is kept on green). One click into the trace
    // viewer replays the DOM, network and console at every step.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Generous but bounded: a Vite dev server transforms a route's chunk on its
    // first hit (ADR-0023's cold-transform), so the first navigation to a page
    // is slower than steady state. High enough to absorb that, low enough that a
    // genuine hang still fails.
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  expect: { timeout: 10_000 },

  projects: [
    // Auth-state setup: log in once per role via the real /login form and save
    // the session (the refresh cookie) to storageState. Dashboard tests depend
    // on this and start already signed in (blueprint Q5).
    {
      name: "setup",
      testMatch: /fixtures\/auth\.setup\.ts/,
    },

    // The public funnel, on a phone (the product's primary audience,
    // ADR-0007/0023). No auth. Locale is pinned to EN by the fixture. Runs every
    // funnel spec, including the write one (checkout-payment).
    {
      name: "funnel-mobile",
      testMatch: /tests\/funnel\/.*\.spec\.ts/,
      use: { ...devices["Pixel 5"] },
    },

    // The same funnel on Mobile Safari / WebKit - real iOS guests (the README's
    // first expansion). Scoped to the READ specs only: the checkout-payment spec
    // WRITES a hold, and running the same write on two engines in parallel would
    // make both contend for the same nights (the unique-(unit, offset) rule). The
    // payment handoff is engine-agnostic, so chromium alone covers it.
    {
      name: "funnel-mobile-safari",
      testMatch: /tests\/funnel\/(availability|i18n)\.spec\.ts/,
      use: { ...devices["iPhone 13"] },
    },

    // Journey 2 - the owner dashboard, on desktop (where owners live in wide
    // data views, ADR-0037). Reuses the owner session; no re-login per test.
    {
      name: "dashboard-desktop",
      testMatch: /tests\/dashboard\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: OWNER_STATE },
      dependencies: ["setup"],
    },
  ],

  // Playwright owns the app processes; the DB is a provisioned prerequisite.
  //
  // reuseExistingServer is FALSE, deliberately deviating from the usual
  // `!process.env.CI`. With no CI, `!CI` would be `true` and Playwright would
  // reuse whatever is already on these ports - including a `pnpm dev` pointed at
  // the DEV database, silently running e2e against (and mutating) your demo
  // data. False means Playwright always starts its OWN api pointed at
  // sambung_e2e; if `pnpm dev` is running, the port clash fails LOUDLY, which is
  // the safe outcome. Stop `pnpm dev` before `pnpm test:e2e`.
  webServer: [
    {
      name: "api",
      command: "pnpm --filter api start",
      url: API_READY_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      // The DB connection strings + PORT are overridden; JWT secrets, STORAGE_*,
      // throttle limits etc. still come from apps/api/.env (loadEnvFile), and an
      // already-set env var wins over that file - so these point every API
      // statement at sambung_e2e. PORT is pinned to the same constant
      // API_READY_URL uses, so an apps/api/.env PORT can never diverge from the
      // readiness poll.
      //
      // PAYMENT_GATEWAY=fake binds the deterministic, signature-free
      // FakePaymentGateway (#167 part b), so a spec can drive a booking to
      // `confirmed` (fake webhook POST / reconcile-on-read) with no outbound
      // Midtrans call. `nest start` does not set NODE_ENV=production, so
      // validateEnv (which refuses `fake` only in prod) allows it here.
      //
      // WEB_ORIGIN is THIS lane's web origin. A browser photo upload (Flow 2,
      // #169) PUTs straight to Garage cross-origin, and the dev bootstrap
      // (STORAGE_BOOTSTRAP) applies the bucket's CORS for WEB_ORIGIN only. Left
      // at apps/api/.env's :5173, a non-base lane (web :517x) is refused the
      // preflight and every gallery upload fails - so derive it from the lane.
      // Base lane is unchanged (WEB_BASE_URL is http://localhost:5173).
      env: {
        ...process.env,
        DATABASE_URL: OWNER_DATABASE_URL,
        APP_DATABASE_URL: APP_DATABASE_URL,
        PORT: API_PORT,
        PAYMENT_GATEWAY: "fake",
        WEB_ORIGIN: WEB_BASE_URL,
      },
    },
    {
      name: "web",
      command: "pnpm --filter web dev",
      url: WEB_BASE_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      // Lane isolation (#167): tell Vite which port to serve on and where to
      // proxy /api, so this lane's browser hits its OWN api. Always explicit so a
      // lane is self-contained; vite.config falls back to 5173 / :3000 when
      // unset (a plain `pnpm dev`).
      env: {
        ...process.env,
        WEB_DEV_PORT: WEB_PORT,
        WEB_API_PROXY_TARGET: API_PROXY_TARGET,
      },
    },
  ],
});
