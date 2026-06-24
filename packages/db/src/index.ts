/**
 * @sambung/db — Prisma schema, migrations, and client.
 *
 * Imported ONLY by `apps/api`, never by `apps/web` (CLAUDE.md invariant #1).
 *
 * Placeholder until M0 #3 (Prisma schema + GiST exclusion constraint migration),
 * which adds `prisma` / `@prisma/client` deps, the real schema in
 * `prisma/schema.prisma`, and exports a configured PrismaClient from here.
 */
export const DB_PACKAGE = "@sambung/db" as const;
