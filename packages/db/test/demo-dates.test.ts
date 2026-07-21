import { describe, expect, it } from "vitest";
import {
  DEMO_STAY_KEYS,
  demoDates,
  type DemoStay,
} from "../scripts/demo-dates";

/**
 * The seed's date model (#60). Pure - no database, no clock of its own: every
 * case passes its own `today`, so a bug that only shows up on the 28th of a
 * 31-day month is reproducible instead of seasonal.
 *
 * What these guard is the demo script's premise: a reviewer runs `db:reset`,
 * opens the funnel, and every seeded stay is still ahead of them. The picker
 * hard-disables the past (ADR-0013) and the .ics export serves current+future
 * confirmed stays only, so a seeded stay in the past is not merely stale - it
 * is INVISIBLE, and three of the demo's beats quietly show nothing.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Half-open `[checkIn, checkOut)` overlap - the same rule the DB constraint uses. */
const overlaps = (a: DemoStay, b: DemoStay): boolean =>
  a.checkIn < b.checkOut && b.checkIn < a.checkOut;

/** Nights between two ISO dates. Both are midnight-anchored, so this is exact. */
const nights = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
  86_400_000;

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
      const todayIso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      for (const key of DEMO_STAY_KEYS) {
        expect(
          d[key].checkIn > todayIso,
          `${key} check-in ${d[key].checkIn} is not after ${todayIso}`,
        ).toBe(true);
      }
      expect(d.firstFreeNight > todayIso).toBe(true);
    }
  });

  it("keeps every stay half-open and at least one night long", () => {
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      for (const key of DEMO_STAY_KEYS) {
        expect(nights(d[key].checkIn, d[key].checkOut), key).toBeGreaterThan(0);
      }
    }
  });

  it("never overlaps two stays in the same unit (booking_no_overlap would refuse the seed)", () => {
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      // The Whole Villa is the only unit the seed books twice.
      expect(
        overlaps(d.villaDirect, d.villaImported),
        `${d.villaDirect.checkIn} vs ${d.villaImported.checkIn}`,
      ).toBe(false);
    }
  });

  it("makes the refused import overlap the direct stay PARTIALLY", () => {
    // The sync conflict's whole point is that the exclusion constraint refused
    // an OTA event because those nights were already sold direct (ADR-0027).
    // Identical ranges would let a bug that conflates the two go unnoticed in
    // the inbox; a partial overlap makes the inbox prove it renders both.
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      expect(overlaps(d.refusedImport, d.villaDirect)).toBe(true);
      expect(d.refusedImport.checkIn).not.toBe(d.villaDirect.checkIn);
      expect(d.refusedImport.checkOut).not.toBe(d.villaDirect.checkOut);
    }
  });

  it("leaves the demo guest a free window long enough for the Whole Villa's 2-night minimum", () => {
    // The script has the guest book from `firstFreeNight`; the first seeded
    // Whole Villa stay must not sit on top of it, or step 2 of the demo 409s.
    for (const day of everyDayOfAYear()) {
      const d = demoDates(day);
      expect(
        nights(d.firstFreeNight, d.villaDirect.checkIn),
        `only ${nights(d.firstFreeNight, d.villaDirect.checkIn)} free nights`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("is a pure function of the calendar day, not the time of day", () => {
    const morning = demoDates(new Date(2027, 5, 8, 0, 30, 0));
    const evening = demoDates(new Date(2027, 5, 8, 23, 30, 0));
    expect(morning).toEqual(evening);
  });
});
