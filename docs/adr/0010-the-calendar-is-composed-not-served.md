# ADR-0010: The Calendar is composed, not served

- **Date**: 2026-07-18
- **Status**: Accepted
- **Issue**: #49 (unified multi-property calendar)
- **Builds on**: ADR-0003/0008 (public vs owner reads), invariant #3 (availability is derived, never stored)

## Context

#49 is the dashboard home: one grid, a row per Unit, every occupying booking
drawn as a bar colored by source. The tempting shape for "give me the whole
calendar" is a bespoke aggregate - `GET /calendar?from&to&propertyId` that
server-assembles properties -> units -> bookings into exactly the tree the page
renders. One request, the server owns the grouping, the client just draws it.

That temptation is what this ADR refuses. The Calendar is not a new read model;
it is a *view* composed on the client from neutral endpoints, the same way
Availability is derived from booking rows rather than stored.

## Decision

**The Calendar is assembled client-side from general-purpose endpoints. There is
no `GET /calendar`.** Three reads, each independently useful:

- `GET /bookings?from&to&propertyId&unitId&status&source` - the **one** authed
  booking-read path, shared with #51 (reservations) and #50 (detail drawer). It
  returns **full booking rows**, not window-clipped ranges. `status` is a
  **repeatable** filter; the caller selects which statuses it wants, and the
  Calendar names the two **occupying** ones via the shared `OCCUPYING_STATUSES`
  constant in `packages/shared`. No `status` filter = all statuses (what a
  reservations *management* list wants). Window filter uses overlap semantics; a
  366-night cap guards the scan.
- `GET /units` - a flat, tenant-wide Unit list carrying the **effective-archived**
  flag (the Unit's own `archived_at` **OR** its Property's, per ADR-0005). Reused
  by #50's manual-block dialog (filtered to active) and #51's filters.
- `GET /properties` - already exists; supplies Property names and the filter
  dropdown.

The client joins bookings onto Units by `unitId` and lays out the grid. The row
rule - active Units always, archived Units only when they carry an occupying
booking - is applied on the client against those two sets.

**Disclosure follows the audience.** The public availability read (#47) clips
blocked ranges to the queried window and strips everything but the dates, because
a Visitor must not learn a neighbour's guest name or an out-of-window date. This
owner read does the opposite: it returns the **whole** row, because the owner owns
the ledger. Same overlap-window *filter*, opposite disclosure *rule* - driven
entirely by who is asking.

## Why

**One booking-read path cannot drift.** A `GET /calendar` that also returned
bookings would be a second place that defines "an occupying booking in a window."
The moment #51 needs a subtly different projection, the two drift - the exact
duplicate-with-a-difference the codebase keeps deleting (the drifted booking
enums §8.6; the two-copies constraint strings #80). One `GET /bookings`, many
views, is the shape that stays honest.

**Neutral primitives get reused; a bespoke tree does not.** A flat `GET /units`
and a general `GET /bookings` each serve three issues (#49/#50/#51). A
properties->units->bookings aggregate serves exactly one page and has to be
rebuilt or forked the first time a second view wants the same data at a different
grain.

**The overlap constraint already deleted the hard part.** A server aggregate's
usual justification is that laying out overlapping events is fiddly. Here it
isn't: boss fight #1's exclusion constraint makes two occupying bookings on one
Unit impossible, so each Unit row is a clean non-overlapping 1-D interval sequence.
The client join is trivial; there is nothing to centralize on the server.

**Occupancy is derived, like availability.** Invariant #3 says availability is a
question you ask the booking rows, never a table. The Calendar is the same grain
one level up: occupancy is *derived* by joining bookings onto Units in the view,
not *served* as a stored or pre-assembled shape. Keeping it client-composed is
that principle applied to the read model, not just the schema.

## Consequences

- **The Calendar makes a fixed handful of requests** (`properties` + `units` +
  `bookings`) regardless of Property count - no N+1 fan-out over per-property unit
  lists - and TanStack Query caches the Unit skeleton and the bars independently,
  so #50 creating a manual block invalidates `bookings` alone.
- **The window is a UI concern, not a wire concern.** The endpoint returns full
  rows; the grid clips bars to the window and shows an off-edge "continues"
  affordance. A 6-month OTA block seen through a 1-month window is one row that
  runs off both edges.
- **`status` becomes repeatable in api-spec §5.5** (was single-valued). "Occupying"
  is not an endpoint mode; it is a two-element selection the caller makes.
- **There is no server-side notion of "the calendar."** A future export, mobile
  view, or third consumer composes from the same three endpoints rather than
  inheriting a tree shaped for one page. The explicit no-`GET /calendar` is the
  decision most likely to be re-proposed in six months; this record is why not.
