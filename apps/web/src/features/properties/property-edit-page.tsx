import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  isArchived,
  isVerified,
  propertyTimeZoneSchema,
  updatePropertyRequestSchema,
  type PropertyResponse,
  type PropertyTimeZone,
  type UpdatePropertyRequest,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { conflictOf, describeConflict } from "../../lib/conflict";
import { issuesToFieldErrors } from "../../lib/forms";
import { isOwner } from "../../lib/role";
import { FormField } from "@/components/form-field";
import { ListError, ListSkeleton } from "@/components/list-state";
import { PageHeader } from "@/components/page-header";
import { ChannelsSection } from "./channels-section";
import { PhotosSection } from "./photos-section";
import { UnitsSection } from "./units-section";
import { VerifiedBadge } from "./verified-badge";

const route = getRouteApi("/app/properties/$propertyId");

// The property workbench (page-spec §4.5): details, photos, units, and channels
// (the per-unit OTA sync + export links, #55).
export function PropertyEditPage() {
  const { propertyId } = route.useParams();
  const query = useQuery({
    queryKey: ["properties", propertyId],
    queryFn: () => api.get<PropertyResponse>(`/properties/${propertyId}`),
    retry: (failureCount, error) =>
      // A 404 stays a 404 - don't burn retries on it.
      !(error instanceof ApiError && error.status === 404) && failureCount < 1,
  });
  const property = query.data;

  // A 404 and a network failure used to render the SAME sentence, so a blip
  // claimed the property did not exist (divergence D5). Error is checked before
  // data, and the gate is `!data` rather than `isLoading` - which goes false the
  // moment a failed attempt settles (D2).
  if (query.isError) {
    const notFound =
      query.error instanceof ApiError && query.error.status === 404;
    return (
      <ListError>
        {notFound
          ? "This property doesn’t exist, or it isn’t yours."
          : "We couldn’t load this property. Please try again."}
      </ListError>
    );
  }
  if (!property) {
    return <ListSkeleton className="h-64" />;
  }

  const archived = isArchived(property);

  return (
    <section>
      <PageHeader
        title={property.name}
        titleSuffix={
          <>
            {property.verified && <VerifiedBadge />}
            {archived && (
              <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                Archived
              </span>
            )}
          </>
        }
      />
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
            The public page is live, but incomplete - it needs at least one photo
            and one unit with a price before it's worth sharing.
          </p>
        )
      )}

      {/* key: remount the form when the server row changes identity */}
      <DetailsForm key={property.id} property={property} />

      <PhotosSection property={property} />

      <UnitsSection property={property} />

      <ChannelsSection property={property} />

      {/* Owner-only, and hidden rather than disabled (#57): archiving and
          deleting change which properties EXIST, which is the owner's call.
          Everything above - details, photos, units, channels - is what being
          assigned a property lets a staff member do. The server refuses either
          way (`@Roles('owner')` → 403); this only stops offering a dead end. */}
      {isOwner() && (
        <>
          <ArchiveZone property={property} archived={archived} />
          <DangerZone property={property} />
        </>
      )}
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

/** The three Indonesian zones, named the way an owner here would say them - the
 * local abbreviation first, because "WITA" is what a Bali owner recognises, not
 * "Asia/Makassar". */
const TIME_ZONE_LABELS: Record<PropertyTimeZone, string> = {
  "Asia/Jakarta": "WIB - Java, Sumatra (UTC+7)",
  "Asia/Makassar": "WITA - Bali, Lombok, Sulawesi (UTC+8)",
  "Asia/Jayapura": "WIT - Papua, Maluku (UTC+9)",
};

function DetailsForm({ property }: { property: PropertyResponse }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: property.name,
    address: property.address ?? "",
    latitude: property.latitude?.toString() ?? "",
    longitude: property.longitude?.toString() ?? "",
    description: property.description ?? "",
    licenseNo: property.licenseNo ?? "",
    depositPct: property.depositPct.toString(),
    timeZone: property.timeZone,
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
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
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
      // Blank = leave the setting alone (it is not nullable); otherwise a number
      // the shared schema bounds to 1-100.
      depositPct: form.depositPct === "" ? undefined : Number(form.depositPct),
      timeZone: form.timeZone,
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

      {/* Deliberately HERE, in the location group, and not down with the payment
          settings (#145, ADR-0028). A property's zone is a fact about WHERE it
          is - the third answer to the same question the address and coordinates
          above are asking - not a setting belonging to one integration. Placing
          it there is what lets the WITA default mean "the owner saw this while
          telling us where the villa is and accepted it" rather than "we guessed
          Bali": the copy leads with the place and mentions OTA calendars second,
          for the same reason. */}
      <FormField label="Time zone" error={fieldErrors.timeZone}>
        {(field) => (
          <div>
            <select
              value={form.timeZone}
              onChange={set("timeZone")}
              className={inputClass}
              {...field}
            >
              {propertyTimeZoneSchema.options.map((tz) => (
                <option key={tz} value={tz}>
                  {TIME_ZONE_LABELS[tz]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-muted-foreground">
              The local clock where the property is. Imported OTA calendars are
              read against it.
            </p>
          </div>
        )}
      </FormField>

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

      {/* Deposit % (api #10, ADR-0015): the share of a booking's total a guest
          pays online at checkout. 100 = pay in full; less takes a partial deposit
          now and settles the balance at the property. */}
      <FormField label="Deposit taken online (%)" error={fieldErrors.depositPct}>
        {(field) => (
          <div>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={form.depositPct}
              onChange={set("depositPct")}
              className={inputClass}
              {...field}
            />
            <p className="mt-1 text-sm text-muted-foreground">
              Share of the total charged at checkout. 100 = pay in full.
            </p>
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

  // The 409 carries a machine-readable slug + a count (ADR-0002); the web
  // composes the copy from that data, never the server's sentence (#82).
  const conflict = conflictOf(remove.error);
  const deleteError = conflict
    ? describeConflict(conflict)
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
