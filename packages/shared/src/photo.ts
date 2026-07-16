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
export const MAX_PHOTOS_PER_PROPERTY = 30;

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
 */
export const updatePhotosRequestSchema = z.object({
  keys: z
    .array(z.string().min(1).max(200).regex(/^[A-Za-z0-9/._-]+$/))
    .max(MAX_PHOTOS_PER_PROPERTY)
    .refine((keys) => new Set(keys).size === keys.length, {
      message: "Duplicate photo keys",
    }),
});
export type UpdatePhotosRequest = z.infer<typeof updatePhotosRequestSchema>;
