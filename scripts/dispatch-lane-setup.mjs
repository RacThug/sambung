#!/usr/bin/env node
/**
 * dispatch-lane-setup - give ONE parallel dispatch lane its own database.
 *
 * A treehouse worktree isolates FILES but not the shared Docker Postgres, so two
 * lanes running db/api tests at once would stomp each other's rows. This carves
 * each lane its own database inside the one Postgres container (cheap: no second
 * container, no port juggling) and writes the worktree's gitignored .env files so
 * every package resolves DATABASE_URL to that database.
 *
 * Separate DATABASE - not schema, not container: the exclusion constraint + RLS
 * are written against the `public` schema (a per-schema split would fight the
 * migrations), and a second Postgres container is heavier than local test
 * isolation needs. One Postgres, one database per lane.
 *
 * Idempotent - safe to re-run for a recycled worktree.
 *
 * Usage:
 *   node scripts/dispatch-lane-setup.mjs <lane-db> <worktree-path> [--seed]
 *   e.g. node scripts/dispatch-lane-setup.mjs sambung_wt1 "C:\\Users\\me\\.treehouse\\...\\sambung"
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , laneDb, worktree, ...rest] = process.argv;
const withSeed = rest.includes("--seed");

if (!laneDb || !worktree) {
  console.error(
    "usage: node scripts/dispatch-lane-setup.mjs <lane-db> <worktree-path> [--seed]",
  );
  process.exit(1);
}
// The lane db name is interpolated into SQL (CREATE DATABASE cannot be a bound
// parameter), so constrain it to a safe identifier - never pass user input raw.
if (!/^[a-z][a-z0-9_]{0,62}$/.test(laneDb)) {
  console.error(`invalid lane db name: ${laneDb} (want ^[a-z][a-z0-9_]*$)`);
  process.exit(1);
}

const CONTAINER = "sambung-db";
const OWNER = "sambung";

// 1) Create the lane database via the container's own psql (so no local pg client
//    is required). Idempotent: check pg_database first.
const psql = (db, sql) =>
  execFileSync(
    "docker",
    ["exec", CONTAINER, "psql", "-U", OWNER, "-d", db, "-tAc", sql],
    { encoding: "utf8" },
  ).trim();

if (psql("postgres", `SELECT 1 FROM pg_database WHERE datname='${laneDb}'`) === "1") {
  console.log(`db ${laneDb}: already exists`);
} else {
  psql("postgres", `CREATE DATABASE ${laneDb} OWNER ${OWNER}`);
  console.log(`db ${laneDb}: created`);
}

// 2) Write the worktree's .env files, rewriting only the database name in each
//    connection string (the segment after `@host:port/`, before `?`). .env is
//    gitignored, so a fresh worktree has none - derive each from its .env.example.
const toLaneDb = (s) => s.replace(/(@[^/\s]+\/)sambung(\?)/g, `$1${laneDb}$2`);
for (const dir of [".", "packages/db", "apps/api"]) {
  const src = readFileSync(join(worktree, dir, ".env.example"), "utf8");
  writeFileSync(join(worktree, dir, ".env"), toLaneDb(src));
  console.log(`.env: ${dir}/.env -> ${laneDb}`);
}

// 3) Migrate the lane db and grant the app role on it (+ optional seed), so both
//    the owner-role constraint tests and the sambung_app RLS tests pass. Each
//    script reads the worktree's freshly-written packages/db/.env.
const run = (script) =>
  execSync(`pnpm --filter @sambung/db run ${script}`, {
    cwd: worktree,
    stdio: "inherit",
    shell: true,
  });
run("db:migrate");
run("db:setup-role");
if (withSeed) run("db:seed");

console.log(`\nlane ready: ${laneDb} @ ${worktree}`);
