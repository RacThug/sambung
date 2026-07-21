# ADR-0027: Dismiss is a judgement, resolve is a measurement

- **Date**: 2026-07-21
- **Status**: Accepted
- **Issue**: #38 (M4, channel-sync, boss fight #3 - the conflict inbox)
- **Builds on**: ADR-0025 (a healthy feed reconciles; the per-VEVENT savepoint this
  slots into), ADR-0022 (an inbox marks, it does not mutate the ledger), ADR-0002
  (deleting never destroys the ledger), ADR-0012 (a 409 carries a code)
- **Closes**: the last open piece of M4

## Context

The `booking_no_overlap` exclusion constraint applies to *every* occupying booking,
imported ones included. So when an OTA sells nights Sambung already has booked - a
real-world **double-sell** - the import's INSERT is refused with `23P01`. ADR-0025
made that survivable: each VEVENT upserts inside a savepoint, so the refusal kills
that event only and the cycle continues. What it deliberately left for this issue is
the other half: **the refusal must not be silent.** A `logger.warn` is not a workflow,
and the consequence of losing one is two guests at one door.

Four things had to be decided together:

1. **Is a conflict storable at all**, in a codebase whose grain is derive-don't-store?
2. **What does the row contain** - the 2026-07-16 issue text specifies fields that
   later decisions have since contradicted.
3. **How does a conflict close**, given the machine must never pick the loser?
4. **What happens when a closed conflict is detected again** - the question nobody
   asked, and the one that decides whether the inbox is usable after week two.

## Decision

**1. `sync_conflict` is a real table - the one honest exception to derive-don't-store.**
Availability, `publishable`, effective-archived and walk-in-vs-online are all derived
because the facts they summarise exist in rows. A conflict is the opposite: it is a
row that **failed to exist**. The losing VEVENT is in no table, and the feed that
carried it is transient. You cannot query for something that was refused, so it is
recorded (migration 0012, `sync_conflict_status` pgEnum, RLS `tenant_isolation` in the
`nullif` form of migration 0002, and the `(unit_id, tenant_id)` composite FK that makes
a wrong `tenant_id` unrepresentable on the RLS-bypassed writer).

It is an **ops inbox, never an availability source**: nothing in the availability or
booking path reads it, so invariant #3 stands and a conflict blocks nothing.

**2. No `raw_vevent` column** - the issue asked for one; this is a deliberate
departure. ADR-0025's parser drops `SUMMARY`/`DESCRIPTION` precisely so imported guest
PII never enters the database. Storing the raw VEVENT block would re-admit exactly
that through a side door, into a table with no PII story at all. The uid, unit and
nights are what an owner needs in order to phone the OTA. Likewise the refused stay is
two `date` columns rather than the issue's `stay` daterange: the only `daterange` in
this schema is built inline inside the exclusion constraint, and a second idiom for the
same fact is where drift begins. `stay: {from, to}` remains the wire shape.

**3. Only `booking_no_overlap` files a conflict.** Keyed on the constraint NAME, not
bare SQLSTATE `23P01` - ADR-0012's rule that the DB names the domain fact. Any other
per-VEVENT failure is a **defect**, and stays in the log: an inbox that shows a villa
owner engineering noise is one they stop opening.

**4. A conflict closes by being re-measured, and only ever heals itself.** There is no
`resolve` endpoint. Resolving means cancelling the blocking booking in the *real
world*; the next sync then observes that the constraint no longer refuses, and closes
the row. One statement does it, because "healed" has exactly one definition: **the
complement of what still conflicted on this pull** - which covers both the blocking
booking being cancelled (the upsert now succeeds) and the OTA withdrawing its event
(the UID is gone). That close is guarded by `events.length >= 1`, the *same* rule
ADR-0025 put on the absent-UID cancellation and for the same reason: on a healthy-but-
empty feed every UID looks absent, and mass-closing an owner's inbox on a feed that may
have been truncated to zero is the same mistake as mass-cancelling their bookings.

**5. Re-detection treats the two closed states differently - the load-bearing rule.**

