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
export const IMPORT_SWEEP_CRON = '*/30 * * * *'; // every 30 minutes
