/**
 * @sambung/db — Prisma client + schema.
 *
 * Imported ONLY by `apps/api`, never by `apps/web` (CLAUDE.md invariant #1).
 * Run `pnpm --filter @sambung/db db:generate` after changing the schema.
 */
import { PrismaClient } from "@prisma/client";

// Re-export generated types + enums (BookingStatus, BookingSource, ...) so the
// API imports them from one place.
export * from "@prisma/client";

// A single shared client instance for the API process.
export const prisma = new PrismaClient();
