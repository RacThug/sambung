/**
 * Property contract (FR-PROP-1/3, api-spec §4.3-4.4). Shared by api (validates
 * input at the boundary, derives the badges) and web (form validation + the
 * live "Verified" badge preview on the edit page).
 */
import { z } from "zod";

/**
 * Optional text field, clearable via PATCH: absent = leave alone, null = clear.
 * Empty/whitespace strings normalize to null so a cleared form input and an
 * explicit null mean the same thing everywhere (and `verified` can't be
 * gamed with a blank license).
 */
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

/**
 * The Deposit percentage (ADR-0015, #52): share of a booking's total collected
 * online at checkout. 1-100 integer percent, default 100 (pay in full). Mirrored
 * by the `property_deposit_pct_range` DB CHECK. 0 is excluded on purpose - "pay
 * nothing to book" is not this pay-to-confirm funnel.
 */
export const DEFAULT_DEPOSIT_PCT = 100;
export const depositPctSchema = z.number().int().min(1).max(100);

export const createPropertyRequestSchema = z.object({
  name: z.string().trim().min(2).max(160),
  address: clearableText(400).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  description: clearableText(5000).optional(),
  /** NIB / KBLI 55193 - presence drives the "Verified" badge (FR-PROP-3). */
  licenseNo: clearableText(120).optional(),
  /** Deposit % (api #10). Optional at create; the DB defaults it to 100. */
  depositPct: depositPctSchema.optional(),
});
export type CreatePropertyRequest = z.infer<typeof createPropertyRequestSchema>;

/** PATCH body: every field optional; `name`, when present, cannot be null. */
export const updatePropertyRequestSchema = createPropertyRequestSchema.partial();
export type UpdatePropertyRequest = z.infer<typeof updatePropertyRequestSchema>;

export const propertyResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  /**
   * The public address (`/p/:slug`). Read-only: it is minted at create and
   * never moves, so it appears here and in NO request schema - a rename must
   * not break links already in the wild (ADR-0004). The owner sees it so the
   * edit page can show, and link to, the real public URL.
   */
  slug: z.string(),
  address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  description: z.string().nullable(),
  licenseNo: z.string().nullable(),
  /**
   * Deposit % collected online at checkout (ADR-0015, #52). Always present -
   * the column is NOT NULL default 100 - so the edit page reads a real number,
   * never a blank that means "100".
   */
  depositPct: depositPctSchema,
  /** Gallery, in order: storage key + public URL per photo (#39). */
  photos: z.array(z.object({ key: z.string(), url: z.string() })),
  /** Derived: license present (FR-PROP-3). Never stored - see isVerified. */
  verified: z.boolean(),
  /** Derived: public page can render complete (FR-PROP-1 AC) - see isPublishable. */
  publishable: z.boolean(),
  /**
   * When this Property was archived (retired), or null if active (ADR-0005, #84).
   * Owner-facing only: the PUBLIC payload never carries it - an archived Property
   * simply 404s (ADR-0006). Read-only, set by POST /properties/:id/archive.
   */
  archivedAt: z.string().nullable(), // ISO-8601 UTC or null
  createdAt: z.string(), // ISO-8601 UTC
});
export type PropertyResponse = z.infer<typeof propertyResponseSchema>;

/** FR-PROP-3: the badge is presence of the NIB license - nothing else. */
export function isVerified(licenseNo: string | null | undefined): boolean {
  return typeof licenseNo === "string" && licenseNo.trim().length > 0;
}

/**
 * FR-PROP-1 AC / api-spec §4.3: publishable when the public page can render
 * "complete" - at least one photo AND at least one unit with a real price.
 * A zero-rupiah unit is a placeholder, not a sellable listing, so it does not
 * count as "priced".
 */
export function isPublishable(counts: {
  photoCount: number;
  pricedUnitCount: number;
}): boolean {
  return counts.photoCount >= 1 && counts.pricedUnitCount >= 1;
}
