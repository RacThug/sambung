# A Unit is one sellable thing, not a room type with a quantity

PRD FR-PROP-2 says "units/room types", which reads like an inventory bucket with a count ("Garden Room x3").
It is not one: a **Unit** is exactly one bookable thing, and three identical garden rooms are three Unit rows.
There is no `quantity` column and there will not be one.

## Why

The `booking_no_overlap` exclusion constraint (db-design §4.3, invariant #5) is `exclude using gist (unit_id
with =, stay with &&) where status in ('pending_payment','confirmed')` - it can only express "this Unit is
taken on these nights". Quantity-based inventory cannot be guarded by it; you would have to count overlapping
bookings and compare against the quantity, which is a read-then-write race under concurrency. That race is
boss fight #1, and the exclusion constraint exists precisely to make it unrepresentable. Trading a
DB-enforced guarantee for application-level counting is the whole bug, reintroduced deliberately.

The target market makes the trade cheap: Bali villas and homestays at 1-10 rooms rarely have fungible
inventory - guests pick the one with the pool view.

## Consequences

- An owner with 8 identical rooms creates 8 Units and connects 8 OTA calendars (M4). Bulk entry is therefore
  the common path, which is why the units table has a permanent inline add row (page-spec §4.5).
- Near-identical names become likely, so `unique(property_id, name)` is enforced. Without it, an owner wires
  Airbnb's calendar for "Garden Room" into the wrong "Garden Room" - a real overbooking that no exclusion
  constraint can catch, because the bookings don't overlap, they're just on the wrong Unit.
- If room types are ever needed, they arrive as a *grouping over* Units (a parent row), never as a counter on
  one. The constraint survives that; it does not survive a `quantity` column.
