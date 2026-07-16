/**
 * Drop everything and replay all migrations from scratch. Dev only.
 *
 *   pnpm --filter @sambung/db db:reset   (chains role setup + seed afterwards)
 *
 * Drops BOTH schemas: `public` (the data) and `drizzle` (the migration
 * journal), so the replay is a true from-zero validation of ./drizzle.
 */
import "./load-env";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { createDb } from "../src/index";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema if exists public cascade");
    await client.query("create schema public");
    await client.query("drop schema if exists drizzle cascade");
  } finally {
    await client.end();
  }

  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await close();
  }
  console.log("Schema dropped and all migrations replayed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
