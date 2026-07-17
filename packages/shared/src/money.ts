/**
 * Money is integer rupiah - never float, never cents (invariant #6, db-design §7).
 *
 * IDR has no sub-unit in practice, so integer rupiah is the whole story: no
 * minor units to track, no rounding to get wrong. Floats lose money to rounding
 * and must never touch it.
 */
import { z } from "zod";

/**
 * Integer rupiah. Branded so a bare number can't be passed where money is
 * expected - the compiler makes you say `rupiahSchema.parse(n)` or `toRupiah(b)`,
 * which is the point at which the bounds below actually get checked.
 */
export type Rupiah = number & { readonly __brand: "Rupiah" };

/**
 * The wire form of money: a JSON number (api-spec §1). IDR magnitudes sit far
 * below 2^53, so a number is exact - the reason this contract is numbers and
 * not strings.
 *
 * `.max()` is load-bearing, not belt-and-braces: zod's `.int()` is
 * `Number.isInteger`, which is `true` for 1e20. Without the bound, zod accepts a
 * value JS can't represent exactly AND Postgres can't fit in a bigint (~9.2e18),
 * so it lands as 22003 - unmapped, therefore a 500 - instead of a 400 naming the
 * field. MAX_SAFE_INTEGER is the honest limit because it's where JS arithmetic
 * stops being exact, which is the invariant we actually care about.
 */
export const rupiahSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .transform((n) => n as Rupiah);

/**
 * DB bigint -> JSON number. THE serialization helper api-spec §8.4 mandates:
 * every money field crosses the boundary through here, and nothing else may
 * `JSON.stringify` a row carrying a BigInt (that throws TypeError, i.e. a 500).
 *
 * Drizzle hands us a real BigInt because the columns are declared
 * `mode: "bigint"` - the truthful mapping of a bigint column, and the reason
 * this function has to exist. `mode: "number"` would delete the need for it and
 * silently round anything above MAX_SAFE_INTEGER: a wrong price, no error, no
 * way to notice. This trades that for a loud failure at one chokepoint.
 *
 * Throws rather than clamps or rounds: a stored value out of range cannot have
 * come through `rupiahSchema`, so it means corruption or a write that bypassed
 * the API. That's a bug and it should read as one (500), not be quietly repaired
 * into a plausible number.
 */
export function toRupiah(value: bigint): Rupiah {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `Stored value is not representable as rupiah: ${value.toString()}`,
    );
  }
  return Number(value) as Rupiah;
}
