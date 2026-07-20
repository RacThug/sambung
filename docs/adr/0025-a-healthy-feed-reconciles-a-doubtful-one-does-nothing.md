# ADR-0025: A healthy feed reconciles; a doubtful one does nothing

- **Date**: 2026-07-20
- **Status**: Accepted
- **Issue**: #56 (M4, channel-sync import side, boss fight #3)
- **Builds on**: ADR-0016 (the .ics export is hand-rolled), ADR-0009 (a sweep on the owner connection), ADR-0018 (the webhook reconciles on the owner connection), ADR-0012 (a 409 carries a code)
- **Blocks**: #38 (the sync-conflict inbox slots into the per-VEVENT catch this builds)

## Context

The other half of channel sync: #55 gave an owner a public `.ics` **export** so an
OTA stops reselling booked nights; #56 is the **import** - a 30-min cron (plus a
"Sync now" button) that pulls each connection's OTA feed and mirrors its blocks
into `booking`, so a stay taken on Airbnb blocks the Sambung direct calendar too
(FR-SYNC-1). This is boss fight #3 because it is where *reliability* is won or
lost: the input is a third party's feed (adversarial, per the trust-no-external-
input invariant), it is delivered repeatedly (must be idempotent, invariant #7),
and the reconciliation includes **cancelling** bookings whose UID vanished - which,
done naively, will mass-cancel real stays the first time a feed is truncated.

Three questions have to be answered together:
1. **What parses the feed** - a library or hand-rolled code?
2. **What counts as "healthy"** - i.e. when is it safe to run the absent-UID
   cancellation, and when must the importer change nothing?
3. **Where does it run**, given it crosses tenants and has no principal?

The `sync_conflict` inbox - what to do when an imported VEVENT *overlaps* an
existing booking (a real-world double-sell the exclusion constraint refuses) - is
**#38**, a separate issue this one blocks. #56 must only make that case survivable.

## Decision

**1. Hand-roll a minimal, strict parser** (`ical-parse.ts`), the symmetric call
ADR-0016 made for the export serializer. The subset OTAs emit is trivial - all-day
`VALUE=DATE` VEVENTs with `UID`/`DTSTART`/`DTEND`, no RRULE, no VTIMEZONE that
matters. Trust is confined to a validated `{uid, start, end}` projection: a VEVENT
with no UID (undedupable), an unparseable date, or an empty/inverted range is
**skipped, never fatal**; a feed's SUMMARY/DESCRIPTION (guest names) is dropped, so
imported PII cannot enter. `DTEND` is exclusive in iCalendar and maps to the
half-open `check_out` with zero arithmetic (invariant #4) - the exact inverse of
the serializer.

**2. "Healthy" is a whole, terminated calendar; the cancellation needs ≥ 1 event.**
- A pull is **unhealthy** → `last_status = 'error'`, **zero writes** - when the
  fetch fails (non-2xx / unreachable / timeout) OR the body is not a *terminated*
  `BEGIN:VCALENDAR … END:VCALENDAR` (a truncated download loses its `END`, the one
  signal that separates "the OTA cleared its calendar" from "the stream was cut").
- A pull is **healthy** → upsert present UIDs, stamp `last_status='ok'` /
  `last_synced_at`. The **absent-UID cancellation runs only when the healthy feed
  carried ≥ 1 VEVENT.** A healthy-but-empty calendar stamps `ok` but cancels
  nothing: empty is indistinguishable from truncated-to-zero, and the invariant is
  *never mass-cancel real bookings*. A genuine full clear-out is the owner's manual
  call.

**3. It runs on the OWNER connection** (`DbService`, RLS-bypassed), the sweeper /
webhook category (ADR-0009, ADR-0018): a system reconciliation with **no
principal** that crosses tenants has no single tenant to scope to. RLS is off, so
every write is scoped **explicitly** by `tenant_id` + the connection id.

**4. Fetch outside the transaction; one transaction per connection; a SAVEPOINT
per VEVENT.** The body is pulled first (a network round-trip must never pin a
pooled DB connection). Then one `db.transaction`; each VEVENT upsert is a nested
`tx.transaction()` (a SAVEPOINT in drizzle/pg), so an exclusion violation (`23P01`
- overlaps an existing occupying booking) rolls back only that event and the cycle
continues. **That catch is the seam #38 slots its `sync_conflict` INSERT into.**
Idempotency is the partial unique index `(channel_connection_id, external_uid)`:
`ON CONFLICT DO UPDATE` makes a re-pull a no-op, a changed stay an in-place update,
and a re-appearing auto-cancelled UID a re-confirm. Cancellation is scoped by
`channel_connection_id` + `tenant_id` + non-null `external_uid`, so a direct or
manual booking is structurally untouchable.

**5. "Sync now" is synchronous → `200` + a result summary**, not `202 {queued}`.
There is no job queue on a single VPS (Redis/BullMQ would be a heavy dependency).
Running the one connection's pull inline is immediate (the AC), testable
(deterministic), and honest. It resolves the connection under the owner's RLS
scope first (unknown/foreign id → `404`, existence hidden), then hands the row to
the same reconcile core the cron uses.

## Alternatives considered

- **A parsing library (`ical.js`, `node-ical`).** More robust against exotic feeds,
  but a dependency whose date/timezone coercion we would still have to map to our
  half-open dates ourselves, and the reliability-critical logic (healthy vs
  truncated) is ours either way. The hand-rolled parser's failure mode is *safe*
  (skip a VEVENT or reject the feed → visible `error`), never silent corruption.
  `ical.js` is the documented plan B if real feeds prove too varied.
- **Treat a valid-but-empty calendar as a real clear-out (cancel everything).**
  Rejected: it is indistinguishable from a truncation to zero, the exact
  mass-cancel this ADR exists to prevent.
- **Resolve each connection's tenant and reconcile under RLS (like a Visitor).**
  Rejected: minting a Visitor for a cron with no principal is the lie the Principal
  union forbids; the sweeper/webhook precedent (owner connection) fits a system
  reconciliation that crosses tenants.
- **`202 {queued:true}` with a real job queue.** Rejected at portfolio scale: a
  queue is infrastructure we don't have; a fake queue is dishonest.

## Consequences

- A truncated, empty, or unreachable feed is *safe*: the connection shows `error`
  (or `ok` with zero cancellations for a valid-empty one) and no real booking is
  cancelled. The cost: a genuine full OTA clear-out is not auto-reflected - the
  owner cancels the last imported stay by hand. Accepted; safety beats promptness.
- One overbooked VEVENT no longer sinks a cycle - it is skipped and logged, and
  #38 will record it in a `sync_conflict` inbox by dropping an INSERT into the
  per-VEVENT catch already built here. No schema change was needed for #56 (the
  `external_uid` column and its partial unique index shipped with #40/#48).
- The `IcalFetcher` port gains `fetchFeed` (the whole bounded body) beside `probe`
  (the header sniff), both through one guarded redirect/SSRF walk, so the private-
  host block cannot hold for one and not the other.
- api-spec §7.3 is refined (`202 queued` → `200` synchronous + summary); the
  architecture flow-B "node-ical" note becomes "hand-rolled" (this ADR).
