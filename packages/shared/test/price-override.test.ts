import { describe, expect, it } from "vitest";
import { MAX_NIGHTLY_RATE_IDR } from "../src/unit";
import {
  createPriceOverrideRequestSchema,
  priceOverrideResponseSchema,
} from "../src/price-override";

const valid = {
  from: "2026-12-20",
  to: "2027-01-05",
  nightlyPriceIdr: 2_500_000,
};

describe("createPriceOverrideRequestSchema", () => {
  it("accepts a half-open range with a positive nightly price", () => {
    expect(createPriceOverrideRequestSchema.parse(valid)).toEqual(valid);
  });

  it("rejects from >= to - the range is half-open, so equal means zero nights", () => {
    expect(() =>
      createPriceOverrideRequestSchema.parse({
        ...valid,
        to: valid.from,
      }),
    ).toThrow();
    expect(() =>
      createPriceOverrideRequestSchema.parse({
        ...valid,
        from: "2027-02-01",
      }),
    ).toThrow();
  });

  it("rejects an impossible calendar date, not just a malformed one", () => {
    // A bare regex waves 2026-02-30 through and Postgres answers 22008 - an
    // unmapped 500. z.string().date() is the boundary that keeps it a 400.
    expect(() =>
      createPriceOverrideRequestSchema.parse({ ...valid, from: "2026-02-30" }),
    ).toThrow();
  });

  it("rejects a zero price - unlike basePriceIdr, an override has no placeholder role", () => {
    expect(() =>
      createPriceOverrideRequestSchema.parse({ ...valid, nightlyPriceIdr: 0 }),
    ).toThrow();
  });

  // Layer 1 of the "rejected twice over" pair; layer 2 is the
  // price_override_nightly_range DB CHECK with zod bypassed entirely.
  it("caps the nightly price at the same ceiling as the base price", () => {
    expect(
      createPriceOverrideRequestSchema.parse({
        ...valid,
        nightlyPriceIdr: MAX_NIGHTLY_RATE_IDR,
      }).nightlyPriceIdr,
    ).toBe(MAX_NIGHTLY_RATE_IDR);
    expect(() =>
      createPriceOverrideRequestSchema.parse({
        ...valid,
        nightlyPriceIdr: MAX_NIGHTLY_RATE_IDR + 1,
      }),
    ).toThrow();
  });

  it("rejects a fractional price - rupiah has no sub-unit", () => {
    expect(() =>
      createPriceOverrideRequestSchema.parse({
        ...valid,
        nightlyPriceIdr: 1_000_000.5,
      }),
    ).toThrow();
  });

  it("has no range-length cap - pricing a whole year is one legitimate row", () => {
    expect(
      createPriceOverrideRequestSchema.parse({
        ...valid,
        from: "2027-01-01",
        to: "2028-01-01",
      }).to,
    ).toBe("2028-01-01");
  });
});

describe("priceOverrideResponseSchema", () => {
  it("parses a row as the API frames it", () => {
    const row = {
      id: "6b1f8f3e-1111-4f5e-9c9a-000000000001",
      unitId: "6b1f8f3e-2222-4f5e-9c9a-000000000002",
      from: "2026-12-20",
      to: "2027-01-05",
      nightlyPriceIdr: 2_500_000,
      createdAt: "2026-08-17T03:00:00.000Z",
    };
    expect(priceOverrideResponseSchema.parse(row)).toEqual(row);
  });
});
