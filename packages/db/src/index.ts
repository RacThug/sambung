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
 * The top-level message is only "Failed query: ...", so this is the only way to
 * reach the SQLSTATE or the constraint name.
 *
 * There used to be isUniqueViolation / isExclusionViolation /
 * isForeignKeyViolation sugar over this. All three are gone (#80): callers want
 * the constraint NAME, not the code. "23505" means "some unique thing already
 * exists", which is not an answer - `app_user_email_key` is. The one caller
 * that used a predicate now keys on the name instead, and the other two never
 * had a caller at all. Re-add sugar when something actually wants a code.
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
