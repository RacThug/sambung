/**
 * iCal import timings (#56, boss fight #3, FR-SYNC-1). A constant, not env: the
 * 30-minute cadence is a product rule (OTA feeds are poll-based and lag by design
 * - PRD R1), not a per-VPS knob. Mirrors HOLD_SWEEP_CRON in booking.constants.ts.
 */

/**
 * The import sweep cadence. Every 30 minutes a cron pulls every channel_connection
 * across all tenants and reconciles its bookings (architecture flow B). Like the
 * hold sweeper: one VPS = one process, so the @Cron fires once per tick - no
 * distributed lock - and an in-instance re-entrancy guard skips a tick if the
 * previous run is still in flight. "Sync now" (§7.3) forces one connection off
 * this schedule, immediately.
 */
export const IMPORT_SWEEP_INTERVAL_MINUTES = 30;

/** Built from the interval above, never written twice. The cron string and the
 * staleness promise below are two statements about the SAME cadence; as separate
 * literals they drift apart the first time one of them is tuned. */
export const IMPORT_SWEEP_CRON = `*/${IMPORT_SWEEP_INTERVAL_MINUTES} * * * *`;

/**
 * How old a successful pull may get before we call the feed stale (REQ-AV-04,
 * spec FR-03/FR-07). Three sweeps.
 *
 * This is a LIVENESS alarm on our own sweeper, not an availability-risk knob. A
 * feed that cannot be fetched already goes `error` with a reason, so an `ok` feed
 * whose age keeps growing means one thing: the sweep stopped running - and every
 * feed crosses the line together when it does.
 *
 * Three, because one skipped tick is DESIGNED behaviour (the re-entrancy guard
 * skips a tick while the previous sweep is still in flight), two is noise, and
 * three is a fault. Warning an owner about a healthy calendar is not a harmless
 * false positive here: the honesty UX only works while the warnings are believed.
 *
 * The tight fleet-wide alarm - a dead sweeper is visible in ~35 minutes, since it
 * ages every feed at once - is the OPERATOR's, and belongs to monitoring (P0-4).
 * Two audiences, two thresholds. See docs/research/ical-sync-cadence.md §5.
 */
export const SYNC_STALE_AFTER_MINUTES = 3 * IMPORT_SWEEP_INTERVAL_MINUTES;
