import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPriceOverrideRequestSchema,
  lastNightOf,
  type CreatePriceOverrideRequest,
  type PriceOverrideResponse,
  type PropertyResponse,
  type UnitResponse,
} from "@sambung/shared";
import { api, ApiError } from "../../lib/api-client";
import { conflictOf, describeConflict } from "../../lib/conflict";
import { addDays, formatDate } from "../../lib/date";
import { issuesToFieldErrors } from "../../lib/forms";
import { formatIdr } from "../../lib/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListSkeleton } from "@/components/list-state";

/**
 * Prices on the property workbench (PRD-product P0-2, page-spec §4.5 amendment).
 *
 * One panel per Unit, like Channels: a Unit is one sellable thing (ADR-0001)
 * with its own rate. The base price is the everyday rate (edited in the Units
 * table above); this panel layers dated windows over it - Aug peak, Dec-Jan,
 * Nyepi - each "first night / last night / price per night".
 *
 * Collapsed per Unit and fetched on EXPAND: most Units, most days, have no
 * override, and this page's mount fan-out is already the app's highest
 * (page-spec §4.5 §10).
 *
 * The ranges shown are the owner's inclusive "first night - last night"; the
 * wire stays half-open `[from, to)` like every range in the system, mapped
 * through the one shared `lastNightOf` / `addDays` pair - never a second copy
 * of the half-open rule.
 */
export function PricesSection({ property }: { property: PropertyResponse }) {
  // Same query key as UnitsSection/ChannelsSection - TanStack Query dedupes.
  const unitsQuery = useQuery({
    queryKey: ["properties", property.id, "units"],
    queryFn: () => api.get<UnitResponse[]>(`/properties/${property.id}/units`),
  });
  const units = unitsQuery.data;

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold">Prices</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Charge more (or less) for chosen dates. The base price is your everyday
        rate - keep it as your lowest and add peak-season prices here.
      </p>

      {unitsQuery.isError ? (
        <p className="mt-4 text-sm text-muted-foreground">
          We couldn’t load these prices. Please try again.
        </p>
      ) : units === undefined ? (
        <ListSkeleton className="mt-4 h-24" />
      ) : units.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Add a unit first - prices are set per unit.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {units.map((unit) => (
            <UnitPrices key={unit.id} unit={unit} />
          ))}
        </div>
      )}
    </div>
  );
}

function UnitPrices({ unit }: { unit: UnitResponse }) {
  const [open, setOpen] = useState(false);
  // Effective-archived (server-derived, ADR-0005): the list stays visible so the
  // owner can still see what was charged, but nothing here is editable - the
  // same read-only rule as the Units section.
  const readOnly = unit.archived;

  const overridesQuery = useQuery({
    queryKey: ["units", unit.id, "price-overrides"],
    queryFn: () =>
      api.get<PriceOverrideResponse[]>(`/units/${unit.id}/price-overrides`),
    // Fetch on expand, not on mount (page-spec §4.5 §4).
    enabled: open,
  });
  const overrides = overridesQuery.data;

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-2">
          <span className="font-medium">{unit.name}</span>
          {readOnly && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
              Archived
            </span>
          )}
        </span>
        <span className="text-sm text-muted-foreground">
          {formatIdr(unit.basePriceIdr)} / night · {open ? "Hide" : "Seasonal prices"}
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">
            All other nights: {formatIdr(unit.basePriceIdr)} (the base price,
            edited in Units above).
          </p>

          {overridesQuery.isError ? (
            <p className="mt-3 text-sm text-muted-foreground">
              We couldn’t load this unit’s prices. Please try again.
            </p>
          ) : overrides === undefined ? (
            <ListSkeleton className="mt-3 h-10" />
          ) : overrides.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No seasonal prices yet - every night sells at the base price.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {overrides.map((o) => (
                <OverrideRow
                  key={o.id}
                  override={o}
                  unitId={unit.id}
                  readOnly={readOnly}
                />
              ))}
            </ul>
          )}

          {readOnly ? (
            <p className="mt-3 text-sm text-muted-foreground">
              This unit is archived - unarchive it to change prices.
            </p>
          ) : (
            <AddOverrideForm unitId={unit.id} />
          )}
        </div>
      )}
    </div>
  );
}

