import { describe, expect, it } from "vitest";
import {
  DEMO_FREE_NIGHTS,
  DEMO_STAY_KEYS,
  DEMO_STAY_UNIT,
  DEMO_UNIT_MIN_STAY,
  demoDates,
  MAX_START_OFFSET,
  type DemoStay,
} from "../scripts/demo-dates";

/**
 * The seed's date model (#60). Pure - no database, no clock of its own: every
 * case passes its own `today`, so a bug that only shows up on the 28th of a
 * 31-day month is reproducible instead of seasonal.
 *
 * What these guard is the demo script's premise: a reviewer runs `db:reset`,
 * opens the dashboard and then the funnel, and the state the script describes is
 * on screen. Two ways that fails, both silent:
 *
 *   1. A stay in the PAST. The picker hard-disables it (ADR-0013) and the .ics
 *      export skips it, so it is invisible rather than merely stale.
 *   2. A stay outside the CURRENT MONTH. `/app/calendar` opens on the current
 *      month and is the demo's first screen, so a stay a fortnight out is off
 *      it for the back half of every month.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Half-open `[checkIn, checkOut)` overlap - the same rule the DB constraint uses. */
const overlaps = (a: DemoStay, b: DemoStay): boolean =>
  a.checkIn < b.checkOut && b.checkIn < a.checkOut;

/** Nights between two ISO dates. Both are midnight-anchored, so this is exact. */
const nights = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
  86_400_000;

const isoOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * 400 consecutive days: every month length, both sides of a leap day, and both
 * sides of a DST switch in the local zone. A month-relative or local-midnight
 * anchor breaks on at least one of them.
 */
const everyDayOfAYear = (): Date[] => {
  const days: Date[] = [];
  for (let i = 0; i < 400; i++) {
    days.push(new Date(2027, 0, 1 + i, 13, 45, 12));
  }
  return days;
};

/** The last calendar day of `d`'s month. */
const lastDayOfMonth = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

describe("demoDates", () => {
  const today = new Date(2027, 2, 19, 9, 0, 0); // 2027-03-19, local

  it("returns ISO calendar dates, not timestamps", () => {
    const d = demoDates(today);
    for (const key of DEMO_STAY_KEYS) {
      expect(d[key].checkIn, key).toMatch(ISO);
      expect(d[key].checkOut, key).toMatch(ISO);
    }
    expect(d.firstFreeNight).toMatch(ISO);
  });

  it("puts every seeded stay in the future, on every day of the year", () => {
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      const todayIso = isoOf(day);
      for (const key of DEMO_STAY_KEYS) {
        expect(
          d[key].checkIn > todayIso,
          `${key} check-in ${d[key].checkIn} is not after ${todayIso}`,
        ).toBe(true);
      }
      expect(d.firstFreeNight > todayIso).toBe(true);
    }
  });

  it("starts every stay within MAX_START_OFFSET days, so the opening calendar screen is populated", () => {
    // /app/calendar opens on the current MONTH. Nothing can put a future stay
    // inside a month that has no future days left, so the guarantee is stated in
    // days-from-today and the month consequence is derived in the next test.
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      const todayIso = isoOf(day);
      for (const key of DEMO_STAY_KEYS) {
        expect(
          nights(todayIso, d[key].checkIn),
          `${key} starts ${nights(todayIso, d[key].checkIn)} days out`,
        ).toBeLessThanOrEqual(MAX_START_OFFSET);
      }
    }
  });

  it("puts EVERY stay inside the current month whenever a week of it remains", () => {
    // The property the previous test buys, stated the way the demo experiences
    // it: `db:reset` on the 1st through (last - MAX_START_OFFSET) of any month
    // opens with every seeded bar on screen, including the airbnb and
    // manual_block ones the "coloured by source" beat needs.
    for (const day of everyDayOfAYear()) {
      if (day.getDate() > lastDayOfMonth(day) - MAX_START_OFFSET) continue;
      const d = demoDates(day);
      const monthPrefix = isoOf(day).slice(0, 7);
      for (const key of DEMO_STAY_KEYS) {
        expect(
          d[key].checkIn.slice(0, 7),
          `${key} starts ${d[key].checkIn}, outside ${monthPrefix}`,
        ).toBe(monthPrefix);
      }
    }
  });

  it("keeps every stay at least as long as its unit's min_stay", () => {
    // A seeded stay shorter than min_stay is a row the product's own booking
    // rules would have refused - the demo would be showing an impossible state.
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      for (const key of DEMO_STAY_KEYS) {
        const min = DEMO_UNIT_MIN_STAY[DEMO_STAY_UNIT[key]];
        expect(
          nights(d[key].checkIn, d[key].checkOut),
          `${key} is shorter than ${DEMO_STAY_UNIT[key]}'s min_stay of ${min}`,
        ).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it("never overlaps two stays in the same unit (booking_no_overlap would refuse the seed)", () => {
    // Every pair that actually became a row, joined on unit - not just the pair
    // that happens to share a unit today.
    const booked = DEMO_STAY_KEYS.filter((k) => k !== "refusedImport");
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      for (const a of booked) {
        for (const b of booked) {
          if (a >= b) continue;
          if (DEMO_STAY_UNIT[a] !== DEMO_STAY_UNIT[b]) continue;
          expect(
            overlaps(d[a], d[b]),
            `${a} ${d[a].checkIn}->${d[a].checkOut} overlaps ${b} ${d[b].checkIn}->${d[b].checkOut}`,
          ).toBe(false);
        }
      }
    }
  });

  it("makes the refused import overlap the direct stay PARTIALLY, and nothing else", () => {
    // The sync conflict's whole point is that the exclusion constraint refused
    // an OTA event because those nights were already sold direct (ADR-0027).
    // Identical ranges would let a bug that conflates the two go unnoticed in
    // the inbox; a partial overlap makes the inbox prove it renders both. And it
    // must block on exactly ONE booking, or the script's "here is the booking in
    // the way" becomes a list the presenter has to explain away.
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      expect(overlaps(d.refusedImport, d.villaDirect)).toBe(true);
      expect(d.refusedImport.checkIn).not.toBe(d.villaDirect.checkIn);
      expect(d.refusedImport.checkOut).not.toBe(d.villaDirect.checkOut);
      expect(overlaps(d.refusedImport, d.villaImported)).toBe(false);
    }
  });

  it("leaves a bookable gap on the Whole Villa, greyed on both sides", () => {
    // The script's fallback and the picker beat both need somewhere on the
    // SEEDED villa a guest can actually book: DEMO_FREE_NIGHTS long (that unit's
    // own min_stay), touching neither villa stay.
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      const gap: DemoStay = {
        checkIn: d.firstFreeNight,
        checkOut: new Date(
          Date.parse(`${d.firstFreeNight}T00:00:00Z`) +
            DEMO_FREE_NIGHTS * 86_400_000,
        )
          .toISOString()
          .slice(0, 10),
      };
      expect(nights(gap.checkIn, gap.checkOut)).toBeGreaterThanOrEqual(
        DEMO_UNIT_MIN_STAY.wholeVilla,
      );
      expect(
        overlaps(gap, d.villaDirect),
        "gap collides with villaDirect",
      ).toBe(false);
      expect(
        overlaps(gap, d.villaImported),
        "gap collides with villaImported",
      ).toBe(false);
    }
  });

  it("is a pure function of the calendar day, not the time of day", () => {
    const morning = demoDates(new Date(2027, 5, 8, 0, 30, 0));
    const evening = demoDates(new Date(2027, 5, 8, 23, 30, 0));
    expect(morning).toEqual(evening);
  });
});
