/**
 * Tenant settings contract (#67, ADR-0030).
 *
 * One resource for the knobs that belong to the tenant rather than to a
 * Property: today just the Gallery cap. `GET /settings` is readable by any
 * authenticated user (the property workbench needs the cap to know when a
 * gallery is full); `PATCH /settings` is owner-only.
 */
import { z } from "zod";

import { PHOTO_GALLERY_CEILING } from "./photo";
import { strictObject } from "./strict";

/**
 * How many photos one Property's Gallery may hold, for this tenant. A
 * PREFERENCE bounded by PHOTO_GALLERY_CEILING - the ceiling is the guard, this
 * is the tenant's own line inside it. Minimum 1, because a Property needs at
 * least one photo to be publishable; 0 would make the gallery a dead end.
 *
 * Mirrored by the `tenant_gallery_cap_range` CHECK on `tenant.gallery_cap`.
 */
export const galleryCapSchema = z
  .number()
  .int()
  .min(1)
  .max(PHOTO_GALLERY_CEILING);

export const tenantSettingsResponseSchema = z.object({
  galleryCap: galleryCapSchema,
  /**
   * Echoed so the SPA renders the bound it is validating against without
   * pinning a copy of the constant into its own copy - the ceiling can move in
   * a deploy the browser's cached bundle predates.
   */
  galleryCeiling: z.number().int().positive(),
});
export type TenantSettingsResponse = z.infer<typeof tenantSettingsResponseSchema>;

/**
 * Partial by design: one field today, more when #57 lands Team settings.
 * Strict (ADR-0031): `{galleryCapp: 60}` is a 400, not a silent no-op.
 */
export const updateTenantSettingsRequestSchema = strictObject({
  galleryCap: galleryCapSchema,
}).partial();
export type UpdateTenantSettingsRequest = z.infer<
  typeof updateTenantSettingsRequestSchema
>;
