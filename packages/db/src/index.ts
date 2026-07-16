/**
 * @sambung/db - Drizzle client + schema.
 *
 * Imported ONLY by `apps/api`, never by `apps/web` (CLAUDE.md invariant #1).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export * from "./schema";

/**
 * Build a Drizzle client over a pg pool. The API creates two of these:
 * an owner connection (DATABASE_URL - system ops, bypasses RLS) and an
 * app-role connection (APP_DATABASE_URL - tenant-scoped, RLS enforced).
 */
export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
/** The transaction handle passed to `db.transaction(async (tx) => ...)`. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// A shared owner-connection instance for scripts and db tests. (The pg Pool
// connects lazily, so constructing it at import is harmless; load env first.)
const owner = createDb(process.env.DATABASE_URL ?? "");
export const db = owner.db;
export const closeDb = owner.close;

/**
 * Extract the Postgres error (code / constraint) from whatever the driver or
 * Drizzle threw - Drizzle may wrap the pg error, so walk the `cause` chain.
 */
export function pgError(
  err: unknown,
): { code?: string; constraint?: string; message?: string } | undefined {
  let cur: unknown = err;
  while (cur && typeof cur === "object") {
    const c = cur as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof c.code === "string") {
      return {
        code: c.code,
        constraint: typeof c.constraint === "string" ? c.constraint : undefined,
        message: typeof c.message === "string" ? c.message : undefined,
      };
    }
    cur = c.cause;
  }
  return undefined;
}

export const isUniqueViolation = (err: unknown): boolean =>
  pgError(err)?.code === "23505";
export const isExclusionViolation = (err: unknown): boolean =>
  pgError(err)?.code === "23P01";
export const isForeignKeyViolation = (err: unknown): boolean =>
  pgError(err)?.code === "23503";
