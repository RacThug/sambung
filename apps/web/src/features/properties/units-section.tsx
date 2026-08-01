import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createUnitRequestSchema,
  isArchived,
  isSellable,
  updateUnitRequestSchema,
  type CreateUnitRequest,
  type PropertyResponse,
  type UnitResponse,
  type UpdateUnitRequest,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { conflictOf, describeConflict } from "../../lib/conflict";
import { issuesToFieldErrors } from "../../lib/forms";
import { formatIdr } from "../../lib/money";
import { ListSkeleton } from "@/components/list-state";

/**
 * Units on the property workbench (page-spec §4.5, api #14/#15/#16).
 *
 * An inline table rather than a dialog per unit: a Unit is one sellable thing
 * (ADR-0001), so an owner with 8 identical rooms creates 8 of them in one
 * sitting. The add row never closes, which makes that eight submits instead of
 * eight open/close cycles - property creation is occasional, unit creation
 * arrives in bursts.
 */
export function UnitsSection({ property }: { property: PropertyResponse }) {
  const unitsQuery = useQuery({
    queryKey: ["properties", property.id, "units"],
    queryFn: () => api.get<UnitResponse[]>(`/properties/${property.id}/units`),
  });
  const units = unitsQuery.data;
  const [editingId, setEditingId] = useState<string | null>(null);

  // When the property is archived, every Unit under it is effectively archived
  // by derivation (ADR-0005) - so the whole section is read-only history: no
  // adding, no per-unit editing/archiving. The exit is unarchiving the property.
  const propertyArchived = isArchived(property);

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">Units</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        One row per bookable room. Three identical rooms are three units - each
        one is sold, and synced to the OTAs, on its own.
      </p>

      {unitsQuery.isError ? (
        <p className="mt-4 text-sm text-muted-foreground">
          We couldn’t load these units. Please try again.
        </p>
      ) : units === undefined ? (
        <ListSkeleton className="mt-4 h-32" />
      ) : (
        // The page body must never scroll sideways; the table may.
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            {/* Explicit widths: with auto layout the actions column collapsed
                until "Edit"/"Delete" wrapped onto two lines. Name takes the
                slack because it's the only field with unbounded content. */}
            <colgroup>
              <col />
              <col className="w-44" />
              <col className="w-24" />
              <col className="w-32" />
              <col className="w-36" />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="pb-2 pr-2 font-medium">Name</th>
                <th className="pb-2 pr-2 font-medium">Price / night</th>
                <th className="pb-2 pr-2 font-medium">Guests</th>
                <th className="pb-2 pr-2 font-medium">Min stay</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {units?.map((unit) =>
                // Editing is impossible while the property is archived, so an
                // in-place edit row can only appear when it isn't.
                editingId === unit.id && !propertyArchived ? (
                  <UnitFormRow
                    key={unit.id}
                    propertyId={property.id}
                    unit={unit}
                    onDone={() => setEditingId(null)}
                  />
                ) : (
                  <UnitRow
                    key={unit.id}
                    unit={unit}
                    propertyArchived={propertyArchived}
                    onEdit={() => setEditingId(unit.id)}
                  />
                ),
              )}
              {/* No add row on a retired property - its units are history. */}
              {!propertyArchived && <UnitFormRow propertyId={property.id} />}
            </tbody>
          </table>
        </div>
      )}

      {propertyArchived ? (
        <p className="mt-3 text-sm text-muted-foreground">
          This property is archived, so its units are shown as history. Unarchive
          the property to add or edit units.
        </p>
      ) : (
        units?.length === 0 && (
          <p className="mt-3 text-sm text-muted-foreground">
            No units yet - add the first one above to make this property
            publishable.
          </p>
        )
      )}
    </div>
  );
}

