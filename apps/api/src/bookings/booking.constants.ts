/**
 * Boss fight #1 timings (ADR-0009). Constants, not env: these are product rules
 * (a hold lives 15 minutes), not per-deploy knobs someone should tune per VPS.
 */

/**
 * How long a guest has to pay before the hold lapses. Stamped by the DB clock at
 * insert (`now() + this`), so the countdown the checkout UI shows is
 * server-authoritative and immune to app/DB clock skew.
 */
export const HOLD_TTL_MINUTES = 15;

/**
 * The BACKSTOP sweep cadence. A dead hold stops occupying only once something
 * flips its status - the exclusion constraint can't reference `now()` (its
 * predicate must be immutable, db-design §4.4). Two things flip it (ADR-0009):
 * the opportunistic in-transaction sweep clears a unit a guest is actively
 * booking (so freed dates are bookable at the funnel's decision moment), and
 * this cron is the cross-tenant backstop for units nobody is touching.
 */
export const HOLD_SWEEP_CRON = '*/5 * * * *'; // every 5 minutes
