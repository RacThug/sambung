import { api } from "../../lib/api-client";
import { bookingsQueryString, type ReservationFilters } from "./use-reservations";

/**
 * The reservations CSV export (#59, page-spec §4.2 "Export CSV").
 *
 * The endpoint is the list's CSV twin - `GET /bookings/export.csv` - built from the
 * SAME query string as the on-screen list, so the file mirrors exactly what the
 * owner is looking at (same filters). It is an AUTHED read, so it can't be a plain
 * `<a href>` (no Bearer token there): fetch it with the session (api.getBlob) and
 * hand the browser a Blob to save.
 */
export function reservationsExportPath(filters: ReservationFilters): string {
  return `/bookings/export.csv?${bookingsQueryString(filters)}`;
}

/** A filename that records the window the owner exported, so several exports don't
 * collide in the Downloads folder: `reservations-2027-03-01_2027-03-31.csv`. */
export function exportFilename(filters: ReservationFilters): string {
  return `reservations-${filters.window.from}_${filters.window.to}.csv`;
}

/** Fetch the filtered CSV and trigger a browser download. Throws (ApiError) on a
 * non-2xx so the caller can surface it - the fetch carries the token and the same
 * 401-retry as every authed read. */
export async function downloadReservationsCsv(
  filters: ReservationFilters,
): Promise<void> {
  const blob = await api.getBlob(reservationsExportPath(filters));
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(filters);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Release the object URL whether or not the click threw.
    URL.revokeObjectURL(url);
  }
}
