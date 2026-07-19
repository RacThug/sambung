import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  createPropertyRequestSchema,
  isArchived,
  type PropertyResponse,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { issuesToFieldErrors } from "../../lib/forms";
import { VerifiedBadge } from "./verified-badge";

// Inventory home: list + create (FR-PROP-1, page-spec §4.4). Editing happens
// on the property page (§4.5); the dialog only needs a name to get there.
export function PropertiesPage() {
  const { data: properties, isLoading } = useQuery({
    queryKey: ["properties"],
    queryFn: () => api.get<PropertyResponse[]>("/properties"),
  });
  const [dialogOpen, setDialogOpen] = useState(false);

  if (isLoading) {
    return <p className="text-muted-foreground">Loading properties…</p>;
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Properties</h1>
        {properties && properties.length > 0 && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            New property
          </button>
        )}
      </div>

      {properties && properties.length === 0 && (
        <div className="mt-12 rounded-lg border border-dashed border-input p-12 text-center">
          <h2 className="text-lg font-semibold">Add your first property</h2>
          <p className="mt-1 text-muted-foreground">
            List a villa or guesthouse to start taking direct bookings.
          </p>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="mt-4 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
          >
            New property
          </button>
        </div>
      )}

      <ul className="mt-6 space-y-3">
        {properties?.map((property) => {
          const archived = isArchived(property);
          return (
            <li key={property.id}>
              <Link
                to="/app/properties/$propertyId"
                params={{ propertyId: property.id }}
                className={`block rounded-lg border p-4 hover:border-primary ${
                  archived
                    ? "border-border bg-muted"
                    : "border-border bg-card"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`font-semibold ${archived ? "text-muted-foreground" : ""}`}
                  >
                    {property.name}
                  </span>
                  {property.verified && <VerifiedBadge />}
                  {archived && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                      Archived
                    </span>
                  )}
                </div>
                {property.address && (
                  <p
                    className={`mt-1 text-sm ${archived ? "text-muted-foreground" : "text-muted-foreground"}`}
                  >
                    {property.address}
                  </p>
                )}
                <p className="mt-2 text-sm">
                  {/* Retired trumps the publish checklist - it's offline for
                      guests regardless of how complete it is (ADR-0006). */}
                  {archived ? (
                    <span className="text-muted-foreground">◌ Archived - hidden from guests</span>
                  ) : property.publishable ? (
                    <span className="text-success">● Ready to publish</span>
                  ) : (
                    <span className="text-warning">
                      ○ Incomplete — needs a photo and a priced unit
                    </span>
                  )}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>

      {dialogOpen && <CreateDialog onClose={() => setDialogOpen(false)} />}
    </section>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: (body: { name: string }) =>
      api.post<PropertyResponse>("/properties", body),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["properties"] });
      void navigate({
        to: "/app/properties/$propertyId",
        params: { propertyId: created.id },
      });
    },
    onError: (error) => {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = createPropertyRequestSchema.safeParse({ name });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    create.mutate({ name: parsed.data.name });
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-foreground/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-property-title"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg"
        noValidate
      >
        <h2 id="create-property-title" className="text-lg font-semibold">
          New property
        </h2>
        <label className="mt-4 block">
          <span className="text-sm font-medium text-foreground">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-input px-3 py-2"
          />
          {fieldErrors.name && (
            <p className="mt-1 text-sm text-destructive">{fieldErrors.name}</p>
          )}
        </label>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm font-medium text-foreground"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
