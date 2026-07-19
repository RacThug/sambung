import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  OCCUPYING_STATUSES,
  type BookingRow,
  type PropertyResponse,
  type UnitResponse,
} from "@sambung/shared";
import { api } from "../../lib/api-client";

/** Build the `GET /bookings` path, appending `status` once per occupying value -
 * the repeatable filter the calendar uses to name exactly the occupying set
 * (ADR-0010), which a single-valued param could not express. */
function bookingsPath(window: { from: string; to: string }, propertyId?: string) {
  const q = new URLSearchParams();
  q.set("from", window.from);
  q.set("to", window.to);
  if (propertyId) q.set("propertyId", propertyId);
  for (const s of OCCUPYING_STATUSES) q.append("status", s);
  return `/bookings?${q.toString()}`;
}

/**
 * The calendar's three reads (ADR-0010, "composed not served"): the Property
 * names + filter list, the flat Unit skeleton (every row, archived included), and
 * the occupying bookings in the window. Cached independently, so a later manual
 * block (#50) invalidating `bookings` never re-fetches the skeleton.
 *
 * `properties`/`units` are window-independent (the skeleton doesn't move when you
 * page months); only `bookings` is keyed by the window + property filter.
 */
export function useCalendarData(
  window: { from: string; to: string },
  propertyId?: string,
) {
  const properties = useQuery({
    queryKey: ["properties"],
    queryFn: () => api.get<PropertyResponse[]>("/properties"),
  });
  const units = useQuery({
    queryKey: ["units"],
    queryFn: () => api.get<UnitResponse[]>("/units"),
  });
  const bookings = useQuery({
    queryKey: ["bookings", window.from, window.to, propertyId ?? null],
    queryFn: () => api.get<BookingRow[]>(bookingsPath(window, propertyId)),
    // Keep the previous month's grid on screen while the next one loads, so
    // paging months doesn't flash an empty calendar.
    placeholderData: keepPreviousData,
  });
  return { properties, units, bookings };
}
