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
import { addDays } from "../../lib/date";
import type { ReservationsSearch } from "./reservations-search";

/** A booking joined to its Unit and Property names - what the table row draws. The
 * server sends `unitId` only (§5.5), so the display names are composed here from the
 * `GET /units` + `GET /properties` lists the page already holds (ADR-0010). */
export interface ReservationRow {
  booking: BookingRow;
  propertyName: string;
  unitName: string;
}

/** The default "upcoming" window: `[today, today + 366)` - from today through the
 * furthest ahead the API's 366-night cap lets us look in one query. Overlap
 * semantics (§5.5) mean a guest currently in-house still appears (their stay
 * overlaps today), while one who checked out today drops off (half-open, no
 * overlap). This is the reservations list's default, unlike the whole-ledger
 * approach - an owner mostly cares about what is coming up. */
export function defaultWindow(today: string): { from: string; to: string } {
  return { from: today, to: addDays(today, MAX_AVAILABILITY_NIGHTS) };
}

/**
 * The window the list should query. The result is ALWAYS a valid pair (the API 400s
 * a lone edge, so the client must never send one): the owner's `from`/`to` when they
 * form a legal window, otherwise the default upcoming window - with `error` carrying
 * a hint and `isDefault` telling the page it fell back. This is the exclusion-
 * constraint discipline applied to the UI: validate the cross-field rule here, once,
 * and never fire input the boundary will reject.
 */
export interface WindowResult {
  window: { from: string; to: string };
  error: string | null;
  isDefault: boolean;
}

export function resolveWindow(
  from: string | undefined,
  to: string | undefined,
  today: string,
): WindowResult {
  const fallback = { window: defaultWindow(today), isDefault: true };
  if (!from && !to) return { ...fallback, error: null };
  if (!from || !to)
    return { ...fallback, error: "Pick both a start and end date." };
  if (from >= to)
    return { ...fallback, error: "The end date must be after the start." };
  if (countNights(from, to) > MAX_AVAILABILITY_NIGHTS)
    return {
      ...fallback,
      error: `Choose a window of at most ${MAX_AVAILABILITY_NIGHTS} nights.`,
    };
  return { window: { from, to }, error: null, isDefault: false };
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
