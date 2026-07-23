import { randomUUID } from "node:crypto";

/**
 * Small pure helpers shared by the specs. Kept dependency-free so they read the
 * same way a future test author would write them.
 */

/**
 * `YYYY-MM-DD`, `days` from today. Computed on a UTC midnight of the presenter's
 * LOCAL calendar day - the exact model the seed uses
 * (packages/db/scripts/demo-dates.ts) - so day arithmetic never lands on 23:00 /
 * 01:00 across a DST switch and `.slice(0, 10)` cannot drop or repeat a day.
 *
 * Use FAR-future offsets (30+). The seed packs every stay into `[today+1,
 * today+8)`, so a date a month out is guaranteed free on every unit - which is
 * what keeps the write journeys deterministic without reading the seed's rows.
 */
export function futureIso(days: number): string {
  const now = new Date();
  const base = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A label unique to this run, so a write-test's row can never collide with the
 * Baseline seed or a re-run's leftovers (blueprint Q4: per-test data owns its
 * own identity). A random UUID slice, not a timestamp - two parallel workers can
 * enter this in the same millisecond, so "unique" must not depend on the clock.
 *
 * NOTE: this makes the guest NAME unique. A write-test must also pick a unique
 * (unit, date) so two parallel writers never contend for the same nights - see
 * the write-test convention in the README.
 */
export function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}
