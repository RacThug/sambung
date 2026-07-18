# ADR-0005: Archived inventory is derived up the hierarchy, not cascaded

- **Date**: 2026-07-18
- **Status**: Accepted
- **Issue**: #84
- **Realizes**: the *archive* verb ADR-0002 deferred ("retiring inventory that has history is a different verb")
- **Amends**: CONTEXT.md (adds *Archived*); api-spec §4.3 (`publishable` now excludes archived units)

## Context

ADR-0002 stopped delete from destroying the ledger: a Unit or Property that any
booking has *ever* referenced is undeletable, because deleting it would cascade
away the payment rows that record money changing hands. That closed a data-loss
hole and opened a usability one - an owner who stops renting a room has no way to
hide it. Archive is the verb ADR-0002 named and postponed: retire inventory with
history, keep its bookings and payments, hide it from guests, keep it visible to
the owner.

Two questions decide the whole shape of it:

1. **What guards against a forgotten `WHERE` selling an archived Unit?** The cheap
   representation is `archived_at timestamptz` on `unit`/`property`, but then
   every read that lists sellable inventory needs `where archived_at is null`, and
   forgetting one is how an archived Unit gets sold.
2. **When a Property is archived, how does that reach its Units?** An owner
   archives one Unit on its own (a permanent renovation), later archives the whole
   Property for the low season, then unarchives the Property. The one-off Unit must
   stay archived; the rest must come back.

## Decision

**`archived_at timestamptz` (nullable) on both `unit` and `property`. Effective
state is derived, never stored twice:**

```
effective-archived(unit) = unit.archived_at IS NOT NULL
                        OR unit.property.archived_at IS NOT NULL
```

- **Archiving a Property touches only the property row.** Its Units are hidden by
  the second term of that `OR`, not by a write to their rows.
- **The guard is the chokepoint, not a global filter.** Read paths (the public
  page, `publishable`, the dashboard) filter for UX - a miss there is a cosmetic
  bug. The one place selling an archived Unit is a *real* bug is the availability
  re-validation inside `POST /public/bookings` (api-spec §5.3), and that is where
  "not bookable" is enforced. This is invariant #5 / ADR-0002 again: app checks
  are for UX, the correctness boundary is a single chosen point.

  *"Active" = not archived, a different axis from `isSellable` (§4.6), which means
  priced. A Unit counts toward `publishable` only when it is both: `isSellable AND
  active`.*

## Why

**Derive, don't cascade - because of unarchive.** A single `archived_at` per row
cannot tell "archived because the Property was" from "archived on its own." Cascade
the write down and unarchiving the Property faces an impossible choice: restore all
its Units (resurrecting the one retired on its own account) or add a *second*
marker to remember which were parent-archived - two timestamps to model one fact.
Deriving sidesteps it entirely. The Property's flag hides its Units while set and
stops hiding them when cleared; a Unit's own flag is independent and survives its
Property being unarchived. The nasty round-trip becomes correct by construction,
with no marker and no cascade.

This is the grain the codebase already runs along: availability is derived from
`booking` rows and never stored (invariant #3), `verified` is derived from
`licenseNo`, `publishable` from counts. "A Property's archive is a fact about the
Property; its Units inherit it" is the same move one level up.

**Neither a partial index nor a view is the guard the issue hoped for.** A partial
index (`... where archived_at is null`) does not stop a query returning archived
rows - it only makes a query that *already* filters fast; it is a performance tool,
not a correctness guard. A view *could* guard, but it fights Drizzle, the composite
FKs and RLS, and the owner-facing paths that must see archived history would have to
bypass it anyway. The honest guard for "many readers may see it, one must not" is
the one this project already uses: concentrate correctness at the chokepoint and
treat the rest as UX.

**Cost, paid deliberately.** "Active" (not archived) becomes a two-condition
predicate (`unit.archived_at IS NULL AND property.archived_at IS NULL`) that every
public and booking query must carry. The `unit → property` join it needs already exists on
those paths, and the predicate is written once and reused, so the cost is a shared
fragment, not scattered discipline.

## Consequences

- **`archived_at` appears in no PATCH schema** - like `slug` (ADR-0004), it is a
  transition, not an editable attribute. Archive/unarchive are `POST` verb-
  subresources (`POST /units/:id/archive`, `/unarchive`, and the property twin),
  matching `POST /bookings/:id/cancel`. Idempotent: re-archiving keeps the original
  `archived_at`; unarchiving something active is a no-op, not a 409.
- **No `FOR UPDATE` lock**, unlike the delete guard. Archive is a single-row flag
  write with no cascade-away race - an in-flight booking is honoured, not raced.
- **Existing bookings are never touched.** Archive changes sellability, not the
  ledger: a guest with a confirmed stay still shows up, the booking stays on the
  reservation list, and (M4) still exports to iCal so an OTA cannot resell those
  nights. Cancel is the separate verb for removing a guest.
- **`publishable` counts only effectively-active priced units** - the predicate
  lives *inside* the `pricedUnitCount` expression, not a `WHERE`, so the owner
  still sees archived properties in their own list while a property with only an
  archived priced Unit reports `publishable: false`.
- **Archive adds no RLS policy.** RLS is cross-tenant isolation; archive is intra-
  tenant visibility, and the owner must still see their archived inventory - a
  policy would hide it from them too. The predicate is application-level.
- **iCal export must stay archive-blind** for a Unit that still has bookings, or
  archiving would un-block an OTA calendar and cause a real double-booking. Left as
  a documented constraint on M4 (channel-sync does not exist yet); `channel_
  connection` rows are untouched by archive.
- **A partial index on `(archived_at)` is available if a query plan ever needs it.**
  Skipped now: at portfolio scale the sequential scan is free, and it buys nothing
  toward correctness.
