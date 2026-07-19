import { describe, expect, it } from "vitest";
import {
  toRupiah,
  type BookingRow,
  type PropertyResponse,
  type UnitResponse,
} from "@sambung/shared";
import {
  composeRows,
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
  it("no dates = no window, no error (all time)", () => {
    expect(resolveWindow(undefined, undefined)).toEqual({
      window: undefined,
      error: null,
    });
  });

  it("a lone edge never becomes a window - it is a hint, not a 400", () => {
    // The API 400s a lone from/to; the client must not send one.
    expect(resolveWindow("2027-03-01", undefined).window).toBeUndefined();
    expect(resolveWindow("2027-03-01", undefined).error).toMatch(/both/i);
    expect(resolveWindow(undefined, "2027-03-01").window).toBeUndefined();
    expect(resolveWindow(undefined, "2027-03-01").error).toMatch(/both/i);
  });

  it("rejects an inverted or empty range", () => {
    expect(resolveWindow("2027-03-10", "2027-03-10").window).toBeUndefined();
    expect(resolveWindow("2027-03-10", "2027-03-01").error).toMatch(/after/i);
  });

  it("rejects a window past the 366-night cap", () => {
    // 2027-01-01 -> 2028-02-01 is 396 nights, over the shared availability cap.
    const r = resolveWindow("2027-01-01", "2028-02-01");
    expect(r.window).toBeUndefined();
    expect(r.error).toMatch(/366/);
  });

  it("passes a legal pair through", () => {
    expect(resolveWindow("2027-03-01", "2027-04-01")).toEqual({
      window: { from: "2027-03-01", to: "2027-04-01" },
      error: null,
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
