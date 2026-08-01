/**
 * Unit contract (FR-PROP-2, api-spec §4.6). Shared by api (validates input at
 * the boundary) and web (the inline units table on the property edit page).
 *
 * A Unit is ONE sellable thing, not a room type with a count (ADR-0001): three
 * identical garden rooms are three Units. There is no `quantity` here and there
 * will not be one - the `booking_no_overlap` exclusion constraint can only say
 * "this unit is taken on these nights", and counting overlaps against a quantity
 * instead is the read-then-write race boss fight #1 exists to prevent.
 */
import { z } from "zod";
import { rupiahSchema } from "./money";
import { strictObject } from "./strict";

/**
 * The ceiling on a nightly rate. NOT a JS-representability bound like
 * rupiahSchema's MAX_SAFE_INTEGER - a DOMAIN bound: no real Bali accommodation
 * costs a billion rupiah a night (~USD 60k), so a value above it is a fat-finger
 * or an attack, not a price.
 *
 * It is also what keeps the availability quote safe. The quote computes
 * basePriceIdr x nights, up to MAX_AVAILABILITY_NIGHTS (366); with the price
 * bounded here the product tops out near 3.66e11, far under MAX_SAFE_INTEGER
 * (~9.007e15), so toRupiah can never overflow and 500 the no-auth endpoint.
 * Found in the #47 review: without this cap a write-accepted price x a long
 * window threw RangeError -> 500. Capping at the source makes the overflow
 * unrepresentable rather than something to catch downstream.
 */
export const MAX_NIGHTLY_RATE_IDR = 1_000_000_000;

export const createUnitRequestSchema = strictObject({
  /**
   * Unique within the property, enforced by `unit_property_name_uniq` - zod
   * can't check it, since it needs the other rows.
   *
   * min 1, unlike property's min 2: "A" and "1" are real room names, and
   * ADR-0001 makes numbering rooms the normal case rather than a quirk.
   */
  name: z.string().trim().min(1).max(160),
  /**
   * A zero price is deliberately storable (api-spec §4.6): it's a placeholder,
   * not an error. It just never counts toward `publishable`, so the property
   * stays unlisted until it's priced (§4.3).
   *
   * Capped at MAX_NIGHTLY_RATE_IDR - a domain ceiling that also keeps
   * basePriceIdr x nights from overflowing the availability quote (#47 review).
   * Mirrored by the `unit_base_price_max` DB CHECK: rejected twice over (#45).
   */
  basePriceIdr: rupiahSchema.refine((n) => n <= MAX_NIGHTLY_RATE_IDR, {
    message: `must be at most ${MAX_NIGHTLY_RATE_IDR}`,
  }),
  /**
   * The lower bounds mirror the DB CHECKs (`unit_max_guests_positive`,
   * `unit_min_stay_positive`) - that's the "rejected twice over" of #45.
   *
   * The upper bounds have no CHECK behind them; they exist so a typo can't
   * exceed int4 and land as 22003 (unmapped -> 500) instead of a 400 naming the
   * field. They're sanity, not domain law.
   */
  maxGuests: z.number().int().min(1).max(64).default(2),
  minStay: z.number().int().min(1).max(365).default(1),
});
export type CreateUnitRequest = z.infer<typeof createUnitRequestSchema>;

/**
 * PATCH body: every field optional. Every field is mutable, including price and
 * min-stay - neither is retroactive. A booking snapshots its own
 * `total_price_idr` at the moment it's made, and min-stay is a rule applied when
 * booking, so raising it never invalidates a stay already sold.
 *
 * `.partial()` wraps each field in ZodOptional, which short-circuits on
 * `undefined` BEFORE reaching the inner ZodDefault - so an absent `maxGuests`
 * stays absent rather than snapping back to 2 and silently overwriting the
 * stored value. Proven in unit.test.ts, because it's the kind of thing a zod
 * upgrade could quietly change.
 *
 * Strict (ADR-0031) is inherited through `.partial()` and composes with that
 * short-circuit: an unknown key is rejected, an omitted default still omitted.
 */
export const updateUnitRequestSchema = createUnitRequestSchema.partial();
export type UpdateUnitRequest = z.infer<typeof updateUnitRequestSchema>;

export const unitResponseSchema = z.object({
  id: z.string().uuid(),
  propertyId: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  basePriceIdr: rupiahSchema,
  maxGuests: z.number().int(),
  minStay: z.number().int(),
  /**
   * When this Unit was archived, or null if active (ADR-0005, #84). This is the
   * Unit's OWN flag; it can also be effectively archived by its Property, which
   * the dashboard composes client-side (Units render under their Property). The
   * public payload omits it. Read-only, set by POST /units/:id/archive.
   */
  archivedAt: z.string().nullable(), // ISO-8601 UTC or null
  /**
   * EFFECTIVE retirement: this Unit's own `archivedAt` OR its Property's
   * (ADR-0005). Derived server-side from the join the read already performs.
   *
   * Both fields are on the wire because they answer different questions.
   * `archivedAt` is the Unit's OWN flag - what archive/unarchive acts on, and what
   * decides whether the verb reads "Archive" or "Unarchive". `archived` is what
   * every consumer actually renders: a live Unit under a retired Property is
   * archived for every purpose a guest or a calendar cares about, and reading its
   * own null flag would say otherwise.
   *
   * This was the client's job until the page-spec migration counted the cost: one
   * rule, three feature files, six UI decisions, nothing checking the copies
   * agreed (MIGRATION-REPORT.md §3.A).
   */
  archived: z.boolean(),
  createdAt: z.string(), // ISO-8601 UTC
});
export type UnitResponse = z.infer<typeof unitResponseSchema>;

/**
 * api-spec §4.3: a unit counts toward its property's `publishable` only with a
 * real price. Shared with the web app so the units table can mark the offending
 * row rather than just showing a banner saying the property isn't ready.
 */
export function isSellable(unit: { basePriceIdr: number }): boolean {
  return unit.basePriceIdr > 0;
}

/**
 * A Unit or Property is archived when its own `archivedAt` is set (ADR-0005, #84).
 * Symmetric with `isVerified` / `isSellable`, and a DIFFERENT axis from both:
 * "archived" is retirement, "sellable" is pricing. This reads the entity's OWN
 * flag only - effective-archived also considers the parent Property, which the
 * dashboard composes client-side since Units render under their Property.
 */
export function isArchived(entity: { archivedAt: string | null }): boolean {
  return entity.archivedAt !== null;
}
