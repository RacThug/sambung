import { describe, expect, it } from "vitest";
import {
  MAX_AVAILABILITY_NIGHTS,
  availabilityQuerySchema,
  coalesceRanges,
  countNights,
  meetsMinStay,
  quoteTotalIdr,
  type BlockedRange,
} from "../src/availability";

describe("countNights (half-open, db-design §4.2)", () => {
  it("counts the check-out day as free, not a night", () => {
    // [10, 14) is 4 nights: the guest sleeps 10, 11, 12, 13 and leaves on 14.
    expect(countNights("2026-08-10", "2026-08-14")).toBe(4);
    expect(countNights("2026-08-10", "2026-08-11")).toBe(1);
  });

  it("survives a DST boundary without gaining or losing a night", () => {
    // Parsed at UTC midnight, so a local clock change can't round the division
    // wrong. This span crosses a northern-hemisphere DST change either way.
    expect(countNights("2026-03-01", "2026-04-01")).toBe(31);
    expect(countNights("2026-10-01", "2026-11-01")).toBe(31);
  });

  it("counts across a month and a leap day", () => {
    expect(countNights("2028-02-28", "2028-03-01")).toBe(2); // 2028 is a leap year
    expect(countNights("2026-02-28", "2026-03-01")).toBe(1);
  });
});

describe("quoteTotalIdr (v1 pricing rule)", () => {
  it("is base price times nights, in bigint rupiah", () => {
    expect(quoteTotalIdr(3_500_000n, 4)).toBe(14_000_000n);
    expect(quoteTotalIdr(0n, 4)).toBe(0n); // placeholder unit quotes at zero
  });

  it("stays exact well past the safe-number range (that's why it's bigint)", () => {
    // The product can exceed MAX_SAFE_INTEGER before toRupiah range-checks it at
    // the boundary; number math would have rounded here.
    expect(quoteTotalIdr(9_000_000_000_000_000n, 3)).toBe(27_000_000_000_000_000n);
  });
});

describe("meetsMinStay", () => {
  it("passes only when nights reaches the minimum", () => {
    expect(meetsMinStay(2, 2)).toBe(true);
    expect(meetsMinStay(3, 2)).toBe(true);
    expect(meetsMinStay(1, 2)).toBe(false);
  });
});

describe("coalesceRanges (merge maximal, leak no seam)", () => {
  const r = (from: string, to: string): BlockedRange => ({ from, to });

  it("merges the changeover seam between two contiguous bookings", () => {
    // [10,13) then [13,16): they touch on the 13th and must come back as ONE
    // range, so a Visitor cannot read the checkout/check-in boundary off it.
    expect(coalesceRanges([r("2026-08-10", "2026-08-13"), r("2026-08-13", "2026-08-16")])).toEqual([
      r("2026-08-10", "2026-08-16"),
    ]);
  });

  it("keeps a real gap between separate bookings", () => {
    expect(
      coalesceRanges([r("2026-08-10", "2026-08-13"), r("2026-08-20", "2026-08-22")]),
    ).toEqual([r("2026-08-10", "2026-08-13"), r("2026-08-20", "2026-08-22")]);
  });

  it("is order-independent and merges overlaps", () => {
    // Fed out of order and overlapping; the merged result is the same either way.
    expect(
      coalesceRanges([
        r("2026-08-20", "2026-08-22"),
        r("2026-08-10", "2026-08-14"),
        r("2026-08-12", "2026-08-16"),
      ]),
    ).toEqual([r("2026-08-10", "2026-08-16"), r("2026-08-20", "2026-08-22")]);
  });

  it("handles the empty and single cases without mutating the input", () => {
    expect(coalesceRanges([])).toEqual([]);
    const one = [r("2026-08-10", "2026-08-13")];
    const out = coalesceRanges(one);
    expect(out).toEqual(one);
    expect(out[0]).not.toBe(one[0]); // a fresh object, safe for the caller to mutate
  });
});

describe("availabilityQuerySchema", () => {
  it("accepts a valid half-open window", () => {
    expect(availabilityQuerySchema.parse({ from: "2026-08-10", to: "2026-08-14" })).toMatchObject({
      from: "2026-08-10",
      to: "2026-08-14",
    });
  });

  it("rejects from >= to", () => {
    expect(() => availabilityQuerySchema.parse({ from: "2026-08-14", to: "2026-08-10" })).toThrow();
    expect(() => availabilityQuerySchema.parse({ from: "2026-08-10", to: "2026-08-10" })).toThrow();
  });

  it("rejects a window over the night cap but accepts exactly the cap", () => {
    const from = "2026-01-01";
    // Exactly MAX nights passes; one more fails - the boundary, proven both sides.
    expect(
      availabilityQuerySchema.parse({ from, to: addNights(from, MAX_AVAILABILITY_NIGHTS) }),
    ).toMatchObject({ from });
    expect(() =>
      availabilityQuerySchema.parse({ from, to: addNights(from, MAX_AVAILABILITY_NIGHTS + 1) }),
    ).toThrow();
  });

  it("rejects a non-calendar date a bare regex would wave through", () => {
    // 2026-02-30 is well-formed but not a real day; z.string().date() catches it
    // so it never reaches Postgres as an unmapped 22008.
    expect(() => availabilityQuerySchema.parse({ from: "2026-02-30", to: "2026-03-05" })).toThrow();
    expect(() => availabilityQuerySchema.parse({ from: "2026-13-01", to: "2026-13-05" })).toThrow();
  });

  it("accepts an optional lang and ignores everything else", () => {
    expect(
      availabilityQuerySchema.parse({ from: "2026-08-10", to: "2026-08-14", lang: "id" }),
    ).toMatchObject({ lang: "id" });
    expect(() =>
      availabilityQuerySchema.parse({ from: "2026-08-10", to: "2026-08-14", lang: "fr" }),
    ).toThrow();
  });
});

/** Add `nights` days to a YYYY-MM-DD date (test helper, UTC). */
function addNights(from: string, nights: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + nights);
  return d.toISOString().slice(0, 10);
}
