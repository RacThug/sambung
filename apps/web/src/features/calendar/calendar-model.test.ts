import { describe, expect, it } from "vitest";
import {
  toRupiah,
  type BookingRow,
  type PropertyResponse,
  type UnitResponse,
} from "@sambung/shared";
import {
  addDays,
  barSpan,
  buildCalendar,
  currentMonthWindow,
  isEmptyCalendar,
  shiftMonth,
  windowDays,
} from "./calendar-model";

// --- fixtures ---------------------------------------------------------------

const prop = (over: Partial<PropertyResponse> = {}): PropertyResponse => ({
  id: "p1",
  tenantId: "t1",
  name: "Villa",
  slug: "villa",
  address: null,
  latitude: null,
  longitude: null,
  description: null,
  licenseNo: null,
  depositPct: 100,
  timeZone: "Asia/Makassar",
  photos: [],
  verified: false,
  publishable: false,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const unit = (over: Partial<UnitResponse> = {}): UnitResponse => ({
  id: "u1",
  propertyId: "p1",
  tenantId: "t1",
  name: "Room",
  basePriceIdr: toRupiah(1_000_000n),
  maxGuests: 2,
  minStay: 1,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const bk = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: "b1",
  unitId: "u1",
  source: "direct",
  status: "confirmed",
  checkIn: "2027-03-10",
  checkOut: "2027-03-14",
  guestName: "Made A.",
  guestCount: 2,
  holdExpiresAt: null,
  totalPriceIdr: toRupiah(4_000_000n),
  ...over,
});

// --- dates & window ---------------------------------------------------------

describe("window helpers", () => {
  it("addDays crosses month/year boundaries", () => {
    expect(addDays("2027-03-10", 4)).toBe("2027-03-14");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("currentMonthWindow is the half-open month", () => {
    expect(currentMonthWindow("2027-03-19")).toEqual({
      from: "2027-03-01",
      to: "2027-04-01",
    });
    // December rolls the year.
    expect(currentMonthWindow("2027-12-05")).toEqual({
      from: "2027-12-01",
      to: "2028-01-01",
    });
  });

  it("shiftMonth steps whole months and normalises a free range to a month", () => {
    const w = { from: "2027-03-14", to: "2027-03-20" }; // arbitrary range
    expect(shiftMonth(w, 1)).toEqual({ from: "2027-04-01", to: "2027-05-01" });
    expect(shiftMonth({ from: "2027-01-01", to: "2027-02-01" }, -1)).toEqual({
      from: "2026-12-01",
      to: "2027-01-01",
    });
  });

  it("windowDays yields one column per day, with weekends flagged", () => {
    const days = windowDays("2027-03-01", "2027-03-08"); // 7 days
    expect(days).toHaveLength(7);
    expect(days[0].dom).toBe(1);
    // 2027-03-06 is a Saturday, 2027-03-07 a Sunday.
    expect(days.find((d) => d.date === "2027-03-06")?.isWeekend).toBe(true);
    expect(days.find((d) => d.date === "2027-03-03")?.isWeekend).toBe(false);
  });
});

// --- bar geometry -----------------------------------------------------------

describe("barSpan", () => {
  const w = { from: "2027-03-01", to: "2027-04-01" }; // 31 columns

  it("places a stay fully inside the window", () => {
    // [03-10, 03-14): columns 9..13 (4 nights)
    expect(barSpan(w, "2027-03-10", "2027-03-14")).toEqual({
      start: 9,
      end: 13,
      continuesLeft: false,
      continuesRight: false,
    });
  });

  it("clips a stay running off the left edge and flags continuesLeft", () => {
    const span = barSpan(w, "2027-02-25", "2027-03-05");
    expect(span).toEqual({
      start: 0,
      end: 4,
      continuesLeft: true,
      continuesRight: false,
    });
  });

  it("clips a stay running off the right edge and flags continuesRight", () => {
    const span = barSpan(w, "2027-03-28", "2027-05-01");
    expect(span).toEqual({
      start: 27,
      end: 31,
      continuesLeft: false,
      continuesRight: true,
    });
  });

  it("clips a stay covering the whole window on both sides", () => {
    expect(barSpan(w, "2027-01-01", "2027-06-01")).toEqual({
      start: 0,
      end: 31,
      continuesLeft: true,
      continuesRight: true,
    });
  });

  it("returns null for a stay that only touches the window edge (changeover)", () => {
    // ends exactly at the window start - half-open, no overlap.
    expect(barSpan(w, "2027-02-20", "2027-03-01")).toBeNull();
    // starts exactly at the window end.
    expect(barSpan(w, "2027-04-01", "2027-04-05")).toBeNull();
  });
});

// --- composition ------------------------------------------------------------

describe("buildCalendar", () => {
  it("gives every active unit a row, even with no bookings", () => {
    const groups = buildCalendar({
      properties: [prop()],
      units: [unit({ id: "u1", name: "Room A" })],
      bookings: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].bookings).toEqual([]);
    expect(groups[0].rows[0].archived).toBe(false);
  });

  it("drops an archived-and-empty unit, keeps an archived unit that has a booking", () => {
    const groups = buildCalendar({
      properties: [prop()],
      units: [
        unit({ id: "u1", name: "Empty Retired", archivedAt: "2026-07-01T00:00:00Z" }),
        unit({ id: "u2", name: "Booked Retired", archivedAt: "2026-07-01T00:00:00Z" }),
      ],
      bookings: [bk({ id: "b1", unitId: "u2" })],
    });
    const rows = groups[0].rows;
    expect(rows.map((r) => r.unit.id)).toEqual(["u2"]);
    expect(rows[0].archived).toBe(true);
  });

  it("treats a unit under an archived property as effectively archived", () => {
    const groups = buildCalendar({
      properties: [prop({ id: "p1", archivedAt: "2026-07-01T00:00:00Z" })],
      units: [unit({ id: "u1", propertyId: "p1", archivedAt: null })],
      bookings: [], // empty + effectively archived -> dropped
    });
    expect(groups).toEqual([]);
    expect(isEmptyCalendar(groups)).toBe(true);
  });

  it("drops a property with no visible rows, keeps grouping and sorts by name", () => {
    const groups = buildCalendar({
      properties: [
        prop({ id: "pB", name: "Beta" }),
        prop({ id: "pA", name: "Alpha" }),
        prop({ id: "pEmpty", name: "Zeta", archivedAt: "2026-07-01T00:00:00Z" }),
      ],
      units: [
        unit({ id: "uB", propertyId: "pB", name: "b" }),
        unit({ id: "uA", propertyId: "pA", name: "a" }),
        unit({ id: "uZ", propertyId: "pEmpty", name: "z" }), // archived+empty -> gone
      ],
      bookings: [],
    });
    // Zeta drops (its only unit is archived+empty); Alpha before Beta.
    expect(groups.map((g) => g.property.name)).toEqual(["Alpha", "Beta"]);
  });

  it("narrows the grid to a single property when propertyId is set", () => {
    // Regression: the filter must drop OTHER properties' rows, not just their
    // bookings - otherwise a filtered view draws them as misleading empty rows.
    const groups = buildCalendar({
      properties: [
        prop({ id: "pA", name: "Alpha" }),
        prop({ id: "pB", name: "Beta" }),
      ],
      units: [
        unit({ id: "uA", propertyId: "pA", name: "a" }),
        unit({ id: "uB", propertyId: "pB", name: "b" }),
      ],
      bookings: [],
      propertyId: "pA",
    });
    expect(groups.map((g) => g.property.id)).toEqual(["pA"]);
    expect(groups.flatMap((g) => g.rows.map((r) => r.unit.id))).toEqual(["uA"]);
  });

  it("groups every booking under its unit's row", () => {
    const groups = buildCalendar({
      properties: [prop()],
      units: [unit({ id: "u1" })],
      bookings: [
        bk({ id: "b1", unitId: "u1", checkIn: "2027-03-10", checkOut: "2027-03-14" }),
        bk({ id: "b2", unitId: "u1", checkIn: "2027-03-20", checkOut: "2027-03-22" }),
      ],
    });
    expect(groups[0].rows[0].bookings.map((b) => b.id)).toEqual(["b1", "b2"]);
  });
});
