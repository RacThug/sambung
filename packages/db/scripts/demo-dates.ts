/**
 * The seed's date model - the calendar the demo script walks through (#60).
 *
 * Anchored to TODAY, not to fixed calendar dates and not to the day-of-month.
 * The reason is not tidiness: the funnel's picker hard-disables the past
 * (ADR-0013), the .ics export serves current and future confirmed stays, and a
 * "live" 15-minute hold on nights that already happened reads as a bug. A stay
 * seeded in the past is not stale, it is INVISIBLE - so three beats of the demo
 * silently show an empty screen.
 *
 * Everything also sits WITHIN A WEEK of today, which is the second constraint
 * and the less obvious one. `/app/calendar` opens on the current calendar month
 * and is the demo's very first screen; a stay a fortnight out falls off it for
 * the whole back half of every month. Packing the stays into `[today+1,
 * today+8)` means that whenever a week of the month remains, every seeded bar -
 * including the airbnb and manual_block ones the "coloured by source" beat needs
 * - is on that opening screen. See MAX_START_OFFSET for what is still not
 * guaranteed, and why it cannot be.
 *
 * Offsets are whole days from today; every stay is half-open `[checkIn,
 * checkOut)`, the same shape as `booking.stay` (db-design §4.2).
 *
 * The date arithmetic runs in UTC over the LOCAL calendar day: `today` supplies
 * the presenter's y/m/d (the same day the browser's picker calls "today"), and
 * the day-stepping happens on a UTC midnight, where every day is exactly
 * 86,400s. Stepping a local-midnight Date instead would land on 23:00 or 01:00
 * across a DST switch, and `.slice(0, 10)` would silently drop or repeat a day.
 */

/** A half-open stay, exactly as the `booking` table stores it. */
export interface DemoStay {
  checkIn: string;
  checkOut: string;
}

/** The units the seed creates. Keys, not names, so the test can join on them. */
export type DemoUnitKey =
  | "wholeVilla"
  | "gardenRoom"
  | "surfLoft"
  | "riverSuite";

/**
 * Each demo unit's `min_stay`, and the SOURCE of the value the seed inserts -
 * so "every seeded stay is at least as long as its unit's minimum" is one fact
 * checked by one test, rather than two numbers in two files that agree today.
 */
export const DEMO_UNIT_MIN_STAY: Record<DemoUnitKey, number> = {
  wholeVilla: 2,
  gardenRoom: 1,
  surfLoft: 1,
  riverSuite: 2,
};

export interface DemoDates {
  /** Whole Villa - the confirmed, paid direct booking ("Wayan D."). */
  villaDirect: DemoStay;
  /** Whole Villa - a stay imported from the Airbnb feed. */
  villaImported: DemoStay;
  /** Garden Room - the live 15-minute hold ("Komang S."). */
  gardenHold: DemoStay;
  /** Surf Loft - a manual maintenance block. */
  surfBlock: DemoStay;
  /** Riverside Suite (the second tenant) - a confirmed direct booking. */
  riverDirect: DemoStay;
  /** The Airbnb event the exclusion constraint refused: the sync conflict. */
  refusedImport: DemoStay;
  /**
   * The first night of the free gap the seed leaves on the Whole Villa, between
   * its two stays. Exactly `DEMO_FREE_NIGHTS` long, which is exactly that unit's
   * `min_stay` - so it is bookable, and booking it greys nights on BOTH sides in
   * the picker.
   */
  firstFreeNight: string;
}

/** Which unit each stay belongs to. `refusedImport` never became a row. */
export const DEMO_STAY_UNIT: Record<
  Exclude<keyof DemoDates, "firstFreeNight">,
  DemoUnitKey
> = {
  villaDirect: "wholeVilla",
  villaImported: "wholeVilla",
  gardenHold: "gardenRoom",
  surfBlock: "surfLoft",
  riverDirect: "riverSuite",
  refusedImport: "wholeVilla",
};

/** Every stay in `DemoDates`, for callers that want to walk them all. */
export const DEMO_STAY_KEYS = Object.keys(
  DEMO_STAY_UNIT,
) as (keyof typeof DEMO_STAY_UNIT)[];

/** Nights in the free gap on the Whole Villa. Its `min_stay`, so it is bookable. */
export const DEMO_FREE_NIGHTS = DEMO_UNIT_MIN_STAY.wholeVilla;

/**
 * The latest day-offset at which any stay STARTS. The one number that decides
 * how much of the demo lands on the opening calendar screen: with this many days
 * left in the current month, every bar is visible.
 *
 * It cannot be driven to zero, and no choice of offsets makes "all future" and
 * "all inside the current month" both hold on the last day of a month - there
 * are no future days left in it. That residue is a calendar fact, not a bug; the
 * demo script names the next-month arrow for it.
 */
export const MAX_START_OFFSET = 6;

/**
 * Day offsets, gathered here so the shape of the demo calendar is readable in
 * one glance - and so the constraints between them are visible rather than
 * scattered through the seed. Each is asserted in test/demo-dates.test.ts:
 *
 *   - all future, on any "today"                    (the picker hides the past)
 *   - every start within MAX_START_OFFSET           (the opening calendar screen)
 *   - no two stays in one unit overlap              (booking_no_overlap would refuse the seed)
 *   - every stay >= its unit's min_stay             (DEMO_UNIT_MIN_STAY)
 *   - refusedImport overlaps villaDirect PARTIALLY  (the inbox conflict)
 *   - refusedImport overlaps ONLY villaDirect       (so the inbox names one blocker)
 *   - a DEMO_FREE_NIGHTS gap on the Whole Villa     (something there is bookable)
 */
const OFFSETS = {
  villaDirect: [1, 4],
  refusedImport: [2, 5],
  gardenHold: [2, 4],
  surfBlock: [3, 6],
  firstFreeNight: 4,
  villaImported: [6, 8],
  riverDirect: [4, 7],
} as const;

export function demoDates(today: Date): DemoDates {
  const base = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const at = (offset: number): string =>
    new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
  const stay = ([from, to]: readonly [number, number]): DemoStay => ({
    checkIn: at(from),
    checkOut: at(to),
  });

  return {
    villaDirect: stay(OFFSETS.villaDirect),
    villaImported: stay(OFFSETS.villaImported),
    gardenHold: stay(OFFSETS.gardenHold),
    surfBlock: stay(OFFSETS.surfBlock),
    riverDirect: stay(OFFSETS.riverDirect),
    refusedImport: stay(OFFSETS.refusedImport),
    firstFreeNight: at(OFFSETS.firstFreeNight),
  };
}
