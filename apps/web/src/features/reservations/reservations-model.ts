/**
 * The reservations list's pure model (#51, page-spec §4.2). No React, no fetching -
 * just the window validation, the "are we filtered?" predicate, and the join that
 * turns three neutral lists into display rows, so each is unit-tested in isolation.
 *
 * The list is COMPOSED on the client from the one booking-read path + the flat unit
 * and property lists (ADR-0010, "composed not served"), exactly like the calendar -
 * the difference is only which rows and which filters, not a new query.
 */
import {
  countNights,
  MAX_AVAILABILITY_NIGHTS,
  type BookingRow,
  type PropertyResponse,
  type UnitResponse,
} from "@sambung/shared";
import type { ReservationsSearch } from "./reservations-search";

/** A booking joined to its Unit and Property names - what the table row draws. The
 * server sends `unitId` only (§5.5), so the display names are composed here from the
 * `GET /units` + `GET /properties` lists the page already holds (ADR-0010). */
export interface ReservationRow {
  booking: BookingRow;
  propertyName: string;
  unitName: string;
}

/**
 * The result of validating the `from`/`to` pair. The window is half-open `[from,to)`
 * with the same 366-night cap as the API (§5.5), and must be a PAIR: the API 400s a
 * lone edge, so the client never sends one - `window` is `undefined` (fetch all time)
 * whenever the pair is absent or invalid, and `error` carries a hint to show inline.
 * This is the exclusion-constraint discipline applied to the UI: don't fire input the
 * boundary will reject; validate the cross-field rule here, once.
 */
export interface WindowResult {
  window: { from: string; to: string } | undefined;
  error: string | null;
}

export function resolveWindow(
  from: string | undefined,
  to: string | undefined,
): WindowResult {
  if (!from && !to) return { window: undefined, error: null };
  if (!from || !to)
    return { window: undefined, error: "Pick both a start and end date." };
  if (from >= to)
    return { window: undefined, error: "The end date must be after the start." };
  if (countNights(from, to) > MAX_AVAILABILITY_NIGHTS)
    return {
      window: undefined,
      error: `Choose a window of at most ${MAX_AVAILABILITY_NIGHTS} nights.`,
    };
  return { window: { from, to }, error: null };
}

/**
 * Whether any filter is active - the switch between the two empty states (AC): a
 * filtered empty list means "no matches, widen your filters"; an unfiltered empty
 * list means the tenant simply has no bookings yet. A lone `from` (an invalid,
 * un-sent window) still counts as an active filter, so the owner sees "no matches"
 * plus the pair hint rather than a misleading "no bookings yet".
 */
export function hasActiveFilters(search: ReservationsSearch): boolean {
  return Boolean(
    search.from ||
      search.to ||
      search.propertyId ||
      (search.status && search.status.length > 0) ||
      (search.source && search.source.length > 0),
  );
}

/**
 * Join the booking rows to their Unit + Property names, preserving the server's
 * check-in order (§5.5 sorts; we never re-sort - one definition of order). A booking
 * whose unit is unknown is dropped rather than crashing the render - `GET /units`
 * returns every tenant unit (archived included), so this is the belt to that brace.
 */
export function composeRows(
  bookings: BookingRow[],
  units: UnitResponse[],
  properties: PropertyResponse[],
): ReservationRow[] {
  const unitById = new Map(units.map((u) => [u.id, u]));
  const propertyById = new Map(properties.map((p) => [p.id, p]));

  const rows: ReservationRow[] = [];
  for (const booking of bookings) {
    const unit = unitById.get(booking.unitId);
    if (!unit) continue;
    rows.push({
      booking,
      unitName: unit.name,
      propertyName: propertyById.get(unit.propertyId)?.name ?? "—",
    });
  }
  return rows;
}
