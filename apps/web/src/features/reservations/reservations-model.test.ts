import { describe, expect, it } from "vitest";
import {
  countNights,
  MAX_AVAILABILITY_NIGHTS,
  toRupiah,
  type BookingRow,
  type PropertyResponse,
  type UnitResponse,
} from "@sambung/shared";
import {
  composeRows,
  defaultWindow,
  hasActiveFilters,
  resolveWindow,
} from "./reservations-model";
import type { ReservationsSearch } from "./reservations-search";

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

const search = (over: Partial<ReservationsSearch> = {}): ReservationsSearch => ({
  from: undefined,
  to: undefined,
  propertyId: undefined,
  status: undefined,
  source: undefined,
  ...over,
});

// --- resolveWindow ----------------------------------------------------------

describe("resolveWindow", () => {
  const TODAY = "2027-03-15";
  const upcoming = defaultWindow(TODAY);

  it("the upcoming window starts today and spans exactly the 366-night cap", () => {
    expect(upcoming.from).toBe(TODAY);
    expect(countNights(upcoming.from, upcoming.to)).toBe(
      MAX_AVAILABILITY_NIGHTS,
    );
  });

  it("no dates = the default upcoming window", () => {
    expect(resolveWindow(undefined, undefined, TODAY)).toEqual({
      window: upcoming,
      error: null,
      isDefault: true,
    });
  });

  it("a lone edge falls back to upcoming (never sent as a 400) with a pair hint", () => {
    // The API 400s a lone from/to; the client sends the default pair instead.
    const r = resolveWindow("2027-03-01", undefined, TODAY);
    expect(r.window).toEqual(upcoming);
    expect(r.isDefault).toBe(true);
    expect(r.error).toMatch(/both/i);
    expect(resolveWindow(undefined, "2027-03-01", TODAY).error).toMatch(/both/i);
  });

  it("an inverted or over-cap range falls back to upcoming with a hint", () => {
    const inverted = resolveWindow("2027-03-10", "2027-03-01", TODAY);
    expect(inverted.window).toEqual(upcoming);
    expect(inverted.error).toMatch(/after/i);
    // 2027-01-01 -> 2028-02-01 is 396 nights, over the shared availability cap.
    const overCap = resolveWindow("2027-01-01", "2028-02-01", TODAY);
    expect(overCap.window).toEqual(upcoming);
    expect(overCap.error).toMatch(/366/);
  });

  it("passes a legal custom pair through, marked not-default", () => {
    expect(resolveWindow("2027-03-01", "2027-04-01", TODAY)).toEqual({
      window: { from: "2027-03-01", to: "2027-04-01" },
      error: null,
      isDefault: false,
    });
  });
});

// --- hasActiveFilters -------------------------------------------------------

describe("hasActiveFilters", () => {
  it("is false with no filters (the empty-tenant switch)", () => {
    expect(hasActiveFilters(search())).toBe(false);
  });

  it("treats an empty status array as no filter", () => {
    expect(hasActiveFilters(search({ status: [] }))).toBe(false);
  });

  it("is true for any set filter, including a lone from", () => {
    expect(hasActiveFilters(search({ from: "2027-03-01" }))).toBe(true);
    expect(hasActiveFilters(search({ propertyId: "p1" }))).toBe(true);
    expect(hasActiveFilters(search({ status: ["confirmed"] }))).toBe(true);
    expect(hasActiveFilters(search({ source: ["airbnb"] }))).toBe(true);
  });
});

// --- composeRows ------------------------------------------------------------

describe("composeRows", () => {
  it("joins each booking to its unit and property names, in server order", () => {
    const rows = composeRows(
      [bk({ id: "b1", checkIn: "2027-03-10" }), bk({ id: "b2", checkIn: "2027-03-20" })],
      [unit()],
      [prop()],
    );
    expect(rows.map((r) => r.booking.id)).toEqual(["b1", "b2"]);
    expect(rows[0]).toMatchObject({ unitName: "Room", propertyName: "Villa" });
  });

  it("drops a booking whose unit is unknown rather than crashing", () => {
    const rows = composeRows([bk({ unitId: "ghost" })], [unit()], [prop()]);
    expect(rows).toHaveLength(0);
  });

  it("falls back to an em dash when the property is missing", () => {
    const rows = composeRows([bk()], [unit()], []);
    expect(rows[0].propertyName).toBe("—");
  });
});
