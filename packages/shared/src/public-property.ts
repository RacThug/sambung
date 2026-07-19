/**
 * The public property page payload (api-spec §4.7, page-spec §3.1, FR-PROP-1/3).
 *
 * This is the ONLY shape an unauthenticated Visitor ever sees of a Property, and
 * it is a deliberate subset - not PropertyResponse with a couple of fields
 * dropped. What is missing is the point:
 *
 *   licenseNo  - `verified` is the boolean it derives; the NIB value itself never
 *                crosses the boundary (FR-PROP-3, #46 AC). The repository returns
 *                a row that has never had the field, so nothing downstream can
 *                leak it even by accident.
 *   tenantId   - who owns this is not a Visitor's business.
 *   id         - no consumer. M2 books a UNIT, not a property.
 *   publishable- an Owner's readiness checklist, not a fact about the villa.
 *   createdAt  - tells a Visitor when the Owner joined. Nothing to do with a stay.
 *
 * Parsed on the way out (public-properties.service), so this schema is enforced
 * rather than merely documented: zod strips unknown keys, which means a future
 * spread of a raw row cannot quietly widen the payload.
 */
import { z } from "zod";
import { rupiahSchema } from "./money";
import { depositPctSchema } from "./property";

export const publicUnitSchema = z.object({
  /**
   * Kept despite M1 having no use for it: M2's `?unit` search param and
   * `GET /public/units/:id/availability` both address a unit by this id, so it
   * is public by construction. Omitting it would only churn the contract.
   */
  id: z.string().uuid(),
  name: z.string(),
  basePriceIdr: rupiahSchema,
  maxGuests: z.number().int(),
  minStay: z.number().int(),
});
export type PublicUnit = z.infer<typeof publicUnitSchema>;

export const publicPropertyResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  address: z.string().nullable(),
  description: z.string().nullable(),
  /** FR-PROP-3: license PRESENT. Never the license itself. */
  verified: z.boolean(),
  /**
   * Gallery order. `url` only - PropertyResponse's `key` is
   * `<tenantId>/<propertyId>/<uuid>.<ext>`, so publishing it would hand a
   * Visitor both UUIDs as a field.
   *
   * The URL still contains them, since it is STORAGE_PUBLIC_BASE_URL + the key,
   * and that is accepted rather than overlooked: the ids are identifiers, not
   * capabilities - no endpoint grants anything for knowing one. RLS scopes on a
   * GUC set from a verified JWT or a slug resolution, never from a value a
   * Visitor supplies. See api-spec §4.7.
   */
  photos: z.array(z.object({ url: z.string() })),
  /**
   * The Deposit % (ADR-0015): NOT PII and the guest sees it at payment anyway, so
   * the checkout can preview "deposit due now" before the redirect instead of the
   * guest meeting a smaller charge cold on the Provider page. A payment term, like
   * the unit price beside it.
   */
  depositPct: depositPctSchema,
  /**
   * May be empty, and an unpriced unit still appears. `publishable` does not
   * gate this endpoint (ADR-0004): a page renders whatever the Owner has, so
   * that deleting a photo can never silently 404 a link already in the wild.
   */
  units: z.array(publicUnitSchema),
});
export type PublicPropertyResponse = z.infer<
  typeof publicPropertyResponseSchema
>;
