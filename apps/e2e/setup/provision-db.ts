/**
 * Provision the isolated e2e database, BEFORE Playwright starts the app servers.
 *
 * Why here and not in Playwright's `globalSetup`: Playwright brings the
 * `webServer`s up FIRST and runs `globalSetup` after (verified against the
 * Playwright docs). The API's readiness URL is a seeded endpoint, so if the seed
 * ran in globalSetup it would race the very poll that waits for the API. Running
 * as a step chained ahead of `playwright test` (see package.json `test:e2e`)
 * removes the race: by the time the API boots, `sambung_e2e` is migrated + seeded.
 *
 * What it does, all against `sambung_e2e` (NEVER the dev `sambung` DB):
 *   1. verify Postgres is reachable        -> fail fast with an actionable message
 *   2. CREATE DATABASE sambung_e2e         -> if it does not exist yet
 *   3. db:reset (drop schema, migrate,     -> the exact dev flow, re-pointed by env
 *      role grants, seed)
 *   4. verify the seed landed              -> a clear error beats a mysterious 404
 *
 * The destructive `db:reset` is safe precisely because step 2 gives it its own
 * database; your `pnpm dev` data is untouched.
 */
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import {
  ADMIN_DATABASE_URL,
  APP_DATABASE_URL,
  E2E_DB_NAME,
  OWNER_DATABASE_URL,
  SEMINYAK_SLUG,
  STORAGE_ENDPOINT,
} from "./e2e-config";

function die(message: string): never {
  console.error(`\n[e2e] ${message}\n`);
  process.exit(1);
}

async function ensureDatabaseExists(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  try {
    await admin.connect();
  } catch (err) {
    const code = (err as { code?: string }).code;
    die(
      `Postgres is not reachable (${code ?? err}).\n` +
        `      Start the local stack first:  docker compose up -d`,
    );
  }
  try {
    const { rowCount } = await admin.query(
      "select 1 from pg_database where datname = $1",
      [E2E_DB_NAME],
    );
    if (rowCount === 0) {
      // CREATE DATABASE cannot be parameterised or run in a transaction; the
      // name is our own constant, not user input, so interpolation is safe.
      await admin.query(`create database "${E2E_DB_NAME}"`);
      console.log(`[e2e] created database ${E2E_DB_NAME}`);
    } else {
      console.log(`[e2e] database ${E2E_DB_NAME} already exists`);
    }
  } finally {
    await admin.end();
  }
}

async function ensureStorageReachable(): Promise<void> {
  // The seed uploads demo photos to Garage, so the whole docker stack - not just
  // Postgres - is the prerequisite. Probe it up front so a down object store
  // fails fast here, not late inside db:seed. A running Garage answers the S3
  // endpoint (with an error status, since we send no auth); fetch only THROWS on
  // a connection failure, which is exactly "the store is down".
  try {
    await fetch(STORAGE_ENDPOINT, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    const reason = (err as { code?: string }).code ?? (err as Error).name;
    die(
      `Object storage (Garage) is not reachable at ${STORAGE_ENDPOINT} (${reason}).\n` +
        `      Start the local stack first:  docker compose up -d`,
    );
  }
}

function resetSchemaAndSeed(): void {
  console.log(`[e2e] resetting + seeding ${E2E_DB_NAME} ...`);
  // Reuse the dev reset flow verbatim (reset -> setup-role -> seed) but re-point
  // it at the e2e database. Node's loadEnvFile (which each db script calls) does
  // NOT override an already-set env var, so these two win over packages/db/.env;
  // everything else (STORAGE_*, etc.) still comes from that file, so the seed's
  // photo upload to Garage works unchanged.
  // A single fixed command string (no separate args array) under `shell: true`,
  // so pnpm(.cmd) resolves on Windows and POSIX alike without tripping Node's
  // DEP0190 warning. The command is a constant - no interpolated input.
  const result = spawnSync("pnpm --filter @sambung/db db:reset", {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      DATABASE_URL: OWNER_DATABASE_URL,
      APP_DATABASE_URL: APP_DATABASE_URL,
    },
  });
  if (result.status !== 0) {
    die(
      `db:reset failed (exit ${result.status}). ` +
        `If it was a storage error, check Garage is up (docker compose up -d).`,
    );
  }
}

async function verifySeed(): Promise<void> {
  const db = new Client({ connectionString: OWNER_DATABASE_URL });
  await db.connect();
  try {
    const { rowCount } = await db.query(
      "select 1 from property where slug = $1",
      [SEMINYAK_SLUG],
    );
    if (rowCount === 0) {
      die(`seed verification failed: property "${SEMINYAK_SLUG}" not found.`);
    }
  } finally {
    await db.end();
  }
  console.log(`[e2e] ${E2E_DB_NAME} ready.`);
}

async function main(): Promise<void> {
  await ensureDatabaseExists();
  await ensureStorageReachable();
  resetSchemaAndSeed();
  await verifySeed();
}

main().catch((err) => die(String(err)));
