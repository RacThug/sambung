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
import { isOwner } from "../../lib/role";
import { FormField } from "@/components/form-field";
import { ListError, ListSkeleton } from "@/components/list-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { VerifiedBadge } from "./verified-badge";

// Inventory home: list + create (FR-PROP-1, page-spec §4.4). Editing happens
// on the property page (§4.5); the dialog only needs a name to get there.
//
// Two things differ for a staff member (#57), and only one of them is this
// file's doing: the LIST is already narrowed to their assigned properties by the
// server (RLS, ADR-0032 - nothing here filters), and creating one is owner-only,
// so the "New property" affordance is hidden rather than offered and refused.
export function PropertiesPage() {
  const query = useQuery({
    queryKey: ["properties"],
    queryFn: () => api.get<PropertyResponse[]>("/properties"),
  });
  const properties = query.data;
  const [dialogOpen, setDialogOpen] = useState(false);
  const owner = isOwner();

  return (
    <section>
      <PageHeader
        title="Properties"
        action={
          owner && properties && properties.length > 0 ? (
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              New property
            </Button>
          ) : undefined
        }
      />

      {query.isError && (
        <ListError>
          We couldn’t load your properties. Please try again.
        </ListError>
      )}

      {!query.isError && properties === undefined && (
        <ListSkeleton className="mt-6 h-48" />
      )}

      {properties && properties.length === 0 && (
        <div className="mt-12 rounded-lg border border-dashed border-input p-12 text-center">
          {owner ? (
            <>
              <h2 className="text-lg font-semibold">Add your first property</h2>
              <p className="mt-1 text-muted-foreground">
                List a villa or guesthouse to start taking direct bookings.
              </p>
              <Button className="mt-4" onClick={() => setDialogOpen(true)}>
                New property
              </Button>
            </>
          ) : (
            // An empty list means something different to staff: not "get
            // started", but "nobody has assigned you anything yet". Offering
            // them a create button they'd be refused would be worse than useless.
            <>
              <h2 className="text-lg font-semibold">No properties assigned</h2>
              <p className="mt-1 text-muted-foreground">
                Ask an account owner to give you access to a property.
              </p>
            </>
          )}
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
                      ○ Incomplete - needs a photo and a priced unit
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
        <div className="mt-4">
          <FormField
            label="Name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={fieldErrors.name}
          />
        </div>
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
