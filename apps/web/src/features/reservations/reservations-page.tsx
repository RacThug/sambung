import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { todayIso } from "../../lib/date";
import { ExportCsvButton } from "./export-csv-button";
import { ReservationFilters } from "./reservation-filters";
import { ReservationsTable } from "./reservations-table";
import {
  composeRows,
  hasActiveFilters,
  resolveWindow,
} from "./reservations-model";
import { useReservations } from "./use-reservations";
import type { ReservationsSearch } from "./reservations-search";

const route = getRouteApi("/app/reservations");

/**
 * The reservations list - `/app/reservations` (page-spec §4.2, #51). The operational
 * table: find, filter, open. Composed on the client from the one booking-read path +
 * the flat unit/property lists (ADR-0010), the same primitives the calendar uses -
 * here shown as rows of EVERY status, not bars of the occupying ones.
 *
 * Opens on the default "upcoming" window (`[today, today+366)`, resolveWindow): an
 * owner mostly cares about what is coming up. Setting a date range searches any span
 * (past included, up to the 366-night cap); clearing returns to upcoming.
 */
export function ReservationsPage() {
  const search = route.useSearch();
  const navigate = useNavigate();

  const { window, error: windowError, isDefault } = resolveWindow(
    search.from,
    search.to,
    todayIso(),
  );
  const isFiltered = hasActiveFilters(search);

  // The exact filters the list queries with (resolved window included), so the CSV
  // export and the on-screen table are the same view (#59).
  const filters = {
    window,
    propertyId: search.propertyId,
    status: search.status,
    source: search.source,
  };

  const { properties, units, bookings } = useReservations(filters);

  const onPatch = (partial: Partial<ReservationsSearch>) =>
    void navigate({
      to: "/app/reservations",
      search: (prev) => ({ ...prev, ...partial }),
    });
  const onClear = () =>
    void navigate({ to: "/app/reservations", search: {} });

  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-foreground">Reservations</h1>
        <ExportCsvButton filters={filters} />
      </div>

      <ReservationFilters
        search={search}
        properties={properties.data ?? []}
        windowError={windowError}
        showUpcomingHint={isDefault && !windowError}
        isFiltered={isFiltered}
        onPatch={onPatch}
        onClear={onClear}
      />

      <ReservationsBody
        isFiltered={isFiltered}
        properties={properties}
        units={units}
        bookings={bookings}
        onClear={onClear}
      />
    </section>
  );
}

function ReservationsBody({
  isFiltered,
  properties,
  units,
  bookings,
  onClear,
}: {
  isFiltered: boolean;
  properties: ReturnType<typeof useReservations>["properties"];
  units: ReturnType<typeof useReservations>["units"];
  bookings: ReturnType<typeof useReservations>["bookings"];
  onClear: () => void;
}) {
  if (properties.isError || units.isError || bookings.isError) {
    return (
      <Notice>We couldn’t load your reservations. Please try again.</Notice>
    );
  }

  if (!properties.data || !units.data || !bookings.data) {
    return (
      <div className="h-64 animate-pulse rounded-lg border border-border bg-muted/40" />
    );
  }

  const rows = composeRows(bookings.data, units.data, properties.data);

  if (rows.length === 0) {
    // The two empty states (AC): an explicit filter excluded everything, vs the
    // untouched default upcoming window being empty. `isFiltered` reads the URL, not
    // the result count, so a lone-`from` still reads as "filtered" (its hint shows).
    return isFiltered ? <EmptyFiltered onClear={onClear} /> : <EmptyUpcoming />;
  }

  return (
    <>
      <ReservationsTable rows={rows} />
      <p className="mt-3 text-xs text-muted-foreground">
        {rows.length} reservation{rows.length === 1 ? "" : "s"}
      </p>
    </>
  );
}

function EmptyFiltered({ onClear }: { onClear: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-12 text-center">
      <h2 className="text-lg font-semibold text-foreground">No matches</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        No reservations match these filters. Try widening the dates or clearing a
        filter.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-4 rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
      >
        Clear filters
      </button>
    </div>
  );
}

function EmptyUpcoming() {
  // The default upcoming window is empty. This covers both a brand-new tenant and one
  // whose only bookings are in the past - so the copy points at the date range rather
  // than claiming the tenant has none at all.
  return (
    <div className="rounded-lg border border-dashed border-border p-12 text-center">
      <h2 className="text-lg font-semibold text-foreground">
        No upcoming reservations
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        New bookings - and any walk-ins or blocks you add - show up here. To see past
        reservations, pick a start and end date above.
      </p>
      <Link
        to="/app/calendar"
        className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Go to the calendar
      </Link>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
