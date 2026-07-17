import { describe, expect, it } from "vitest";
import {
  createUnitRequestSchema,
  isSellable,
  updateUnitRequestSchema,
} from "../src/unit";

const valid = { name: "Garden Room 1", basePriceIdr: 1_200_000 };

describe("createUnitRequestSchema", () => {
  it("accepts a minimal body and applies the spec'd defaults", () => {
    expect(createUnitRequestSchema.parse(valid)).toEqual({
      ...valid,
      maxGuests: 2,
      minStay: 1,
    });
  });

  // Layer 1 of #45's "rejected twice over". Layer 2 (the DB CHECK, with zod
  // bypassed entirely) is packages/db/test/unit-bounds.test.ts - one request
  // can't prove both, because if zod works the CHECK is never reached.
  it("rejects a negative price", () => {
    expect(() =>
      createUnitRequestSchema.parse({ ...valid, basePriceIdr: -1 }),
    ).toThrow();
  });

  it("accepts a zero price - a placeholder is storable, just not sellable", () => {
    expect(
      createUnitRequestSchema.parse({ ...valid, basePriceIdr: 0 }).basePriceIdr,
    ).toBe(0);
  });

  it("rejects a fractional price - rupiah has no sub-unit", () => {
    expect(() =>
      createUnitRequestSchema.parse({ ...valid, basePriceIdr: 1000.5 }),
    ).toThrow();
  });

  // .int() is Number.isInteger, which 1e20 satisfies. Unbounded, this reaches
  // Postgres as 22003 (unmapped -> 500) instead of a 400 naming the field.
  it("rejects a price JS cannot represent exactly", () => {
    expect(() =>
      createUnitRequestSchema.parse({
        ...valid,
        basePriceIdr: Number.MAX_SAFE_INTEGER + 2,
      }),
    ).toThrow();
  });

  it("rejects maxGuests below 1 and minStay below 1", () => {
    expect(() =>
      createUnitRequestSchema.parse({ ...valid, maxGuests: 0 }),
    ).toThrow();
    expect(() =>
      createUnitRequestSchema.parse({ ...valid, minStay: 0 }),
    ).toThrow();
  });

  it("rejects counts that would overflow int4", () => {
    expect(() =>
      createUnitRequestSchema.parse({ ...valid, maxGuests: 2_147_483_648 }),
    ).toThrow();
  });

  it("trims the name and rejects an empty one", () => {
    expect(createUnitRequestSchema.parse({ ...valid, name: " A " }).name).toBe(
      "A",
    );
    expect(() =>
      createUnitRequestSchema.parse({ ...valid, name: "   " }),
    ).toThrow();
  });
});

describe("updateUnitRequestSchema", () => {
  // The trap: createUnitRequestSchema carries .default(2) / .default(1). If
  // .partial() let those fire, PATCH {name} would silently reset a unit's
  // maxGuests to 2. It doesn't - ZodOptional short-circuits on undefined before
  // reaching ZodDefault - but that's zod internals, so it gets a test rather
  // than a comment.
  it("leaves absent fields absent instead of applying create's defaults", () => {
    expect(updateUnitRequestSchema.parse({})).toEqual({});
    expect(updateUnitRequestSchema.parse({ name: "Pool Villa" })).toEqual({
      name: "Pool Villa",
    });
  });

  it("still enforces the bounds on fields that ARE present", () => {
    expect(() => updateUnitRequestSchema.parse({ basePriceIdr: -1 })).toThrow();
    expect(() => updateUnitRequestSchema.parse({ minStay: 0 })).toThrow();
  });
});

describe("isSellable", () => {
  it("is the priced-above-zero rule publishable counts on", () => {
    expect(isSellable({ basePriceIdr: 1 })).toBe(true);
    expect(isSellable({ basePriceIdr: 0 })).toBe(false);
  });
});
