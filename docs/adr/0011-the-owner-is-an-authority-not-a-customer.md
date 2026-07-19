# ADR-0011: The owner is an authority, not a customer

- **Date**: 2026-07-19
- **Status**: Accepted
- **Issue**: #50
- **Builds on**: ADR-0009 (the guest funnel's one overlap chokepoint + the opportunistic hold-sweep), ADR-0008 (a resolver resolves, it does not judge), ADR-0006 (an archived Property/Unit is retired from every new-booking path), ADR-0010 (owner reads disclose whole rows; public reads clip)

## Context

`POST /public/bookings` (boss fight #1) already answers "can this Unit host this Stay?" once, inside one transaction: an opportunistic hold-sweep, then `AvailabilityService.quote()`'s re-check, then the INSERT the `booking_no_overlap` exclusion constraint arbitrates - a racing overlap losing at the constraint maps to the *same* `409 {reasons:['overlap']}` the re-check gives. That single definition of "taken" is the whole point of ADR-0009.

`#50` adds the owner's own write - `POST /bookings`, for a **manual block** (dates held for maintenance / personal use) and a **walk-in** (a real Guest booked by hand, paid offline). Both are born `confirmed`, skipping the payment dance. The question is not *whether* to reuse the guest funnel's machinery but *which parts bind the owner* - because the owner is not a stranger at the funnel, they are the person whose rules the funnel enforces.

## Decision

**The owner-side write shares the guest funnel's one overlap chokepoint, but not its guest-protection policy.**

Reused, unchanged:

- The **opportunistic in-txn hold-sweep** + **`quote()`'s overlap re-check** + the **`booking_no_overlap` constraint**, all in one transaction, yielding the **identical** `409 {reasons:['overlap']}` a guest gets. There is one authority on "these dates are taken", and the owner obeys it too.

Different, deliberately:

- **It authenticates.** `JwtAuthGuard` mints the `UserPrincipal`, so the write runs on the owner RLS connection and never calls `PublicScope.enterFromUnitId`. A cross-tenant or unknown `unitId` is simply invisible under RLS → **404** (404-over-403, api-spec §8.1). The owner can only ever write on their own Unit, by construction.
- **It is born `confirmed`, with no hold** (`hold_expires_at = NULL`). No payment will ever arrive; there is nothing to expire.
- **It enforces only the *physical* invariant** - no overlap. The guest-protection *policy* checks are **skipped**: `min_stay` (the owner may block or walk-in a single night) and `max_guests` (the owner records the real party size). `quote()` still runs, but the owner path treats only `overlap` as blocking and ignores `min_stay`; the write-only capacity check is not applied.
- **A walk-in is `source = direct`; a block is `source = manual_block`.** No `walk_in` enum value - "walk-in vs online" is *derived* (a confirmed direct booking with no `payment` row), not stored.
- **Price follows the source.** A block stores `total_price_idr = NULL` (it sells nothing). A walk-in defaults to `basePriceIdr × nights` (the figure `quote()` computes) and accepts an owner override for an offline / negotiated rate, validated by `rupiahSchema` (≥ 0, ≤ the nightly-rate cap).
- **An archived Unit is refused `409 {reasons:['archived']}`.** Archive retires a Unit from every new-booking path (ADR-0006); the owner can still *see* it (history), so a 404 would lie - the honest answer is a 409 that names why.

The read side gets the same authority-not-customer treatment: **`GET /bookings/:id`** (net-new) is the owner's full-disclosure detail read - `bookingRowSchema` plus `guestPhone`, `guestEmail`, and display names - the opposite of §5.1's public clip (ADR-0010).

## Why

**Overlap is physics; min-stay and capacity are policy.** Two Stays cannot occupy one Unit at once - that is true for a guest, an owner, and an imported OTA event alike, which is exactly why it lives in a constraint the database enforces for everyone, and why the read must never disagree with the write about it (one `quote()`). A minimum stay and a guest cap, by contrast, are rules *the owner authored* to shape the public funnel. Forcing them back onto the owner's own hand-entry would make the tool refuse to record what actually happened: a one-night maintenance closure, or a family of five the owner took by phone into a room posted as sleeping four. The product's job there is to record reality, not to argue with it.

**One chokepoint or it drifts.** The alternative - a second, owner-only availability check - would be a *second definition of "taken"*, and the moment the two definitions diverge (a half-open edge case, a coalescing quirk) the owner could create a booking a guest can't, or vice versa. Collapsing that into one authority is precisely what ADR-0009 bought; the owner write must spend it, not fork it.

**`source` means channel, not entry-method.** A walk-in is direct business - no OTA, no commission - so it *is* `direct`. Adding `walk_in` would conflate how the row was typed with which channel it came through, cost an enum migration, and paint a phantom colour on the calendar for a distinction the owner rarely needs. Where M3 genuinely needs it (a walk-in expects no provider session), it is one derivation away: confirmed + `direct` + no `payment` row.

## Consequences

- **A shared transaction core, two thin wrappers.** `createPublicBooking` and the new `createOwnerBooking` differ only in (principal source, status, hold, which `quote()` reasons block, price/guest resolution); the sweep → re-check → insert spine is one helper, so the overlap authority is physically one path.
- **Cancel is the universal "free these dates" verb.** A block and a walk-in are lifted by `POST /bookings/:id/cancel` exactly as a guest booking is - `confirmed → cancelled`, the row dropping out of the constraint's partial `WHERE`, dates free instantly. There is no separate "delete block".
- **M3 must not reconcile a walk-in.** `GET /public/bookings/:id` reconciles a `pending_payment` booking against the provider (api-spec §6.3); a walk-in is confirmed with no session, and the confirmation/reconcile path keys off status + the payment row, not source. Named here so M3 doesn't try to query a provider for a cash booking.
- **The stale api-spec §5.4 body is corrected.** It still listed the pre-migration-0007 `guestContact?`; §5.4 is rewritten to the structured guest fields and a `source`-discriminated union, and `GET /bookings/:id` is added (§5.7, api #35).
- **No block label in v1.** A `manual_block` carries no reason string (the schema has no notes column, and `guest_name` is not a place to smuggle "Maintenance"). A labelled block is a nullable-column migration if it earns its place later; deferred, not designed out.
