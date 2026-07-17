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

export const createUnitRequestSchema = z.object({
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
   */
  basePriceIdr: rupiahSchema,
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
