import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  MAX_PHOTO_SIZE_BYTES,
  MAX_PHOTOS_PER_PROPERTY,
  photoContentTypeSchema,
  type PresignPhotoResponse,
  type PropertyResponse,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { uploadToPresignedUrl } from "../../lib/upload";

interface UploadItem {
  id: number;
  name: string;
  progress: number; // 0-100
  error?: string;
}

let nextUploadId = 1;

/**
 * The photo gallery of the property workbench (page-spec §4.5, #39).
 * Upload flow per file: client-side type/size pre-check → presign (API
 * validates + signs the constraints) → PUT straight to storage with progress
 * → PATCH the whole key set. Reorder and remove PATCH the same whole set -
 * one idempotent operation for every gallery change.
 */
export function PhotosSection({ property }: { property: PropertyResponse }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);

  const keys = property.photos.map((p) => p.key);
  const galleryFull = keys.length >= MAX_PHOTOS_PER_PROPERTY;

  const savePhotos = useMutation({
    mutationFn: (nextKeys: string[]) =>
      api.patch<PropertyResponse>(`/properties/${property.id}/photos`, {
        keys: nextKeys,
      }),
    onSuccess: async (updated) => {
      // The PATCH response IS the fresh row - paint it, don't refetch it.
      // Only the list (exact key) needs a refetch for its publishable badge.
      queryClient.setQueryData(["properties", property.id], updated);
      await queryClient.invalidateQueries({
        queryKey: ["properties"],
        exact: true,
      });
    },
  });

  // While an upload queue runs, its PATCHes work from an accumulator - a
  // concurrent reorder/remove would be overwritten, so those buttons lock.
  const busy = uploading || savePhotos.isPending;

  async function handleFiles(fileList: FileList | null) {
    if (!fileList?.length || uploading) return;
    const files = Array.from(fileList);
    if (inputRef.current) inputRef.current.value = ""; // same file re-pickable
    setUploading(true);
    // Files upload sequentially; each PATCH appends to the authoritative key
    // list the server just returned, so a mid-queue failure loses only its
    // own file.
    let currentKeys = keys;
    for (const file of files) {
      const id = nextUploadId++;
      const patch = (change: Partial<UploadItem>) =>
        setUploads((u) =>
          u.map((x) => (x.id === id ? { ...x, ...change } : x)),
        );
      setUploads((u) => [...u, { id, name: file.name, progress: 0 }]);

      // Pre-upload checks mirror what presign enforces, so obvious mistakes
      // fail instantly without a round-trip. (page-spec §4.5)
      const type = photoContentTypeSchema.safeParse(file.type);
      if (!type.success) {
        patch({ error: "Only JPEG, PNG or WebP images are allowed" });
        continue;
      }
      if (file.size > MAX_PHOTO_SIZE_BYTES) {
        patch({ error: "Too large - the limit is 5 MB" });
        continue;
      }
      if (currentKeys.length >= MAX_PHOTOS_PER_PROPERTY) {
        patch({ error: `Gallery is full (${MAX_PHOTOS_PER_PROPERTY} photos)` });
        continue;
      }

      try {
        const presigned = await api.post<PresignPhotoResponse>(
          `/properties/${property.id}/photos/presign`,
          { contentType: type.data, size: file.size },
        );
        await uploadToPresignedUrl(presigned.uploadUrl, file, (percent) =>
          patch({ progress: percent }),
        );
        const updated = await savePhotos.mutateAsync([
          ...currentKeys,
          presigned.key,
        ]);
        currentKeys = updated.photos.map((p) => p.key);
        setUploads((u) => u.filter((x) => x.id !== id)); // now in the grid
      } catch (err) {
        patch({
          error:
            err instanceof Error
              ? err.message
              : "Upload failed - please try again",
        });
      }
    }
    setUploading(false);
  }

  function move(index: number, delta: -1 | 1) {
    const next = [...keys];
    const [key] = next.splice(index, 1);
    next.splice(index + delta, 0, key);
    savePhotos.mutate(next);
  }

  function remove(index: number) {
    savePhotos.mutate(keys.filter((_, i) => i !== index));
  }

  const iconButtonClass =
    "rounded bg-card/90 px-1.5 py-0.5 text-xs text-foreground shadow " +
    "hover:bg-card disabled:opacity-40";

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">Photos</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The first photo is the cover of your public page. JPEG, PNG or WebP,
        up to 5 MB each.
      </p>

      {property.photos.length > 0 && (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {property.photos.map((photo, i) => (
            <li key={photo.key} className="group relative">
              <img
                src={photo.url}
                alt={`Photo ${i + 1} of ${property.name}`}
                className="aspect-[4/3] w-full rounded-md border border-border object-cover"
              />
              {i === 0 && (
                <span className="absolute left-1.5 top-1.5 rounded bg-foreground/60 px-1.5 py-0.5 text-xs text-background">
                  Cover
                </span>
              )}
              <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  aria-label={`Move photo ${i + 1} left`}
                  disabled={busy || i === 0}
                  onClick={() => move(i, -1)}
                  className={iconButtonClass}
                >
                  ←
                </button>
                <button
                  type="button"
                  aria-label={`Move photo ${i + 1} right`}
                  disabled={busy || i === property.photos.length - 1}
                  onClick={() => move(i, 1)}
                  className={iconButtonClass}
                >
                  →
                </button>
                <button
                  type="button"
                  aria-label={`Remove photo ${i + 1}`}
                  disabled={busy}
                  onClick={() => remove(i)}
                  className={iconButtonClass}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {uploads.length > 0 && (
        <ul className="mt-4 space-y-2">
          {uploads.map((u) => (
            <li
              key={u.id}
              className="rounded-md border border-border px-3 py-2 text-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-foreground">{u.name}</span>
                {u.error ? (
                  <button
                    type="button"
                    aria-label={`Dismiss error for ${u.name}`}
                    onClick={() =>
                      setUploads((all) => all.filter((x) => x.id !== u.id))
                    }
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Dismiss
                  </button>
                ) : (
                  <span className="text-xs text-muted-foreground">{u.progress}%</span>
                )}
              </div>
              {u.error ? (
                <p className="mt-1 text-destructive">{u.error}</p>
              ) : (
                <div className="mt-1.5 h-1.5 rounded bg-muted">
                  <div
                    className="h-1.5 rounded bg-primary transition-[width]"
                    style={{ width: `${u.progress}%` }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        aria-label="Choose photos"
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={busy || galleryFull}
          onClick={() => inputRef.current?.click()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {uploading ? "Uploading…" : "Add photos"}
        </button>
        {galleryFull && (
          <span className="text-sm text-muted-foreground">
            Gallery is full ({MAX_PHOTOS_PER_PROPERTY} photos)
          </span>
        )}
        {savePhotos.isError && !uploading && (
          <span className="text-sm text-destructive">
            {savePhotos.error instanceof ApiError
              ? savePhotos.error.message
              : "Saving photos failed - please try again"}
          </span>
        )}
      </div>
    </div>
  );
}
