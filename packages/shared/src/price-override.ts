/**
 * Price-override contract (PRD-product P0-2, the date-based pricing slice).
 * Shared by api (validates the body at the boundary, frames the response) and
 * web (the per-Unit Prices panel on the property workbench).
 *
 * An override is a dated price layered over the Unit's `basePriceIdr`: a night
 * inside `[from, to)` costs `nightlyPriceIdr`, every other night costs the base.
 * Overrides on one Unit never overlap - the `price_override_no_overlap`
 * exclusion constraint is the authority (the `booking_no_overlap` pattern), so
 * "which override covers this night" always has exactly one answer, and the
 * quote never has to break a tie.
 *
 * The range is half-open `[from, to)` like every range in the system (db-design
 * §4.2): `to` is the first night NOT covered. The dashboard renders it as
 * "First night / Last night" through `lastNightOf` - one shared helper, not a
 * second copy of the half-open rule.
 */
import { z } from "zod";
import { rupiahSchema } from "./money";
import { strictObject } from "./strict";
import { MAX_NIGHTLY_RATE_IDR } from "./unit";

/**
 * Body of `POST /units/:unitId/price-overrides`. The unit id is in the PATH; the
 * tenant is the caller's own (owner RLS connection, Staff allowed for assigned
 * Units - pricing an assigned Unit is operating it, like the `basePriceIdr` edit
 * Staff already have).
 *
 * `z.string().date()` validates a REAL calendar date (rejects 2026-02-30) for
 * the same reason availabilityQuerySchema does: a bare regex waves it through
 * and Postgres then rejects as 22008, an unmapped 500.
 *
 * The price must be at least 1, unlike `basePriceIdr` where zero is a
 * deliberate placeholder that gates `publishable` (api-spec §4.3). A zero
 * OVERRIDE serves no such purpose: `isSellable` reads only the base, so it
 * would make already-sellable nights silently free - a fat-finger, not a promo
 * mechanism. The ceiling is the SAME `MAX_NIGHTLY_RATE_IDR` as the base
 * (mirrored by the `price_override_nightly_range` DB CHECK - rejected twice
 * over, #45's pattern), which is what keeps the #47 overflow argument intact:
 * every night of a stay, overridden or not, is bounded by one constant, so a
 * 366-night quote still tops out near 3.66e11, far under MAX_SAFE_INTEGER.
 *
 * `from < to` only - deliberately NO range-length cap. MAX_AVAILABILITY_NIGHTS
 * bounds the QUOTE window because that is a per-request scan on a no-auth
 * route; an override is one authed row whatever its length, and "price the
 * whole of next year" is a legitimate thing for an owner to say.
 *
 * Strict (ADR-0031); `.refine()` preserves strict, proven in strict.test.ts.
 */
export const createPriceOverrideRequestSchema = strictObject({
  from: z.string().date(),
  to: z.string().date(),
  nightlyPriceIdr: rupiahSchema
    .refine((n) => n >= 1, { message: "must be at least 1" })
    .refine((n) => n <= MAX_NIGHTLY_RATE_IDR, {
      message: `must be at most ${MAX_NIGHTLY_RATE_IDR}`,
    }),
}).refine((r) => r.from < r.to, {
  message: "from must be before to",
  path: ["to"],
});
export type CreatePriceOverrideRequest = z.infer<
  typeof createPriceOverrideRequestSchema
>;

/**
 * One override as the owner sees it (`GET /units/:unitId/price-overrides`,
 * sorted by `from`). No `tenantId`: like a channel connection, the row is
 * reached through its Unit and the panel never needs it.
 */
export const priceOverrideResponseSchema = z.object({
  id: z.string().uuid(),
  unitId: z.string().uuid(),
  from: z.string().date(),
  to: z.string().date(),
  nightlyPriceIdr: rupiahSchema,
  createdAt: z.string(), // ISO-8601 UTC
});
export type PriceOverrideResponse = z.infer<typeof priceOverrideResponseSchema>;
