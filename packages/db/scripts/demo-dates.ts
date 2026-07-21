/**
 * The seed's date model - the calendar the demo script walks through (#60).
 *
 * Anchored to TODAY, not to fixed calendar dates and not to the day-of-month.
 * The reason is not tidiness: the funnel's picker hard-disables the past
 * (ADR-0013), the .ics export serves current and future confirmed stays, and a
 * "live" 15-minute hold on nights that already happened reads as a bug. A stay
 * seeded in the past is not stale, it is INVISIBLE - so three beats of the demo
 * silently show an empty screen. Anchoring forward makes `db:reset` open in
 * demo-ready state on any day of any month.
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
  /** The first night the demo guest can book on the Whole Villa. */
  firstFreeNight: string;
}

/** Every stay in `DemoDates`, for callers that want to walk them all. */
export const DEMO_STAY_KEYS = [
  "villaDirect",
  "villaImported",
  "gardenHold",
  "surfBlock",
  "riverDirect",
  "refusedImport",
] as const satisfies readonly (keyof DemoDates)[];

/**
 * Day offsets, gathered here so the shape of the demo calendar is readable in
 * one glance - and so the constraints between them (no two Whole Villa stays
 * overlap; the refused import overlaps the direct one only PARTIALLY; the guest
 * has at least the Whole Villa's 2-night minimum free ahead of everything) are
 * visible rather than scattered through the seed.
 */
const OFFSETS = {
  firstFreeNight: 1,
  villaDirect: [7, 11],
  refusedImport: [8, 12],
  villaImported: [16, 20],
  gardenHold: [9, 12],
  surfBlock: [20, 23],
  riverDirect: [11, 14],
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
