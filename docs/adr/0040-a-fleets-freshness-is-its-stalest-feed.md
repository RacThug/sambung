# ADR-0040: A fleet's freshness is its stalest feed, and staleness is judged on the server's clock

- **Date**: 2026-08-18
- **Status**: Accepted
- **Builds on**: [ADR-0025](0025-a-healthy-feed-reconciles-a-doubtful-one-does-nothing.md) (the
  30-minute pull and its "a doubtful feed changes nothing" bias),
  [ADR-0005](0005-archived-inventory-is-derived-up-the-hierarchy.md) as amended (a fact about a row
  that depends on context is derived server-side, not stored)
- **Realises**: PRD-product P0-3 / REQ-AV-04, specified in
  [`docs/spec/honesty-sync-ux.md`](../spec/honesty-sync-ux.md), evidenced by
  [`docs/research/ical-sync-cadence.md`](../research/ical-sync-cadence.md)

## Context

The sync facts already travelled on the wire - `lastSyncedAt`, `lastStatus`, `lastError` - and the
page spec recorded `lastSyncedAt` as **not rendered**. An owner was therefore told *that* a feed had
synced and never *when*. Two silences follow from that, and both are the kind a booking product cannot
afford:

1. **A stopped sweeper is invisible.** A feed that cannot be fetched goes `error` with a reason, loudly.
   But if the sweep itself stops - process down, cron not firing, ticks skipped - every feed keeps its
   last good `ok`, and the green "Synced" pill stays green forever over a calendar that is hours or
   days behind.
2. **The calendar said nothing at all.** The dashboard's calendar is where availability is *read*, and
   it disclosed no freshness until someone clicked *Sync now*. The page making an availability claim
   was the one page not qualifying it.

Research into the actual cadences ([`ical-sync-cadence.md`](../research/ical-sync-cadence.md)) found
the risk is not where it looks. Our inbound pull is 30 minutes - level with the fastest PMS found, and
six times faster than Airbnb's own. The dangerous leg is **outbound**: Airbnb documents that it
re-reads a connected calendar about every 3 hours and rate-limits being asked more often, so a direct
booking here can sit unblocked there for hours, and no work on our side shortens that. Indonesia's
19-day booking lead time (against a 32-day global average) puts more bookings inside any such window
than elsewhere.

## Decision

**1. Staleness is derived, and the server judges it.** `stale` is computed per read from
`last_synced_at` against a threshold the server owns; no column, no migration, no job. The comparison
happens on the API process's clock - the same clock that stamped the timestamp. Shipping the threshold
to the browser and letting it compare would judge one clock against another: a laptop twenty minutes
fast warns about a healthy feed, one twenty minutes slow stays quiet about a dead one, and the owner
cannot tell either from a real fault. **The server judges, the browser phrases.**

**2. The threshold is a liveness alarm, sized at three sweeps.** An unfetchable feed is already
`error`, so an `ok` feed whose age grows means the sweep stopped - and every feed crosses together when
it does. Three missed sweeps (90 minutes) is the alarm point: one skipped tick is *designed* behaviour
(the re-entrancy guard skips while a sweep is in flight), two is noise, three is a fault. Both the cron
expression and the threshold are computed from one interval constant, so the cadence and the promise
about it cannot drift apart.

**3. A fleet's freshness is its stalest feed.** `GET /channels/health` reports `oldestSyncedAt`, never
the newest. Three feeds where the freshest synced two minutes ago and one has been silent six hours is
not a two-minute-old calendar. And when any feed has never synced at all, the field is `null` rather
than a number describing only part of the fleet - counts carry the rest.

**4. Error and stale are two facts, and both are shown.** A feed erroring since its last good pull
three days ago is both erroring and three days behind. A red pill that hides the age understates the
damage. A `never`-synced feed is neither: unstarted is not stale, and the owner's next action differs
(wait, versus go and check the URL).

**5. The honest note leads with the leg we do not control.** One component, both surfaces, naming
Airbnb's ~3-hour re-read *before* our 30-minute pull, and naming the OTA's own manual *Refresh* as the
only lever the owner actually holds.

## Consequences

- The calendar carries an always-on freshness line and says so plainly when a feed is unreachable or
  the sweep appears to have stopped, with a link to where it is fixed.
- `GET /channels/health` is one aggregate query with no outbound fetch, because the calendar polls it
  while a tab is open. A read that pulled three OTAs would be a denial-of-service handle aimed at our
  own IP.
- Two audiences now clearly need two thresholds. 90 minutes is right for the **owner**, who can only
  wait; the **operator** should know within ~35 minutes, since a dead sweeper ages every feed at once.
  That tighter alarm belongs to monitoring (PRD-product P0-4) and is deferred by name - this decision
  is what makes it derivable, as "is the sweeper alive?" is now one authenticated GET.
- Tuning the threshold between 60 and 90 minutes is second-order and should not be relitigated without
  new evidence: it is a rounding error against a three-hour structural window owned by Airbnb.
- Not chosen: adding `stale` to the `sync_status` pgEnum. Staleness is a function of the clock, not a
  state a pull can write, and a stored flag would need a job to keep true - the row saying everything
  is fine is precisely the row that stops updating when the process minding it dies.
