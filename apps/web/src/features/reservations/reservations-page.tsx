import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
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
 * There is deliberately no default window: this is a management view over the whole
 * ledger (CONTEXT.md "Reservation"), so an owner sees every booking until they narrow
 * it - the opposite of the calendar, which opens on the current month.
 */
export function ReservationsPage() {
  const search = route.useSearch();
  const navigate = useNavigate();

  const { window, error: windowError } = resolveWindow(search.from, search.to);
  const isFiltered = hasActiveFilters(search);

  const { properties, units, bookings } = useReservations({
    window,
    propertyId: search.propertyId,
    status: search.status,
    source: search.source,
  });

  const onPatch = (partial: Partial<ReservationsSearch>) =>
    void navigate({
      to: "/app/reservations",
      search: (prev) => ({ ...prev, ...partial }),
    });
  const onClear = () =>
    void navigate({ to: "/app/reservations", search: {} });

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold text-foreground">
        Reservations
      </h1>

      <ReservationFilters
        search={search}
        properties={properties.data ?? []}
        windowError={windowError}
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
    // The two empty states (AC): filters excluded everything vs a tenant with no
    // bookings at all. `isFiltered` reads the URL, not the result count, so a
    // lone-`from` (invalid, un-sent) window still reads as "filtered".
    return isFiltered ? <EmptyFiltered onClear={onClear} /> : <EmptyTenant />;
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

function EmptyTenant() {
  return (
    <div className="rounded-lg border border-dashed border-border p-12 text-center">
      <h2 className="text-lg font-semibold text-foreground">
        No reservations yet
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Bookings from your guests - and any walk-ins or blocks you add - will show
        up here.
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
