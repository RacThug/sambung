/**
 * Photo upload contract (FR-PROP-1, api-spec §4.5, issue #39).
 *
 * Flow: the SPA asks the API to presign an upload (validated here), PUTs the
 * bytes straight to S3-compatible storage, then persists the resulting keys
 * with `PATCH /properties/:id/photos` - a whole-set operation that also
 * expresses reorder and delete. The API never proxies photo bytes.
 */
import { z } from "zod";

/** Upload whitelist - enforced at presign time AND signed into the URL. */
export const photoContentTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export type PhotoContentType = z.infer<typeof photoContentTypeSchema>;

/** Extension per content type, used in generated object keys. */
export const PHOTO_EXTENSIONS: Record<PhotoContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const MAX_PHOTO_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * The system ceiling on a Gallery - the highest a tenant may raise its own cap
 * to (#67, ADR-0030). This is NOT a storage quota: property count is unbounded,
 * so it bounds one request body and one gallery grid, nothing more. The real
 * storage guards are MAX_PHOTO_SIZE_BYTES and the orphan sweeper (ADR-0017).
 *
 * Mirrored by the `tenant_gallery_cap_range` CHECK. Widening it is a migration
 * on purpose, like property_time_zone_known: it is a product decision.
 */
export const PHOTO_GALLERY_CEILING = 100;

/** What a new tenant's cap starts at - mirrored by the column default. */
export const DEFAULT_GALLERY_CAP = 30;

export const presignPhotoRequestSchema = z.object({
  contentType: photoContentTypeSchema,
  size: z.number().int().positive().max(MAX_PHOTO_SIZE_BYTES),
});
export type PresignPhotoRequest = z.infer<typeof presignPhotoRequestSchema>;

export const presignPhotoResponseSchema = z.object({
  /** Presigned PUT URL - upload the file here with the same Content-Type. */
  uploadUrl: z.string().url(),
  /** Object key (`<tenantId>/<propertyId>/<uuid>.<ext>`) to persist via PATCH. */
  key: z.string(),
  expiresInSeconds: z.number().int().positive(),
});
export type PresignPhotoResponse = z.infer<typeof presignPhotoResponseSchema>;

/**
 * Whole-set photo update: the array IS the gallery, in order. Append, reorder
 * and delete are all "send the list you want" - idempotent by construction.
 * Key *shape* is validated here; that every key belongs to the caller's
 * tenant + property is checked in the service (needs request context).
 *
 * The bound here is the CEILING, not the tenant's cap: a static schema cannot
 * know which tenant is asking. The tenant value is enforced in the service,
 * where "never grow past the cap" can also see the gallery it is growing from
 * (ADR-0030).
 */
export const updatePhotosRequestSchema = z.object({
  keys: z
    .array(z.string().min(1).max(200).regex(/^[A-Za-z0-9/._-]+$/))
    .max(PHOTO_GALLERY_CEILING)
    .refine((keys) => new Set(keys).size === keys.length, {
      message: "Duplicate photo keys",
    }),
});
export type UpdatePhotosRequest = z.infer<typeof updatePhotosRequestSchema>;