function OverrideRow({
  override,
  unitId,
  readOnly,
}: {
  override: PriceOverrideResponse;
  unitId: string;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: () => api.delete<void>(`/price-overrides/${override.id}`),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["units", unitId, "price-overrides"],
      }),
    // A 404 means it is already gone - which is what deleting wanted. Refetch
    // and the row leaves the list either way.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void queryClient.invalidateQueries({
          queryKey: ["units", unitId, "price-overrides"],
        });
      }
    },
  });

  const failed =
    remove.isError &&
    !(remove.error instanceof ApiError && remove.error.status === 404);

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
      <span className="text-sm">
        {/* Inclusive nights for the human; the wire's `to` is exclusive. */}
        {formatDate(override.from)} – {formatDate(lastNightOf(override))}
        <span className="ml-2 font-medium">
          {formatIdr(override.nightlyPriceIdr)} / night
        </span>
      </span>
      {!readOnly && (
        <span className="flex items-center gap-2">
          {failed && (
            <span className="text-xs text-destructive">
              Remove failed - please try again.
            </span>
          )}
          {/* No confirm: removing a price window is reversible by re-adding it,
              and it never touches a booking (their totals are snapshots). */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        </span>
      )}
    </li>
  );
}

function AddOverrideForm({ unitId }: { unitId: string }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    firstNight: "",
    lastNight: "",
    nightlyPriceIdr: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: (body: CreatePriceOverrideRequest) =>
      api.post<PriceOverrideResponse>(`/units/${unitId}/price-overrides`, body),
    onSuccess: async () => {
      // Only this key: quotes are computed server-side, so no other cache holds
      // a price this write could stale (page-spec §4.5 §6).
      await queryClient.invalidateQueries({
        queryKey: ["units", unitId, "price-overrides"],
      });
      setForm({ firstNight: "", lastNight: "", nightlyPriceIdr: "" });
      setFieldErrors({});
    },
    onError: (error) => {
      // The overlap is the only 409 this form raises; our copy, never the
      // server's prose (#82). Otherwise surface zod field errors.
      const conflict = conflictOf(error);
      setFieldErrors(
        conflict?.code === "price_override_overlap"
          ? { to: describeConflict(conflict) }
          : error instanceof ApiError
            ? error.fieldErrors
            : {},
      );
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // The owner thinks in inclusive nights; the wire is half-open [from, to).
    // `to` = the day AFTER the last night - the one place the mapping happens.
    const parsed = createPriceOverrideRequestSchema.safeParse({
      from: form.firstNight,
      to: form.lastNight ? addDays(form.lastNight, 1) : form.lastNight,
      nightlyPriceIdr: form.nightlyPriceIdr
        ? Number(form.nightlyPriceIdr)
        : undefined,
    });
    if (!parsed.success) {
      setFieldErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    create.mutate(parsed.data);
  }

  const formError =
    create.error instanceof ApiError &&
    create.error.status !== 409 &&
    Object.keys(create.error.fieldErrors).length === 0
      ? create.error.message
      : create.error && !(create.error instanceof ApiError)
        ? "Something went wrong - please try again"
        : null;

  const errorLine =
    fieldErrors.from ?? fieldErrors.to ?? fieldErrors.nightlyPriceIdr ?? formError;

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="mt-3 border-t border-border pt-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label
            className="mb-1 block text-xs text-muted-foreground"
            htmlFor={`po-from-${unitId}`}
          >
            First night
          </label>
          <Input
            id={`po-from-${unitId}`}
            type="date"
            value={form.firstNight}
            onChange={(e) =>
              setForm((f) => ({ ...f, firstNight: e.target.value }))
            }
          />
        </div>
        <div>
          <label
            className="mb-1 block text-xs text-muted-foreground"
            htmlFor={`po-to-${unitId}`}
          >
            Last night
          </label>
          <Input
            id={`po-to-${unitId}`}
            type="date"
            value={form.lastNight}
            onChange={(e) =>
              setForm((f) => ({ ...f, lastNight: e.target.value }))
            }
          />
        </div>
        <div>
          <label
            className="mb-1 block text-xs text-muted-foreground"
            htmlFor={`po-price-${unitId}`}
          >
            Price per night (IDR)
          </label>
          <Input
            id={`po-price-${unitId}`}
            type="number"
            inputMode="numeric"
            min={1}
            placeholder="2500000"
            value={form.nightlyPriceIdr}
            onChange={(e) =>
              setForm((f) => ({ ...f, nightlyPriceIdr: e.target.value }))
            }
          />
        </div>
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? "Saving…" : "Add price"}
        </Button>
      </div>
      {errorLine && (
        <p className="mt-2 text-xs text-destructive">{errorLine}</p>
      )}
    </form>
  );
}
