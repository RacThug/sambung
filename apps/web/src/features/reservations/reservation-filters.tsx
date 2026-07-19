import {
  type BookingSource,
  type BookingStatus,
  type PropertyResponse,
} from "@sambung/shared";
import { SOURCE_META, SOURCE_ORDER } from "../calendar/calendar-model";
import { STATUS_LABEL, STATUS_ORDER } from "../bookings/booking-display";
import type { ReservationsSearch } from "./reservations-search";

/** Add/remove `value` from the current set, returning it in `canonical` order so the
 * URL (and the query key) is stable regardless of the click order - `?status=a&b`
 * and `?status=b&a` are the same filter and should not be two cache entries. Returns
 * `undefined` when the set empties, so the param drops out of the URL entirely. */
function toggleValue<T>(
  current: T[] | undefined,
  value: T,
  canonical: readonly T[],
): T[] | undefined {
  const set = new Set(current ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  const next = canonical.filter((v) => set.has(v));
  return next.length > 0 ? next : undefined;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-input text-muted-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The reservations filter bar (page-spec §4.2): property, status, source, and the
 * date window - every control writes a typed search param, so the whole view is a
 * shareable URL. Presentational: it reads `search` and calls `onPatch` / `onClear`;
 * the page owns navigation and the query.
 */
export function ReservationFilters({
  search,
  properties,
  windowError,
  showUpcomingHint,
  isFiltered,
  onPatch,
  onClear,
}: {
  search: ReservationsSearch;
  properties: PropertyResponse[];
  windowError: string | null;
  /** The default upcoming window is in effect (no owner-set dates) - show the
   * caption that explains why past bookings aren't listed and how to reach them. */
  showUpcomingHint: boolean;
  isFiltered: boolean;
  onPatch: (partial: Partial<ReservationsSearch>) => void;
  onClear: () => void;
}) {
  return (
    <div className="mb-4 space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Property
          <select
            value={search.propertyId ?? ""}
            onChange={(e) =>
              onPatch({ propertyId: e.target.value || undefined })
            }
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
          >
            <option value="">All properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          From
          <input
            type="date"
            value={search.from ?? ""}
            onChange={(e) => onPatch({ from: e.target.value || undefined })}
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          To
          <input
            type="date"
            value={search.to ?? ""}
            onChange={(e) => onPatch({ to: e.target.value || undefined })}
            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
          />
        </label>

        {isFiltered && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {windowError ? (
        <p className="text-xs text-destructive">{windowError}</p>
      ) : showUpcomingHint ? (
        <p className="text-xs text-muted-foreground">
          Showing upcoming reservations. Pick a start and end date to search another
          range.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <FilterRow label="Status">
          {STATUS_ORDER.map((s) => (
            <Chip
              key={s}
              active={(search.status ?? []).includes(s)}
              onClick={() =>
                onPatch({
                  status: toggleValue<BookingStatus>(
                    search.status,
                    s,
                    STATUS_ORDER,
                  ),
                })
              }
            >
              {STATUS_LABEL[s]}
            </Chip>
          ))}
        </FilterRow>

        <FilterRow label="Source">
          {SOURCE_ORDER.map((s) => (
            <Chip
              key={s}
              active={(search.source ?? []).includes(s)}
              onClick={() =>
                onPatch({
                  source: toggleValue<BookingSource>(
                    search.source,
                    s,
                    SOURCE_ORDER,
                  ),
                })
              }
            >
              {SOURCE_META[s].label}
            </Chip>
          ))}
        </FilterRow>
      </div>
    </div>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
