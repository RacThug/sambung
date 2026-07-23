/**
 * One place for the values the e2e harness shares across the config, the
 * provisioner, the fixtures and the specs. Everything else imports from here so
 * a port or a demo login is written down exactly once.
 *
 * The database and credentials mirror docker-compose.yml. Those dev credentials
 * are intentionally public (the same story as the committed Postgres/Garage
 * keys, ADR 2026-07-16): they guard a disposable local container, nothing real.
 * Every value can still be overridden by an env var, so a machine with a
 * different Postgres host is one export away.
 */

/** The isolated database the whole suite runs against - never the dev `sambung`
 *  DB, so the destructive seed can never eat your demo data (Q4 / blueprint). */
export const E2E_DB_NAME = process.env.SAMBUNG_E2E_DB ?? "sambung_e2e";

const PG_HOST = process.env.SAMBUNG_E2E_PG_HOST ?? "localhost";
const PG_PORT = process.env.SAMBUNG_E2E_PG_PORT ?? "5432";

/** Owner (superuser) role - runs DDL, bypasses RLS. Used to CREATE DATABASE,
 *  migrate, and seed, and by the API for system ops. */
const OWNER_USER = process.env.SAMBUNG_E2E_OWNER_USER ?? "sambung";
const OWNER_PASSWORD = process.env.SAMBUNG_E2E_OWNER_PASSWORD ?? "sambung";
/** Non-owner app role - RLS enforced. What the API's tenant-scoped queries use. */
const APP_USER = process.env.SAMBUNG_E2E_APP_USER ?? "sambung_app";
const APP_PASSWORD = process.env.SAMBUNG_E2E_APP_PASSWORD ?? "sambung_app";

const base = (user: string, password: string, db: string) =>
  `postgresql://${user}:${password}@${PG_HOST}:${PG_PORT}/${db}`;

/** Connect here to run `CREATE DATABASE sambung_e2e` - you cannot connect to a
 *  database that does not exist yet, so point at the always-present dev DB. */
export const ADMIN_DATABASE_URL =
  process.env.SAMBUNG_E2E_ADMIN_URL ?? base(OWNER_USER, OWNER_PASSWORD, "sambung");

/** The two connection strings the API is started with (via webServer.env), so
 *  every statement it runs lands in `sambung_e2e`, not `sambung`. */
export const OWNER_DATABASE_URL = base(OWNER_USER, OWNER_PASSWORD, E2E_DB_NAME);
export const APP_DATABASE_URL = base(APP_USER, APP_PASSWORD, E2E_DB_NAME);

/** The app under test. baseURL is the single knob (blueprint Q3): point it at a
 *  built preview or the Caddy edge later without touching a spec. */
export const WEB_BASE_URL = process.env.SAMBUNG_E2E_WEB_URL ?? "http://localhost:5173";
export const API_PORT = process.env.SAMBUNG_E2E_API_PORT ?? "3000";

/** Object storage (Garage) S3 endpoint. Probed up front by the provisioner: the
 *  seed uploads demo photos, so a down Garage must fail fast, not mid-seed. */
export const STORAGE_ENDPOINT =
  process.env.SAMBUNG_E2E_STORAGE_ENDPOINT ?? "http://localhost:3900";

/**
 * The API readiness URL Playwright polls before running tests - the app's own
 * health route, a cheap 200 that means "the API is listening". The DB is already
 * provisioned by the time the servers start (provision-db.ts runs first), so the
 * tests' first DB-backed calls are safe.
 */
export const API_READY_URL = `http://localhost:${API_PORT}/api/health`;

/** A stable, seeded property slug (packages/db/scripts/seed.ts mints it literally
 *  so demo links survive re-seeding). Journey 1's entry point. */
export const SEMINYAK_SLUG = "seminyak-beach-villa";

/**
 * Demo logins from the seed. Mirrored here with a pointer rather than imported,
 * because the seed script does not export them; if these ever drift, the auth
 * setup fails loudly on the assert-authed guard. Password is intentionally
 * public (dev/demo only). Source of truth: packages/db/scripts/seed.ts.
 */
export const OWNER_EMAIL = "owner@balibreeze.test";
export const STAFF_EMAIL = "staff@balibreeze.test";
export const DEMO_PASSWORD = "sambung123";

/** Where each role's signed-in state (the refresh cookie) is saved by the setup
 *  project and reused by the dashboard project. Gitignored - it holds a real
 *  session cookie. */
export const AUTH_DIR = "playwright/.auth";
export const OWNER_STATE = `${AUTH_DIR}/owner.json`;
export const STAFF_STATE = `${AUTH_DIR}/staff.json`;
