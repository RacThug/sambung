import { describe, expect, it } from "vitest";
import { rupiahSchema, toRupiah } from "../src/money";

describe("rupiahSchema", () => {
  it("accepts integer rupiah including zero", () => {
    expect(rupiahSchema.parse(0)).toBe(0);
    expect(rupiahSchema.parse(1_200_000)).toBe(1_200_000);
  });

  it("rejects floats, negatives, and NaN", () => {
    expect(() => rupiahSchema.parse(1000.5)).toThrow();
    expect(() => rupiahSchema.parse(-1)).toThrow();
    expect(() => rupiahSchema.parse(Number.NaN)).toThrow();
  });

  // Without the explicit max this passes: zod's .int() is Number.isInteger, and
  // 1e20 IS an integer as far as JS is concerned. It then overflows the bigint
  // column as 22003, which is unmapped and therefore a 500.
  it("rejects integers beyond exact JS representation", () => {
    expect(() => rupiahSchema.parse(1e20)).toThrow();
    expect(() => rupiahSchema.parse(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    expect(rupiahSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("toRupiah", () => {
  it("converts what Drizzle hands back from a bigint column", () => {
    expect(toRupiah(1_200_000n)).toBe(1_200_000);
    expect(toRupiah(0n)).toBe(0);
  });

  // The whole reason this helper exists: JSON.stringify throws on a BigInt, so
  // a response path that forgets to convert is a 500, not a wrong number.
  it("produces something JSON can actually serialize", () => {
    expect(JSON.stringify({ basePriceIdr: toRupiah(1_200_000n) })).toBe(
      '{"basePriceIdr":1200000}',
    );
    expect(() => JSON.stringify({ basePriceIdr: 1_200_000n })).toThrow(
      TypeError,
    );
  });

  // Throws rather than rounding: a stored value this big never came through
  // rupiahSchema, so it's corruption or a write that bypassed the API. Silently
  // returning a plausible-but-wrong price is the failure mode being bought off.
  it("throws on a stored value it cannot represent exactly", () => {
    expect(() => toRupiah(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      RangeError,
    );
    expect(() => toRupiah(-1n)).toThrow(RangeError);
  });
});
