import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createUnitRequestSchema,
  isSellable,
  type CreateUnitRequest,
  type PropertyResponse,
  type UnitResponse,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { issuesToFieldErrors } from "../../lib/forms";

const rupiah = new Intl.NumberFormat("id-ID");
const formatIdr = (n: number) => `Rp ${rupiah.format(n)}`;

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
  const { data: units, isLoading } = useQuery({
    queryKey: ["properties", property.id, "units"],
    queryFn: () => api.get<UnitResponse[]>(`/properties/${property.id}/units`),
  });
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6">
      <h2 className="text-lg font-semibold">Units</h2>
      <p className="mt-1 text-sm text-gray-500">
        One row per bookable room. Three identical rooms are three units - each
        one is sold, and synced to the OTAs, on its own.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-gray-500">Loading units…</p>
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
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="pb-2 pr-2 font-medium">Name</th>
                <th className="pb-2 pr-2 font-medium">Price / night</th>
                <th className="pb-2 pr-2 font-medium">Guests</th>
                <th className="pb-2 pr-2 font-medium">Min stay</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {units?.map((unit) =>
                editingId === unit.id ? (
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
                    onEdit={() => setEditingId(unit.id)}
                  />
                ),
              )}
              <UnitFormRow propertyId={property.id} />
            </tbody>
          </table>
        </div>
      )}

      {units?.length === 0 && (
        <p className="mt-3 text-sm text-gray-500">
          No units yet — add the first one above to make this property
          publishable.
        </p>
      )}
    </div>
  );
}

function UnitRow({ unit, onEdit }: { unit: UnitResponse; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.delete(`/units/${unit.id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["properties"] }),
  });

  // The 409 says why ("this unit has 14 bookings…"); render the server's own
  // message rather than inventing a second copy of it.
  const deleteError =
    remove.error instanceof ApiError && remove.error.status === 409
      ? remove.error.message
      : remove.error
        ? "Delete failed - please try again"
        : null;

  return (
    <>
      <tr className="border-b border-gray-100">
        <td className="py-3 font-medium text-gray-900">{unit.name}</td>
        <td className="py-3">
          {formatIdr(unit.basePriceIdr)}
          {/* A zero price is storable on purpose (a placeholder, not an error) -
              it just never counts toward publishable, so say so HERE rather than
              only in the banner at the top of the page. */}
          {!isSellable(unit) && (
            <span
              className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800"
              title="A unit priced at zero doesn't count toward publishing this property"
            >
              not sellable
            </span>
          )}
        </td>
        <td className="py-3">{unit.maxGuests}</td>
        <td className="py-3">
          {unit.minStay} night{unit.minStay === 1 ? "" : "s"}
        </td>
        <td className="py-3">
          <div className="flex justify-end gap-1 whitespace-nowrap">
            <button
              type="button"
              onClick={onEdit}
              className="rounded px-2 py-1 font-medium text-brand-700 hover:bg-gray-50"
            >
              Edit
            </button>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(`Delete "${unit.name}"? This cannot be undone.`)
                ) {
                  remove.mutate();
                }
              }}
              className="rounded px-2 py-1 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </td>
      </tr>
      {deleteError && (
        <tr>
          <td colSpan={5} className="pb-3">
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
              {deleteError}
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
    mutationFn: (body: CreateUnitRequest) =>
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
      if (!(error instanceof ApiError)) return;
      // A duplicate name is the only 409 this form can raise, and zod can't
      // catch it (it needs the other rows) - so it arrives from the server and
      // still belongs against the field that caused it, not in a stray banner.
      setFieldErrors(
        error.status === 409 ? { name: error.message } : error.fieldErrors,
      );
    },
  });

  function onSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    const parsed = createUnitRequestSchema.safeParse({
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
  const cellInput = "w-full rounded-md border border-gray-300 px-2 py-1.5";
  const cell = (name: keyof typeof form, input: React.ReactNode) => (
    <td className="py-2 pr-2 align-top">
      {input}
      {fieldErrors[name] && (
        <p className="mt-1 text-xs text-red-600">{fieldErrors[name]}</p>
      )}
    </td>
  );
  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <tr
      // A <form> can't wrap <tr>s without breaking table layout, so the row
      // handles Enter itself. Keeping it is not a nicety: adding 8 rooms is
      // meant to be 8 Enters, which is the entire case for an inline table over
      // a dialog (ADR-0001 makes bulk entry the common path).
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(e);
      }}
      className={
        unit
          ? "border-b border-gray-100 bg-brand-50/40"
          : "border-t border-gray-200"
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
              className="rounded px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            disabled={save.isPending}
            onClick={onSubmit}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : unit ? "Save" : "Add unit"}
          </button>
        </div>
        {save.isError && !(save.error instanceof ApiError) && (
          <p className="mt-1 text-right text-xs text-red-600">
            Something went wrong - please try again
          </p>
        )}
      </td>
    </tr>
  );
}

const numberOrUndefined = (v: string): number | undefined =>
  v.trim() === "" ? undefined : Number(v);