function UnitRow({
  unit,
  propertyArchived,
  onEdit,
}: {
  unit: UnitResponse;
  propertyArchived: boolean;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  // The unit's OWN flag drives the toggle verb; effective-archived drives how it
  // is SHOWN. They diverge exactly when a live unit sits under an archived
  // property - which must read as archived here, not as a bookable room under a
  // "retired" banner. Both now come from the server (ADR-0005): `archivedAt` is
  // the Unit's own, `archived` the derived one.
  const selfArchived = isArchived(unit);
  const effectiveArchived = unit.archived;
  const remove = useMutation({
    mutationFn: () => api.delete(`/units/${unit.id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["properties"] }),
  });

  // Archive is the reversible retire (ADR-0005): no confirm, unlike delete. One
  // mutation flips both ways - the verb is whichever the unit isn't now. Only
  // reachable while the property is active, so it acts on the unit's own flag.
  const setArchived = useMutation({
    mutationFn: () =>
      api.post(
        `/units/${unit.id}/${selfArchived ? "unarchive" : "archive"}`,
        {},
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["properties"] }),
  });

  // The 409 carries the slug + count ("unit_has_bookings", 14); the web composes
  // "this unit has 14 bookings…" from that data, never the server's prose (#82).
  const conflict = conflictOf(remove.error);
  const deleteError = conflict
    ? describeConflict(conflict)
    : remove.error
      ? "Delete failed - please try again"
      : null;
  const archiveError = setArchived.error
    ? `${selfArchived ? "Unarchive" : "Archive"} failed - please try again`
    : null;

  const muted = effectiveArchived ? "text-muted-foreground" : "";

  return (
    <>
      {/* Effectively-archived rows are muted, not hidden: the owner keeps seeing
          their retired inventory as history (it's just gone from guests). */}
      <tr className={effectiveArchived ? "border-b border-border bg-muted" : "border-b border-border"}>
        <td className={`py-3 font-medium ${effectiveArchived ? "text-muted-foreground" : "text-foreground"}`}>
          {unit.name}
          {effectiveArchived && (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              Archived
            </span>
          )}
        </td>
        <td className={`py-3 tabular-nums ${muted}`}>
          {formatIdr(unit.basePriceIdr)}
          {/* A zero price is storable on purpose (a placeholder, not an error) -
              it just never counts toward publishable, so say so HERE rather than
              only in the banner at the top of the page. Moot once archived, which
              already doesn't count - so don't stack a second badge. */}
          {!effectiveArchived && !isSellable(unit) && (
            <span
              className="ml-2 rounded bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning"
              title="A unit priced at zero doesn't count toward publishing this property"
            >
              not sellable
            </span>
          )}
        </td>
        <td className={`py-3 ${muted}`}>{unit.maxGuests}</td>
        <td className={`py-3 ${muted}`}>
          {unit.minStay} night{unit.minStay === 1 ? "" : "s"}
        </td>
        <td className="py-3">
          {propertyArchived ? (
            // Read-only while the property is retired: units come back by
            // unarchiving the property, not one at a time (ADR-0005).
            <span className="block text-right text-xs text-muted-foreground">
              Property archived
            </span>
          ) : (
            <div className="flex justify-end gap-1 whitespace-nowrap">
              {/* Editing a retired unit is meaningless - it's off every sale path -
                  so the edit affordance goes away until it's brought back. */}
              {!selfArchived && (
                <button
                  type="button"
                  onClick={onEdit}
                  className="rounded px-2 py-1 font-medium text-primary hover:bg-muted"
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                disabled={setArchived.isPending}
                onClick={() => setArchived.mutate()}
                className="rounded px-2 py-1 font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                {setArchived.isPending
                  ? selfArchived
                    ? "Unarchiving…"
                    : "Archiving…"
                  : selfArchived
                    ? "Unarchive"
                    : "Archive"}
              </button>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete "${unit.name}"? This cannot be undone.`,
                    )
                  ) {
                    remove.mutate();
                  }
                }}
                className="rounded px-2 py-1 font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          )}
        </td>
      </tr>
      {(deleteError || archiveError) && (
        <tr>
          <td colSpan={5} className="pb-3">
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              {deleteError ?? archiveError}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * One row, two jobs: the permanent add row at the bottom (no `unit`), and a row
 * being edited in place (`unit` given). Same fields, same validation, same
 * error surfaces - so they can't drift apart.
 */
function UnitFormRow({
  propertyId,
  unit,
  onDone,
}: {
  propertyId: string;
  unit?: UnitResponse;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    name: unit?.name ?? "",
    basePriceIdr: unit ? String(unit.basePriceIdr) : "",
    maxGuests: String(unit?.maxGuests ?? 2),
    minStay: String(unit?.minStay ?? 1),
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (body: CreateUnitRequest | UpdateUnitRequest) =>
      unit
        ? api.patch<UnitResponse>(`/units/${unit.id}`, body)
        : api.post<UnitResponse>(`/properties/${propertyId}/units`, body),
    onSuccess: async () => {
      // Not just the units key: adding a priced unit flips the property's
      // `publishable`, and the banner must move in the same paint. The
      // ["properties"] prefix covers the property, its units and the list page.
      await queryClient.invalidateQueries({ queryKey: ["properties"] });
      setFieldErrors({});
      if (unit) {
        onDone?.();
      } else {
        // Reset and refocus: adding the next room is the likeliest next act.
        setForm({ name: "", basePriceIdr: "", maxGuests: "2", minStay: "1" });
        nameRef.current?.focus();
      }
    },
    onError: (error) => {
      // A duplicate name is the only 409 this form can raise, and zod can't
      // catch it (it needs the other rows) - so it arrives from the server and
      // still belongs against the field that caused it, not in a stray banner.
      // Switch on the slug and render our own copy, never the server's (#82).
      const conflict = conflictOf(error);
      setFieldErrors(
        conflict?.code === "unit_name_taken"
          ? { name: describeConflict(conflict) }
          : error instanceof ApiError
            ? error.fieldErrors
            : {},
      );
    },
  });

  /**
   * Whatever the per-field errors above won't account for.
   *
   * Derived from the error rather than read back off fieldErrors, which lags a
   * submit behind. Without this a 404 (someone deleted this unit in another
   * tab) or a 500 renders NOTHING: both arrive as an ApiError whose `message`
   * is a plain string, so `fieldErrors` is `{}`, and a non-ApiError fallback
   * never fires. "Saving…" flashes and the click looks ignored.
   */
  const formError = (() => {
    const error = save.error;
    if (!error) return null;
    if (!(error instanceof ApiError)) {
      return "Something went wrong - please try again";
    }
    if (error.status === 409) return null; // on the name field
    if (Object.keys(error.fieldErrors).length > 0) return null; // per field
    return error.message;
  })();

  function onSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    // An edit validates against the PATCH schema, a create against the POST one.
    // They differ exactly where it matters: `createUnitRequestSchema` DEFAULTS an
    // absent `maxGuests`/`minStay` to 2 and 1, so editing a unit and clearing one
    // of those boxes used to silently reset the stored value. `.partial()`
    // short-circuits on `undefined` before reaching the default, so the same
    // gesture now means "leave it alone" - which is what PATCH means, and what the
    // API has always validated this request with (`units.controller.ts`).
    const schema = unit ? updateUnitRequestSchema : createUnitRequestSchema;
    const parsed = schema.safeParse({
      name: form.name,
      // "" -> undefined, NOT Number("") which is 0: a blank price must read as
      // "you forgot this", never as a silently free room.
      basePriceIdr: numberOrUndefined(form.basePriceIdr),
      maxGuests: numberOrUndefined(form.maxGuests),
      minStay: numberOrUndefined(form.minStay),
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    save.mutate(parsed.data);
  }

  // The add row and the row being edited are on screen together, so identical
  // accessible names would leave a screen-reader user with two "Name" fields and
  // no way to tell which is which. Only one row is ever in edit mode, so
  // "Edit …" / "New unit …" is enough to make each unique.
  const label = (text: string) => (unit ? `Edit ${text}` : `New unit ${text}`);
  const cellInput = "w-full rounded-md border border-input px-2 py-1.5";
  const cell = (name: keyof typeof form, input: React.ReactNode) => (
    <td className="py-2 pr-2 align-top">
      {input}
      {fieldErrors[name] && (
        <p className="mt-1 text-xs text-destructive">{fieldErrors[name]}</p>
      )}
    </td>
  );
  const set =
    (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <>
      <tr
        // A <form> can't wrap <tr>s without breaking table layout, so the row
        // handles Enter itself. Keeping it is not a nicety: adding 8 rooms is
        // meant to be 8 Enters, which is the entire case for an inline table over
        // a dialog (ADR-0001 makes bulk entry the common path).
        //
        // Inputs only. Enter on Cancel must cancel: keydown bubbles from the
        // button too, and onSubmit's preventDefault would suppress its click, so
        // the row would save instead - the exact opposite of what was asked.
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
            onSubmit(e);
          }
        }}
        className={
          unit
            ? "border-b border-border bg-accent/40"
            : "border-t border-border"
        }
      >
        {cell(
          "name",
          <input
            ref={nameRef}
            value={form.name}
            onChange={set("name")}
            placeholder="Garden Room 1"
            aria-label={label("name")}
            className={cellInput}
          />,
        )}
        {cell(
          "basePriceIdr",
          <input
            inputMode="numeric"
            value={form.basePriceIdr}
            onChange={set("basePriceIdr")}
            placeholder="1200000"
            aria-label={label("price per night in rupiah")}
            className={cellInput}
          />,
        )}
        {cell(
          "maxGuests",
          <input
            inputMode="numeric"
            value={form.maxGuests}
            onChange={set("maxGuests")}
            aria-label={label("maximum guests")}
            className={cellInput}
          />,
        )}
        {cell(
          "minStay",
          <input
            inputMode="numeric"
            value={form.minStay}
            onChange={set("minStay")}
            aria-label={label("minimum stay in nights")}
            className={cellInput}
          />,
        )}
        <td className="py-2 align-top">
          <div className="flex justify-end gap-1 whitespace-nowrap">
            {unit && (
              <button
                type="button"
                onClick={onDone}
                className="rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              disabled={save.isPending}
              onClick={onSubmit}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : unit ? "Save" : "Add unit"}
            </button>
          </div>
        </td>
      </tr>
      {formError && (
        <tr>
          <td colSpan={5} className="pb-2">
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              {formError}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

const numberOrUndefined = (v: string): number | undefined =>
  v.trim() === "" ? undefined : Number(v);