| current | re-detected → | why |
|---|---|---|
| `open` | stays `open`, `last_seen_at` and the stay refreshed | nothing new |
| `dismissed` | **stays `dismissed`** | a **judgement**: the owner looked and said it's fine |
| `resolved` | **reopens** | a **measurement**: it healed and re-broke, which is news |

Both naive alternatives fail. Always reopening resurrects a dismissed item every 30
minutes until the owner learns to ignore the inbox. Never reopening hides a genuinely
new double-sell on a UID that healed once. The asymmetry is the whole reason there are
three states rather than two, and it generalises: **a measurement may be re-taken; a
judgement stands until its author revisits it.**

**6. The list carries its blocking bookings, derived at read time.** api-spec §7.5
says resolution is "cancel the blocking booking" but never says *which* one, which
would leave the owner hunting through the reservations list. The read joins the unit's
occupying bookings that overlap the conflict's stay - the *same* `daterange &&` over
the *same* `OCCUPYING_STATUSES` the exclusion constraint uses, so the list is exactly
the set of rows that caused the refusal. Derived, never stored: which booking blocks
changes as the owner works.

**7. Dismiss needs no conflict code.** A guarded UPDATE matching only `open`; 0 rows
disambiguated by a tenant-scoped existence check into `404` (unknown/cross-tenant,
existence never disclosed) or an idempotent `200` echoing the row's real state - the
`POST /payments/:id/handle` shape exactly (ADR-0022). Like `handled_at`, dismissing
writes only `status` + `closed_at` and never touches a booking or a payment.

**8. One inbox page, not two.** The conflicts section joins the paid-but-lapsed
payments on `/app/inbox`. Both are the same shape of problem - *the system did the
safe thing and is now stuck until a human acts* - and two nav items would mean two
places to remember, and an owner who checks neither. Per-connection `openConflicts`
counts fill the field api-spec §7.2 reserved and #55 shipped without a source.

## Alternatives considered

- **Auto-cancel one side.** Rejected on 2026-07-16 and re-affirmed: money and a guest
  are attached to both bookings, and the machine has no basis to choose. It is also
  irreversible in the way ADR-0002 forbids.
- **A `resolve` endpoint / "mark resolved" button.** Rejected: it would let the UI
  assert a clash is gone while the exclusion constraint still refuses the import - the
  read disagreeing with the write, which this codebase's whole spine exists to prevent.
  Dismiss is honest about being an opinion; resolve would pretend to be a fact.
- **Delete the row on resolution instead of keeping a status.** Rejected: an owner who
  gets a call about a double-sold week needs to see it happened, and #38's own auto-heal
  criterion is stated as *closing* a conflict, not erasing one. Cheap to keep, and
  `resolved` is what makes reopening (#5) expressible.
- **Store `raw_vevent` as the issue specified.** Rejected - see decision 2.
- **A separate `/app/sync-conflicts` page.** Rejected - see decision 8.

## Consequences

- A real double-sell now reaches the owner with the blocking booking one click away,
  and clears itself once they act. Nothing about the exclusion constraint, availability,
  or the never-mass-cancel guarantees changed.
- **One-cycle lag in a rare case:** if conflict B was blocked by imported booking A and
  A vanishes from the same pull, A is only cancelled *after* the event loop has already
  tried B - so B stays open until the next cycle (≤ 30 min), then heals. Reordering the
  cancellation before the upserts would fix it, but that means re-sequencing a reviewed
  boss-fight cycle for a self-correcting 30-minute delay. Left as is, deliberately.
- A conflict is cascaded away with its connection (`on delete cascade`), unlike an
  imported booking, which is kept (`set null`). A booking is ledger; a conflict is a
  todo about a feed, and disconnecting the feed retires the todo.
- `sync_conflict_status` is the sixth shared enum mirroring a pgEnum, pinned by a test
  in `apps/api` per api-spec §8.6.
- api-spec §7.2 gains `openConflicts` (deferred since #55) and §7.3 gains `conflicts` on
  the "Sync now" summary; §7.5's response shape gains the derived `blockingBookings`
  and the inventory names. db-design §4.8's DDL sketch is superseded by decision 2.
