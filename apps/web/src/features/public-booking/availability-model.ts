/**
 * Pure glue between the availability contract (`@sambung/shared`) and the
 * calendar widget (`react-day-picker`), and between both and the URL. No React,
 * no fetching - just the date math, so the half-open semantics (db-design §4.2)
 * are unit-tested in isolation.
 *
 * Two clocks meet here. The server speaks half-open `[from, to)` `YYYY-MM-DD`
 * strings - `to` is the checkout day, never a night. react-day-picker speaks
 * native `Date` objects and INCLUSIVE ranges. Everything is done in the browser's
 * LOCAL time, because the picker disables "past" relative to the guest's own
 * calendar day (FR-CAL-1); a `Date` built here is always local midnight, so a
 * guest in Bali and one in Los Angeles each see their own today.
 */
import type { DateRange } from "react-day-picker";
import { lastNightOf, type BlockedRange } from "@sambung/shared";

const pad = (n: number) => String(n).padStart(2, "0");

/** A local `Date` (midnight) -> `YYYY-MM-DD`, read off the local fields so it is
 * the day the guest sees, not a UTC slice that can slip across a timezone. */
export function dateToIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `YYYY-MM-DD` -> a local `Date` at midnight. `new Date(y, m, d)` is local by
 * construction (unlike `new Date("2026-08-15")`, which is parsed as UTC). */
export function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The half-open window covering the calendar month that `month` falls in:
 * `[first-of-month, first-of-next-month)`. This is what the picker queries to
 * grey out booked nights across the whole visible grid (api-spec §5.1, mode 1).
 * Always < 32 nights, so comfortably inside the endpoint's 366-night cap.
 */
export function monthWindow(month: Date): { from: string; to: string } {
  const y = month.getFullYear();
  const m = month.getMonth(); // 0-based
  const from = `${y}-${pad(m + 1)}-01`;
  const ny = m === 11 ? y + 1 : y;
  const nm = m === 11 ? 0 : m + 1;
  const to = `${ny}-${pad(nm + 1)}-01`;
  return { from, to };
}

/**
 * Occupying `[from, to)` ranges -> react-day-picker INCLUSIVE date-range
 * matchers. A booking's occupied nights are `from .. to-1` (the checkout day is
 * free - the changeover), so the last greyed day is `addDays(to, -1)`. A
 * one-night block `[X, X+1)` collapses to the single day `X`.
 *
 * These drive a `blocked` MODIFIER, not the `disabled` prop: a booked night is
 * shown but still clickable, so a selection that spans one produces the server's
 * `overlap` verdict rather than being silently un-pickable. The server's quote is
 * the single authority on "taken" (invariant #5); the calendar only advises.
 */
export function blockedMatchers(ranges: readonly BlockedRange[]): DateRange[] {
  return ranges.map((r) => ({
    from: isoToDate(r.from),
    to: isoToDate(lastNightOf(r)),
  }));
}

/** The `disabled` matcher for past days: everything strictly before local today
 * (FR-CAL-1). Today itself stays selectable as a check-in. */
export function pastDisabled(todayIso: string): { before: Date } {
  return { before: isoToDate(todayIso) };
}

/**
 * The month the picker should open on: the selection's check-in if it is in the
 * future, otherwise today. Guards against a stale shared link (`?from` in the
 * past) opening the grid on a month the guest can no longer book into.
 */
export function initialMonth(from: string | undefined, todayIso: string): Date {
  return isoToDate(from && from > todayIso ? from : todayIso);
}

/** A URL `?from&to` -> the picker's `selected` range. `to` may be absent (a
 * half-made selection - one click), which react-day-picker renders as a single
 * highlighted day. */
export function rangeFromSearch(
  from: string | undefined,
  to: string | undefined,
): DateRange | undefined {
  if (!from) return undefined;
  return { from: isoToDate(from), to: to ? isoToDate(to) : undefined };
}

/**
 * The picker's `selected` range -> a bookable stay, or null. A stay needs a
 * check-out strictly after check-in (at least one night); a lone day or a
 * same-day range is "not done picking yet", so no quote fires. `from`/`to` map
 * straight through as check-in/check-out - the endpoints of a react-day-picker
 * range ARE the check-in and check-out days (the Airbnb convention).
 */
export function stayFromRange(
  range: DateRange | undefined,
): { from: string; to: string } | null {
  if (!range?.from || !range?.to) return null;
  const from = dateToIso(range.from);
  const to = dateToIso(range.to);
  return to > from ? { from, to } : null;
}

/** True when two stays are the same (or both null) - used to tell whether the
 * debounced quote has caught up with the live selection. */
export function sameStay(
  a: { from: string; to: string } | null,
  b: { from: string; to: string } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.from === b.from && a.to === b.to;
}
