# ADR-0009: A hold is cleared by a sweep - at two scopes

- **Date**: 2026-07-18
- **Status**: Accepted
- **Issue**: #48 (boss fight #1)
- **Builds on**: db-design §4.4 (holds + the immutable-predicate problem), ADR-0008 (the pure resolver that lets this write resolve-then-409 an archived unit)

## Context

A guest booking is born `pending_payment` with a 15-minute hold, and that status sits inside the `booking_no_overlap` exclusion constraint's `WHERE (status IN ('pending_payment','confirmed'))` - so starting checkout blocks the nights before anyone pays (a pessimistic hold, db-design §4.4).

But a hold must expire, and here is the constraint that shapes everything: **an exclusion-constraint predicate must be immutable**, so it cannot say `hold_expires_at > now()`. The database cannot self-clean on a clock. A lapsed hold therefore keeps occupying the calendar until *something* flips its status to `expired`.

The naive answer is a single cron that sweeps every few minutes. It works, but it leaves a window: for up to one sweep interval after a hold lapses, its dates falsely read as taken - and that window lands exactly at the funnel's decision moment, when a new guest wants nights the previous guest abandoned.

## Decision

**A dead hold is cleared by a sweep, and the sweep exists at two scopes.**

1. **Opportunistic, intra-tenant, in the booking transaction.** Before the availability re-check, `POST /public/bookings` runs
   `UPDATE booking SET status='expired' WHERE unit_id = $1 AND status='pending_payment' AND hold_expires_at < now()`
   for the unit in hand. Because the re-check and the INSERT share this transaction, they both see the freed nights - a guest is never blocked by a dead hold on the unit they are actively booking. It is **intra-tenant** (this tenant's holds on this tenant's unit), so it rides the Visitor's RLS scope with no special connection.

2. **A 5-minute cron, cross-tenant, on the owner connection.** `HoldSweeperService.@Cron('*/5 * * * *')` runs the same `UPDATE` without a unit or tenant filter, sweeping every tenant's lapsed holds. It is **cross-tenant**, so it *must* run on the owner connection (which bypasses RLS) - there is no single tenant to scope to. It is the backstop for units nobody is actively booking.

Both are idempotent: the `WHERE` matches only holds already past their TTL, so a second run - or the two sweeps racing each other - flips nothing (they serialize on the row lock; the loser updates zero rows). The 15-minute TTL and 5-minute cadence are constants, not env knobs - they are product rules.

## Why

**Cron-only leaves a false-block at the money moment.** The harm is narrow (only the abandoned hold's exact nights, only in the ≤5-minute gap, only if another guest wants them right then) but it lands precisely where a stranger decides to pay. The opportunistic sweep makes "freed dates immediately bookable" literally true there, and it is cheap: one `UPDATE` on the `(unit_id, status)` index, one unit.

**The two scopes are not arbitrary - they are forced by the isolation model, and they explain each other.** An intra-tenant clear can run inside the Visitor's scope; an all-tenants clear cannot, because a Visitor names exactly one tenant. That is the same fact, read from both ends: it is *why* the opportunistic sweep needs no owner connection, and *why* the cron does. Seeing both makes concrete the thing db-design §4.4 states abstractly - that no single layer solves the hold, because the constraint can't self-clean and one sweep can't be both request-scoped and global.

**Rejected: make the constraint ignore lapsed holds.** Impossible by construction - the predicate is immutable and `now()` is not. Naming this is the point: it is the reason a sweep of *some* kind is unavoidable, and the reason the whole boss fight needs a job as well as a constraint.

## Consequences

- **Single VPS ⇒ no distributed lock.** One process means the `@Cron` fires once per tick. If this ever scaled horizontally, two instances would both sweep - harmless *only because* the `UPDATE` is idempotent, but a real "you'd want leader election / an advisory lock" boundary, named for when it arrives.
- **The read still shows a lapsed-unswept hold as blocked for ≤5 minutes.** Deliberately: a GET must not write, so only the write path sweeps. The read is briefly pessimistic (says taken when it could be free), never wrong (it never says free for a stay the write would reject) - which is the safe direction, and consistent with the exclusion constraint that also still sees the dead hold.
- **In M2 every hold created will lapse.** There is no payment endpoint until M3, so nothing confirms a hold - M2 proves the hold/race/sweep mechanics; M3 adds the payment→confirm transition that lets a hold graduate.
- **The sweeper is disabled under test** (`ScheduleModule` is skipped when `NODE_ENV==='test'`) so a 5-minute tick can't fire mid-suite; the service stays injectable and tests drive `sweepExpiredHolds()` directly.
