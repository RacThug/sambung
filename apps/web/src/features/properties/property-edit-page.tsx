import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  isArchived,
  isVerified,
  updatePropertyRequestSchema,
  type PropertyResponse,
  type UpdatePropertyRequest,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { issuesToFieldErrors } from "../../lib/forms";
import { FormField } from "@/components/form-field";
import { PhotosSection } from "./photos-section";
import { UnitsSection } from "./units-section";
import { VerifiedBadge } from "./verified-badge";

const route = getRouteApi("/app/properties/$propertyId");

// The property workbench (page-spec §4.5): details, photos and units; channels
// (M4) dock alongside them later.
export function PropertyEditPage() {
  const { propertyId } = route.useParams();
  const { data: property, isLoading } = useQuery({
    queryKey: ["properties", propertyId],
    queryFn: () => api.get<PropertyResponse>(`/properties/${propertyId}`),
    retry: (failureCount, error) =>
      // A 404 stays a 404 - don't burn retries on it.
      !(error instanceof ApiError && error.status === 404) && failureCount < 1,
  });

  if (isLoading) {
    return <p className="text-muted-foreground">Loading property…</p>;
  }
  if (!property) {
    return <p className="text-muted-foreground">Property not found.</p>;
  }

  const archived = isArchived(property);

  return (
    <section>
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold">{property.name}</h1>
        {property.verified && <VerifiedBadge />}
        {archived && (
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Archived
          </span>
        )}
      </div>
      <PublicLink property={property} archived={archived} />

      {/* When retired, the "incomplete" nudge is moot - lead with the retirement
          state and its exit instead (ADR-0005/0006). */}
      {archived ? (
        <p className="mt-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          This property is retired. Its public page is offline and its units
          can't be booked - existing bookings are untouched. Unarchive it below
          to bring it back.
        </p>
      ) : (
        !property.publishable && (
          <p className="mt-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
            The public page is live, but incomplete — it needs at least one photo
            and one unit with a price before it's worth sharing.
          </p>
        )
      )}

      {/* key: remount the form when the server row changes identity */}
      <DetailsForm key={property.id} property={property} />

      <PhotosSection property={property} />

      <UnitsSection property={property} />

      <ArchiveZone property={property} archived={archived} />

      <DangerZone property={property} />
    </section>
  );
}

/**
 * The property's public address, shown and copyable (page-spec §4.5).
 *
 * Not a nicety - without it the feature has no user. The slug is minted
 * server-side from the name, so an owner has no other way to learn the URL of
 * their own page, and "a guest opens a shared link" (#46) starts with an owner
 * who can copy that link.
 *
 * It says "live", not "preview", because it is: the page renders for anyone with
 * the URL from the moment the property exists (ADR-0004). Calling it a preview
 * would imply a publish step that does not exist and never will - if that
 * changes, it changes as an explicit flag, not by inference from photos.
 */
