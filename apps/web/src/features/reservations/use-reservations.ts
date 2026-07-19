import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type BookingRow,
  type BookingSource,
  type BookingStatus,
  type PropertyResponse,
  type UnitResponse,
} from "@sambung/shared";
import { api } from "../../lib/api-client";

export interface ReservationFilters {
  /** The window to query - always a valid pair (resolveWindow gives the owner's
   * range or the default upcoming one), so a lone edge (a 400 at the boundary)
   * never reaches the API. */
  window: { from: string; to: string };
  propertyId?: string;
  status?: BookingStatus[];
  source?: BookingSource[];
}

/**
 * The `GET /bookings` query string from the reservation filters (§5.5, all
 * optional, AND-ed). `status`/`source` go on as REPEATED keys (`?status=a&status=b`)
 * - the API's repeatable set-filter, which its `repeatable()` preprocessor eats -
 * not the JSON-array form the browser URL uses; the page's URL and the API's query
 * are deliberately different strings.
 *
 * Exported so the CSV export (#59) builds its query the SAME way: the export must
 * respect the exact filters the list shows, so it shares this one builder rather
 * than re-deriving the string.
 */
export function bookingsQueryString(filters: ReservationFilters): string {
  const q = new URLSearchParams();
  q.set("from", filters.window.from);
  q.set("to", filters.window.to);
  if (filters.propertyId) q.set("propertyId", filters.propertyId);
  for (const s of filters.status ?? []) q.append("status", s);
  for (const s of filters.source ?? []) q.append("source", s);
  return q.toString();
}

function bookingsPath(filters: ReservationFilters): string {
  return `/bookings?${bookingsQueryString(filters)}`;
}

/**
 * The reservations list's three reads (ADR-0010, "composed not served"): the same
 * `["properties"]` and `["units"]` lists the calendar holds (shared cache - no
 * refetch when arriving from the calendar), plus the bookings for the current
 * filters. The bookings key carries every filter, so each combination is its own
 * cache entry; it shares the `["bookings"]` prefix, so a manual block created on the
 * calendar (§5.4) invalidates this list too.
 *
 * Note the key holds the WHOLE filter set (all statuses, source), which is why it
 * never collides with the calendar's occupying-only bookings query - same endpoint,
 * different question.
 */
export function useReservations(filters: ReservationFilters) {
  const properties = useQuery({
    queryKey: ["properties"],
    queryFn: () => api.get<PropertyResponse[]>("/properties"),
  });
  const units = useQuery({
    queryKey: ["units"],
    queryFn: () => api.get<UnitResponse[]>("/units"),
  });
  const bookings = useQuery({
    queryKey: [
      "bookings",
      filters.window.from,
      filters.window.to,
      filters.propertyId ?? null,
      filters.status ?? [],
      filters.source ?? [],
    ],
    queryFn: () => api.get<BookingRow[]>(bookingsPath(filters)),
    // Keep the current rows on screen while the next filter loads, so toggling a
    // chip doesn't flash empty.
    placeholderData: keepPreviousData,
  });
  return { properties, units, bookings };
}
