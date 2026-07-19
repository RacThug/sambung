/**
 * The unified calendar's pure model (#49, ADR-0010). No React, no fetching - just
 * the geometry (window -> day columns, a stay -> a clipped bar) and the
 * composition (units + properties + bookings -> grouped rows), so the bar math
 * and the archived row-rule are unit-tested in isolation.
 *
 * The Calendar is the OWNER'S occupancy view (CONTEXT.md): one row per Unit,
 * every occupying booking a bar coloured by source. It is COMPOSED here on the
 * client from three neutral lists, not served as an aggregate (ADR-0010).
 */
import {
  countNights,
  isArchived,
  type BookingRow,
  type BookingSource,
  type PropertyResponse,
  type UnitResponse,
} from "@sambung/shared";

/** Legend order + label + colour token per source. The colour is a CSS var (the
 * #49 categorical palette in tailwind.css), referenced inline because the source
 * is chosen per bar at runtime. `manual_block` reads as "Manual". */
export const SOURCE_META: Record<
  BookingSource,
  { label: string; cssVar: string }
> = {
  direct: { label: "Direct", cssVar: "var(--source-direct)" },
  airbnb: { label: "Airbnb", cssVar: "var(--source-airbnb)" },
  booking_com: { label: "Booking.com", cssVar: "var(--source-booking-com)" },
  vrbo: { label: "Vrbo", cssVar: "var(--source-vrbo)" },
  manual_block: { label: "Manual", cssVar: "var(--source-manual)" },
};

/** Legend / rendering order - direct first (the product's own bookings), OTAs,
 * then manual blocks. */
export const SOURCE_ORDER: BookingSource[] = [
  "direct",
  "airbnb",
  "booking_com",
  "vrbo",
  "manual_block",
];

// ---- Dates (calendar dates, parsed at UTC - no DST drift) -------------------

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` `n` days after `date` (n may be negative). */
export function addDays(date: string, n: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + n * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The half-open window covering the calendar month that contains `today`
 * (`YYYY-MM-DD`): `[first-of-month, first-of-next-month)`, so every day of the
 * month is a column and the last day is fully shown. */
export function currentMonthWindow(today: string): { from: string; to: string } {
  const from = `${today.slice(0, 7)}-01`;
  const [y, m] = from.split("-").map(Number);
  const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from, to };
}

/** Shift a window by whole months (prev/next stepping). Snaps to the 1st, so a
 * free-range window normalises to a month on the first step - predictable. */
export function shiftMonth(
  window: { from: string; to: string },
  delta: number,
): { from: string; to: string } {
  const [y, m] = window.from.split("-").map(Number);
  const base = y * 12 + (m - 1) + delta;
  const ny = Math.floor(base / 12);
  const nm = (base % 12) + 1;
  const from = `${ny}-${String(nm).padStart(2, "0")}-01`;
  return currentMonthWindow(from);
}

export interface Day {
  date: string; // YYYY-MM-DD
  dom: number; // day-of-month
  dow: number; // 0=Sun .. 6=Sat
  isWeekend: boolean;
}

/** The day columns of a window, in order. */
export function windowDays(from: string, to: string): Day[] {
  const n = countNights(from, to);
  const days: Day[] = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(from, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    days.push({
      date,
      dom: Number(date.slice(8, 10)),
      dow,
      isWeekend: dow === 0 || dow === 6,
    });
  }
  return days;
}

// ---- Bar geometry ----------------------------------------------------------

/** A booking's stay clipped to the window, in day-column units. `start`/`end` are
 * half-open column indices in `[0, dayCount]`; `continuesLeft/Right` mark a stay
 * that runs off an edge (the OTA block seen through a one-month window), so the
 * UI can show a "continues" affordance instead of a hard cap. */
export interface BarSpan {
  start: number;
  end: number;
  continuesLeft: boolean;
  continuesRight: boolean;
}

/** Place a stay on the window. Returns null when it does not overlap at all
 * (start === end) - the query already excludes those, this is the belt to its
 * braces. The clip is inclusive of the changeover: a stay ending exactly at the
 * window start has end === 0 and is dropped, matching the half-open model. */
export function barSpan(
  window: { from: string; to: string },
  checkIn: string,
  checkOut: string,
): BarSpan | null {
  const dayCount = countNights(window.from, window.to);
  const rawStart = countNights(window.from, checkIn);
  const rawEnd = countNights(window.from, checkOut);
  const start = Math.max(0, Math.min(rawStart, dayCount));
  const end = Math.max(0, Math.min(rawEnd, dayCount));
  if (end <= start) return null;
  return {
    start,
    end,
    continuesLeft: rawStart < 0,
    continuesRight: rawEnd > dayCount,
  };
}

// ---- Composition (units + properties + bookings -> grouped rows) -----------

export interface CalendarRow {
  unit: UnitResponse;
  /** Effective-archived: the Unit's own flag OR its Property's (ADR-0005),
   * derived here from the two lists (ADR-0010 - not a server flag). */
  archived: boolean;
  bookings: BookingRow[];
}

export interface CalendarGroup {
  property: PropertyResponse;
  rows: CalendarRow[];
}

/**
 * Compose the calendar. The row rule: an ACTIVE Unit always gets a row (even
 * empty - "this villa is wide open"); an effective-ARCHIVED Unit gets one only if
 * it carries a booking in the given set (which the caller has already scoped to
 * the occupying statuses), so retired-and-empty inventory is not noise. A Property
 * with no visible rows drops out entirely - no header-only groups.
 *
 * Bookings whose unit is unknown (should not happen - GET /units returns every
 * tenant unit, archived included) are ignored rather than crashing a render.
 */
export function buildCalendar(input: {
  properties: PropertyResponse[];
  units: UnitResponse[];
  bookings: BookingRow[];
}): CalendarGroup[] {
  const byUnit = new Map<string, BookingRow[]>();
  for (const b of input.bookings) {
    const list = byUnit.get(b.unitId);
    if (list) list.push(b);
    else byUnit.set(b.unitId, [b]);
  }

  const unitsByProperty = new Map<string, UnitResponse[]>();
  for (const u of input.units) {
    const list = unitsByProperty.get(u.propertyId);
    if (list) list.push(u);
    else unitsByProperty.set(u.propertyId, [u]);
  }

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);

  const groups: CalendarGroup[] = [];
  for (const property of [...input.properties].sort(byName)) {
    const propertyArchived = isArchived(property);
    const units = (unitsByProperty.get(property.id) ?? []).sort(byName);
    const rows: CalendarRow[] = [];
    for (const unit of units) {
      const bookings = byUnit.get(unit.id) ?? [];
      const archived = isArchived(unit) || propertyArchived;
      // Archived-and-empty is retired noise; drop it. Active, or archived-with-a-
      // booking, stays.
      if (archived && bookings.length === 0) continue;
      rows.push({ unit, archived, bookings });
    }
    if (rows.length > 0) groups.push({ property, rows });
  }
  return groups;
}

/** True when the tenant has no drawable Unit rows at all - the calendar's empty
 * state (onboarding CTA), distinct from "has units, just no bookings" (a valid
 * wide-open grid). */
export function isEmptyCalendar(groups: CalendarGroup[]): boolean {
  return groups.length === 0;
}