function PublicLink({
  property,
  archived,
}: {
  property: PropertyResponse;
  archived: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const path = `/p/${property.slug}`;
  const url = window.location.origin + path;

  // A retired property's page 404s (ADR-0006), so don't dangle a link that reads
  // as live. The slug is reserved - unarchive brings this exact URL back.
  if (archived) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        Public page offline while archived: <span className="line-through">{url}</span>
      </p>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-muted-foreground">Public page:</span>
      <a
        href={path}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline underline-offset-2"
      >
        {url}
      </a>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
        className="rounded-md border border-input px-2 py-0.5 text-xs font-medium text-foreground"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

function DetailsForm({ property }: { property: PropertyResponse }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: property.name,
    address: property.address ?? "",
    latitude: property.latitude?.toString() ?? "",
    longitude: property.longitude?.toString() ?? "",
    description: property.description ?? "",
    licenseNo: property.licenseNo ?? "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: UpdatePropertyRequest) =>
      api.patch<PropertyResponse>(`/properties/${property.id}`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["properties"] });
    },
    onError: (error) => {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
    },
  });

  function set(field: keyof typeof form) {
    return (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // "" → null: an emptied input clears the column (shared schema normalizes
    // text fields the same way server-side).
    const parsed = updatePropertyRequestSchema.safeParse({
      name: form.name,
      address: form.address || null,
      latitude: form.latitude === "" ? null : Number(form.latitude),
      longitude: form.longitude === "" ? null : Number(form.longitude),
      description: form.description || null,
      licenseNo: form.licenseNo || null,
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    save.mutate(parsed.data);
  }

  // Shared by the custom controls below (textarea, the license composite); the
  // plain inputs get the same class from FormField's default.
  const inputClass = "mt-1 w-full rounded-md border border-input px-3 py-2";

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="mt-6 space-y-4 rounded-lg border border-border bg-card p-6"
    >
      <h2 className="text-lg font-semibold">Details</h2>

      <FormField
        label="Name"
        value={form.name}
        onChange={set("name")}
        error={fieldErrors.name}
      />
      <FormField
        label="Address"
        value={form.address}
        onChange={set("address")}
        error={fieldErrors.address}
      />
      <div className="grid grid-cols-2 gap-4">
        <FormField
          label="Latitude"
          inputMode="decimal"
          value={form.latitude}
          onChange={set("latitude")}
          error={fieldErrors.latitude}
        />
        <FormField
          label="Longitude"
          inputMode="decimal"
          value={form.longitude}
          onChange={set("longitude")}
          error={fieldErrors.longitude}
        />
      </div>
      <FormField label="Description" error={fieldErrors.description}>
        {(field) => (
          <textarea
            rows={4}
            value={form.description}
            onChange={set("description")}
            className={inputClass}
            {...field}
          />
        )}
      </FormField>
      <FormField label="License number (NIB)" error={fieldErrors.licenseNo}>
        {(field) => (
          <div className="flex items-center gap-3">
            <input
              value={form.licenseNo}
              onChange={set("licenseNo")}
              className={inputClass}
              {...field}
            />
            {/* Live preview: the badge the public page will show (FR-PROP-3). */}
            {isVerified(form.licenseNo) && <VerifiedBadge />}
          </div>
        )}
      </FormField>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {save.isPending ? "Saving…" : "Save details"}
        </button>
        {save.isSuccess && !save.isPending && (
          <span className="text-sm text-success">Saved</span>
        )}
        {save.isError && !(save.error instanceof ApiError) && (
          <span className="text-sm text-destructive">
            Something went wrong - please try again
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * Retire / restore the whole property (ADR-0005). Deliberately NOT the red delete
 * zone: archive is reversible and keeps every booking - it hides the property
 * from guests, it doesn't destroy anything. Archiving here retires the units too,
 * by derivation; unarchive restores exactly the ones not retired on their own.
 */
function ArchiveZone({
  property,
  archived,
}: {
  property: PropertyResponse;
  archived: boolean;
}) {
  const queryClient = useQueryClient();
  const setArchived = useMutation({
    mutationFn: () =>
      api.post(
        `/properties/${property.id}/${archived ? "unarchive" : "archive"}`,
        {},
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["properties"] }),
  });

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">
        {archived ? "Restore property" : "Retire property"}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {archived
          ? "Bring this property and its units back onto the public page and new-booking paths."
          : "Take this property offline for guests while keeping its booking and payment history. Reversible any time."}
      </p>
      {setArchived.isError && (
        <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          {archived ? "Unarchive" : "Archive"} failed - please try again
        </p>
      )}
      <button
        type="button"
        disabled={setArchived.isPending}
        onClick={() => setArchived.mutate()}
        className="mt-4 rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
      >
        {setArchived.isPending
          ? archived
            ? "Unarchiving…"
            : "Archiving…"
          : archived
            ? "Unarchive property"
            : "Archive property"}
      </button>
    </div>
  );
}

function DangerZone({ property }: { property: PropertyResponse }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: () => api.delete(`/properties/${property.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["properties"] });
      void navigate({ to: "/app/properties" });
    },
  });

  // The 409 path renders the reason: "this property has n bookings…" (ADR-0002).
  const deleteError =
    remove.error instanceof ApiError && remove.error.status === 409
      ? remove.error.message
      : remove.error
        ? "Delete failed - please try again"
        : null;

  return (
    <div className="mt-6 rounded-lg border border-destructive/20 bg-destructive/10 p-6">
      <h2 className="text-lg font-semibold text-destructive">Delete property</h2>
      <p className="mt-1 text-sm text-destructive">
        Removes the property and its units. Only possible while nothing has ever
        been booked here - deleting it later would destroy the booking and
        payment history.
      </p>
      {deleteError && (
        <p className="mt-2 rounded-md bg-card px-3 py-2 text-sm font-medium text-destructive">
          {deleteError}
        </p>
      )}
      <button
        type="button"
        disabled={remove.isPending}
        onClick={() => {
          if (window.confirm(`Delete "${property.name}"? This cannot be undone.`)) {
            remove.mutate();
          }
        }}
        className="mt-4 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
      >
        {remove.isPending ? "Deleting…" : "Delete property"}
      </button>
    </div>
  );
}
