/**
 * The Deposit amount: what a guest pays online now (ADR-0015, api-spec §6.1).
 *
 * `amount = total × pct / 100`, computed in BigInt and floored. Money is integer
 * rupiah, never float (invariant #6): totalPriceIdr fits under 2^53, but so does
 * `total × 100`, and float division would still risk a `x.9999` that floors a
 * rupiah short. BigInt division truncates toward zero = floor for non-negative
 * money, so the guest is never charged MORE than the Deposit share; the remainder
 * settles at the Property. At pct = 100 the result equals the total exactly.
 *
 * `pct` is a 1-100 integer (depositPctSchema / the property_deposit_pct_range
 * CHECK), so this never divides the total up or by zero.
 */
export function depositAmountIdr(totalPriceIdr: bigint, pct: number): bigint {
  return (totalPriceIdr * BigInt(pct)) / 100n;
}
