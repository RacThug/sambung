/**
 * Availability quote contract (FR-CAL-1/2, api-spec §5.1, #47) - boss fight #2.
 *
 * The READ side of the calendar: given a Unit and a half-open window, is the stay
 * free, what does it cost, and if not, why. Shared by api (validates the query,
 * builds the response) and web (the /p/:slug picker consumes it).
 *
 * Availability is DERIVED from occupying booking rows, never stored (invariant
 * #3). This file holds the wire types plus the pure interval primitives - nights,
 * price, min-stay, range coalescing - so the half-open semantics (db-design §4.2)
 * are unit-tested in isolation, while the overlap DETECTION itself lives in SQL
 * beside the exclusion constraint (api-spec §5.1), because the read must share the
 * write's definition of "overlap" by construction, not by a parallel copy.
 */
import { z } from "zod";
import { rupiahSchema } from "./money";
import { strictObject } from "./strict";

/**
 * The longest window the quote will price, in nights (api-spec §5.1). A guard
 * against an absurd range scan on a no-auth route, not a booking horizon.
 */
export const MAX_AVAILABILITY_NIGHTS = 366;

const MS_PER_NIGHT = 86_400_000;

/**
 * Nights between two YYYY-MM-DD dates, half-open: `countNights('2026-08-10',
 * '2026-08-14') === 4`. The check-out day is not a night (db-design §4.2, the
 * Changeover rule).
 *
 * Parsed at UTC midnight so a DST boundary never adds or drops an hour and rounds
 * the division wrong - these are calendar dates, not instants. Callers validate
 * the format first (availabilityQuerySchema / z.string().date()); given garbage
 * this returns NaN rather than lying.
 */
export function countNights(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / MS_PER_NIGHT);
}

/**
 * The v1 pricing rule, in one place: base price x nights (no seasonal rates - PRD
 * non-goal). Bigint throughout - the DB hands us a bigint and the product can
 * exceed a safe JS number before it is range-checked in `toRupiah` at the
 * boundary. #47's quote and #48's booking both price through here, so a future
 * seasonal model changes one function.
 */
export function quoteTotalIdr(basePriceIdr: bigint, nights: number): bigint {
  return basePriceIdr * BigInt(nights);
}

/** True when a stay of `nights` satisfies the unit's minimum (api-spec §5.1). */
export function meetsMinStay(nights: number, minStay: number): boolean {
  return nights >= minStay;
}

/** Why a stay is not bookable. Machine-readable slugs only; the SPA renders the
 * copy from the slug + minStay/blockedRanges (api-spec §5.1). */
export const availabilityReasonSchema = z.enum(["overlap", "min_stay"]);
export type AvailabilityReason = z.infer<typeof availabilityReasonSchema>;

/** A half-open `[from, to)` span of unavailable nights, clipped to the queried
 * window and stripped of everything but the dates - no source, guest, id, or
 * status ever crosses to a Visitor (api-spec §5.1). */
export const blockedRangeSchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
});
export type BlockedRange = z.infer<typeof blockedRangeSchema>;

/**
 * Merge clipped occupying ranges into the minimal set of maximal half-open
 * intervals. Occupying bookings never overlap (the exclusion constraint forbids
 * it) but they can be CONTIGUOUS - one guest out, the next in, on the same day -
 * so `[10,13)` and `[13,16)` coalesce to `[10,16)`. Merging leaks strictly less:
 * a Visitor sees "these nights are unavailable", not the seam between two
 * separate bookings.
 *
 * Dates compare as strings: a validated YYYY-MM-DD sorts lexicographically
 * exactly as it does chronologically, so merging needs no parsing. Pure and
 * order-independent - the caller may hand ranges in any order.
 */
export function coalesceRanges(ranges: BlockedRange[]): BlockedRange[] {
  if (ranges.length <= 1) return ranges.map((r) => ({ ...r }));
  const sorted = [...ranges].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  );
  const merged: BlockedRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const next = sorted[i];
    // Touching or overlapping: next starts on or before last ends. Half-open, so
    // next.from === last.to (contiguous, the changeover day) still merges.
    if (next.from <= last.to) {
      if (next.to > last.to) last.to = next.to;
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

/**
 * Query params for `GET /public/units/:id/availability` (?from&to&lang). The unit
 * id is a path param (a UUID, validated by ParseUUIDPipe), so it is not here.
 *
 * `z.string().date()` validates a REAL calendar date - it rejects `2026-02-30`,
 * which a bare regex waves through and Postgres then rejects as 22008 (an unmapped
 * 500 on the no-auth route). `from < to` and the night cap are checked in the same
 * schema, so a bad window is one 400 with a machine-readable `path`. No past-date
 * check: the quote is a pure, stateless function of (unit, from, to); the picker
 * disables past dates in the UI.
 */
export const availabilityQuerySchema = strictObject({
  from: z.string().date(),
  to: z.string().date(),
  // Accepted for the public-endpoint i18n convention (api-spec §1) but unused
  // here: the response is language-neutral slugs + data, and the SPA localizes.
  lang: z.enum(["en", "id", "zh"]).optional(),
})
  .refine((q) => q.from < q.to, {
    message: "from must be before to",
    path: ["to"],
  })
  .refine((q) => countNights(q.from, q.to) <= MAX_AVAILABILITY_NIGHTS, {
    message: `window must be at most ${MAX_AVAILABILITY_NIGHTS} nights`,
    path: ["to"],
  });
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/**
 * The quote (api-spec §5.1). `available` is `blockedRanges` empty AND
 * `nights >= minStay`; because `blockedRanges` is unconditional (every occupying
 * booking clipped into the window), a non-empty one IS the `overlap` signal.
 * `totalPriceIdr` is always computed - a zero-priced placeholder quotes at 0.
 */
export const availabilityResponseSchema = z.object({
  available: z.boolean(),
  nights: z.number().int().positive(),
  totalPriceIdr: rupiahSchema,
  minStay: z.number().int().positive(),
  reasons: z.array(availabilityReasonSchema),
  blockedRanges: z.array(blockedRangeSchema),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
