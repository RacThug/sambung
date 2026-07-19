import { depositAmountIdr as sharedDepositAmountIdr } from '@sambung/shared';
import { depositAmountIdr } from './deposit';

/**
 * The Deposit math (ADR-0015). Pure and BigInt - no DB, no float. The point is
 * that it floors (never overcharges) and that 100% is the full total exactly.
 */
describe('depositAmountIdr', () => {
  it('charges the full total at 100%', () => {
    expect(depositAmountIdr(4_000_000n, 100)).toBe(4_000_000n);
  });

  it('takes the exact share when it divides evenly', () => {
    expect(depositAmountIdr(4_000_000n, 50)).toBe(2_000_000n);
    expect(depositAmountIdr(4_000_000n, 25)).toBe(1_000_000n);
  });

  it('floors a fractional rupiah rather than rounding up', () => {
    // 4,000,001 x 50% = 2,000,000.5 -> floored to 2,000,000 (guest never overpays
    // the deposit; the remainder settles at the property).
    expect(depositAmountIdr(4_000_001n, 50)).toBe(2_000_000n);
    // 999 x 1% = 9.99 -> 9.
    expect(depositAmountIdr(999n, 1)).toBe(9n);
  });

  it('stays exact for large totals (no float, no precision loss)', () => {
    // The nightly-rate cap (1e9) x 366 nights is the largest total possible.
    const maxTotal = 1_000_000_000n * 366n;
    expect(depositAmountIdr(maxTotal, 30)).toBe((maxTotal * 30n) / 100n);
  });

  it('is zero only when the total is zero', () => {
    expect(depositAmountIdr(0n, 100)).toBe(0n);
  });

  // The web previews the deposit with a NUMBER-domain twin (@sambung/shared); it
  // must equal this BigInt authority so the guest sees exactly what gets charged.
  // Pinned here because apps/api is the one place that can import both.
  it('agrees with the shared number-domain twin across the domain', () => {
    const totals = [0n, 1n, 999n, 4_000_001n, 1_000_000_000n * 366n];
    const pcts = [1, 25, 30, 50, 99, 100];
    for (const total of totals) {
      for (const pct of pcts) {
        expect(BigInt(sharedDepositAmountIdr(Number(total), pct))).toBe(
          depositAmountIdr(total, pct),
        );
      }
    }
  });
});
