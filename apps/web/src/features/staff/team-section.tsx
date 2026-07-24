import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createInviteRequestSchema,
  type InviteDto,
  type PropertyResponse,
  type StaffMemberDto,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { conflictOf, describeConflict } from "../../lib/conflict";
import { formatInstant } from "../../lib/date";
import { issuesToFieldErrors } from "../../lib/forms";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import {
  useCreateInvite,
  useInvites,
  useRemoveStaff,
  useRevokeInvite,
  useStaff,
  useUpdateStaff,
} from "./use-staff";

/**
 * Team management on the settings page (page-spec §4.7, #57).
 *
 * Owner-only, and rendered as such: `SettingsPage` shows staff the read-only
 * note instead. That is a courtesy, not the control - every route behind this
 * component is `@Roles('owner')` and answers 403 regardless.
 *
 * A staff member is an email plus a set of Properties. There is no permission
 * matrix and no per-property role, deliberately: the one question this screen
 * answers is "which properties can this person see", because that is the only
 * question the enforcement mechanism (RLS, ADR-0032) can answer.
 */
export function TeamSection() {
  const staff = useStaff();
  const invites = useInvites();
  const properties = useQuery({
    queryKey: ["properties"],
    queryFn: () => api.get<PropertyResponse[]>("/properties"),
  });

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">Team</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Staff members can manage the properties you assign them - bookings,
        photos, units and channels. They can't add or retire properties, change
        these settings, or see anything you haven't assigned.
      </p>

      <InviteForm properties={properties.data ?? []} />

      <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Staff
      </h3>
      {staff.isLoading && (
        <div className="mt-3 h-16 animate-pulse rounded-md bg-muted/40" />
      )}
      {staff.data?.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Nobody yet. Invite someone above.
        </p>
      )}
      <ul className="mt-3 space-y-3">
        {staff.data?.map((member) => (
          <StaffRow
            key={member.id}
            member={member}
            properties={properties.data ?? []}
          />
        ))}
      </ul>

      {invites.data && invites.data.length > 0 && (
        <>
          <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Pending invites
          </h3>
          <ul className="mt-3 space-y-3">
            {invites.data.map((invite) => (
              <InviteRow key={invite.id} invite={invite} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * The one place a set of Properties is picked. Both callers - inviting someone
 * and changing an existing member's access - are asking the identical question,
 * so they ask it with the identical control; two copies of a toggle-a-set
 * handler is two places for a filter to go subtly wrong.
 *
 * `legend` is required rather than optional: this page renders TWO of these with
 * the same property names in them, so without a group label a screen reader
 * announces the same checkbox twice with nothing to distinguish them.
 */
function PropertyPicker({
  properties,
  selected,
  onChange,
  legend,
  legendVisible = false,
}: {
  properties: PropertyResponse[];
  selected: string[];
  onChange: (next: string[]) => void;
  legend: string;
  legendVisible?: boolean;
}) {
  return (
    <fieldset>
      <legend className={legendVisible ? "text-sm font-medium" : "sr-only"}>
        {legend}
      </legend>
      <div className="mt-2 space-y-2">
        {properties.map((property) => (
          <label key={property.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(property.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, property.id]
                    : selected.filter((id) => id !== property.id),
                )
              }
            />
            {property.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function InviteForm({ properties }: { properties: PropertyResponse[] }) {
  const create = useCreateInvite();
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sentTo, setSentTo] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = createInviteRequestSchema.safeParse({
      email,
      propertyIds: selected,
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    create.mutate(parsed.data, {
      onSuccess: () => {
        setSentTo(parsed.data.email);
        setEmail("");
        setSelected([]);
      },
      onError: (error) => {
        // A 409 carries a code, not a sentence (ADR-0012) - the copy is ours.
        const conflict = conflictOf(error);
        if (conflict) {
          setFieldErrors({ email: describeConflict(conflict) });
        } else if (error instanceof ApiError) {
          setFieldErrors(error.fieldErrors);
        }
      },
    });
  }

  const noProperties = properties.length === 0;

  return (
    <form onSubmit={onSubmit} className="mt-6 max-w-xl space-y-4">
      <FormField
        label="Email address"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fieldErrors.email}
      />

      {noProperties ? (
        <p className="text-sm text-muted-foreground">
          Add a property first - an invite has to grant access to something.
        </p>
      ) : (
        <PropertyPicker
          properties={properties}
          selected={selected}
          onChange={setSelected}
          legend="Can manage"
          legendVisible
        />
      )}
      {fieldErrors.propertyIds && (
        <p className="text-sm text-destructive">{fieldErrors.propertyIds}</p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={create.isPending || noProperties}>
          {create.isPending ? "Sending…" : "Send invite"}
        </Button>
        {sentTo && !create.isPending && (
          <span className="text-sm text-muted-foreground">
            Invite emailed to {sentTo}
          </span>
        )}
        {create.isError && !fieldErrors.email && !fieldErrors.propertyIds && (
          <span className="text-sm text-destructive">
            {create.error instanceof ApiError
              ? create.error.message
              : "Couldn't send the invite - please try again"}
          </span>
        )}
      </div>
    </form>
  );
}

function StaffRow({
  member,
  properties,
}: {
  member: StaffMemberDto;
  properties: PropertyResponse[];
}) {
  const update = useUpdateStaff();
  const remove = useRemoveStaff();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(member.properties.map((p) => p.id));

  return (
    <li className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{member.email}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {member.properties.length === 0
              ? "No properties assigned - they can't see anything yet"
              : member.properties.map((p) => p.name).join(", ")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSelected(member.properties.map((p) => p.id));
              setEditing((v) => !v);
            }}
          >
            {editing ? "Cancel" : "Change access"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => {
              // Removing a colleague's account is not undoable by a second
              // click, so it asks - the same bar as deleting inventory.
              if (
                window.confirm(
                  `Remove ${member.email}? They will lose access immediately.`,
                )
              ) {
                remove.mutate(member.id);
              }
            }}
          >
            Remove
          </Button>
        </div>
      </div>

      {editing && (
        <div className="mt-4 border-t border-border pt-4">
          <PropertyPicker
            properties={properties}
            selected={selected}
            onChange={setSelected}
            legend={`Properties ${member.email} can manage`}
          />
          <div className="mt-3 flex items-center gap-3">
            <Button
              type="button"
              disabled={update.isPending || selected.length === 0}
              onClick={() =>
                update.mutate(
                  { id: member.id, propertyIds: selected },
                  { onSuccess: () => setEditing(false) },
                )
              }
            >
              {update.isPending ? "Saving…" : "Save access"}
            </Button>
            {selected.length === 0 && (
              // The API refuses an empty set: an account that can see nothing is
              // access that only looks like access. Removing them is the verb.
              <span className="text-sm text-muted-foreground">
                Pick at least one property, or remove them instead.
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function InviteRow({ invite }: { invite: InviteDto }) {
  const revoke = useRevokeInvite();
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-dashed border-border p-4">
      <div>
        <p className="font-medium">{invite.email}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {invite.properties.map((p) => p.name).join(", ") || "No properties"} ·
          expires {formatInstant(invite.expiresAt)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={revoke.isPending}
        onClick={() => revoke.mutate(invite.id)}
      >
        {revoke.isPending ? "Revoking…" : "Revoke"}
      </Button>
    </li>
  );
}
