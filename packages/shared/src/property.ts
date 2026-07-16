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

export const createPropertyRequestSchema = z.object({
  name: z.string().trim().min(2).max(160),
  address: clearableText(400).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  description: clearableText(5000).optional(),
  /** NIB / KBLI 55193 - presence drives the "Verified" badge (FR-PROP-3). */
  licenseNo: clearableText(120).optional(),
});
export type CreatePropertyRequest = z.infer<typeof createPropertyRequestSchema>;

/** PATCH body: every field optional; `name`, when present, cannot be null. */
export const updatePropertyRequestSchema = createPropertyRequestSchema.partial();
export type UpdatePropertyRequest = z.infer<typeof updatePropertyRequestSchema>;

export const propertyResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string(),
  address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  description: z.string().nullable(),
  licenseNo: z.string().nullable(),
  /** Gallery, in order: storage key + public URL per photo (#39). */
  photos: z.array(z.object({ key: z.string(), url: z.string() })),
  /** Derived: license present (FR-PROP-3). Never stored - see isVerified. */
  verified: z.boolean(),
  /** Derived: public page can render complete (FR-PROP-1 AC) - see isPublishable. */
  publishable: z.boolean(),
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
