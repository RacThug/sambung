# ADR-0013: The picker advises, the server decides

- **Date**: 2026-07-19
- **Status**: Accepted
- **Issue**: #93 (M2 availability picker UI)
- **Builds on**: invariant #5 (app checks are for UX, not correctness); ADR-0008 (a public resolver resolves, it does not judge); ADR-0009 (the exclusion constraint is the one overlap authority)

## Context

The `/p/:slug` picker (react-day-picker on top of Sambung components, ADR-0007)
knows two things about a night the server also knows: whether it is in the past,
and whether it is already booked (the `blockedRanges` from `GET availability`,
#47). The natural instinct is to make the calendar *enforce* both - `disabled`
every past day **and** every booked night, so a bad range simply cannot be
picked. That instinct is what this ADR pins down and half-refuses.

The tension is with the acceptance criteria themselves: AC #2 says selecting a
range that overlaps a booking must show `overlap` and **highlight the clipped
booked nights**. You cannot highlight a selection the calendar forbade you to
make. So "grey the booked nights but let them be selected" and "hard-disable the
booked nights" are genuinely different products, and the choice is load-bearing.

## Decision

**The calendar hard-disables exactly one thing - the past - and greys, but never
disables, booked nights.** Concretely:

- **Past** (`{ before: local-today }`) is `disabled`, and `startMonth` is the
  current month so the guest cannot even page backwards. The past is not a
  matter of opinion the server needs to arbitrate, and a stateless quote is
  happy to price a past window (api-spec §5.1 has no past check) - so this one
  guard is purely the UI's, keyed to the guest's **browser-local** today.
- **Booked nights** come from the visible month's `blockedRanges` and drive a
  `blocked` **modifier** (greyed, struck through), not the `disabled` prop. They
  stay clickable. A selection that spans one is sent to the quote endpoint, which
  returns `available:false, reasons:['overlap']` with the clipped ranges, and the
  quote card names those nights.

The server's `available` is the only verdict the card renders. The calendar's
greying is a hint; the debounced `GET availability` call is the truth.

## Why

**The read must not re-decide what the write decides.** Availability is *derived*
from booking rows and arbitrated by the `booking_no_overlap` exclusion constraint
(invariants #3/#5, ADR-0009); the quote endpoint shares that definition of
"taken" by running the same `daterange && ` operators (api-spec §5.1). If the
calendar independently disabled booked nights, it would become a *second*,
client-side definition of availability - one that a stale month-sweep (the guest
opened the tab an hour ago) could disagree with, silently forbidding a night that
is now free or, worse, feeling authoritative. Grey-don't-disable keeps exactly
one authority, the same principle ADR-0008 applied to the resolver and #80
applied to constraint names: don't grow a second copy of a rule that can drift.

**The half-open changeover only works if checkout days stay clickable.** Booked
nights are half-open `[from, to)`; the checkout day `to` is *free* - the next
guest can check in the morning this one leaves (db-design §4.2). A guest checking
**out** on a day that is another booking's check-in is a valid, non-overlapping
stay, and the server says so. Hard-disabling every booked night would also
disable legitimate checkout-on-a-changeover selections; greying does not.

**"Highlight the clipped nights" is a feature, not a fallback.** Letting the
overlap happen and then explaining it ("13-14 Aug are booked") teaches the guest
where to move their dates. A calendar that just refuses the click teaches
nothing. The AC asks for the explanatory path on purpose.

## Consequences

- **A guest can select an unbookable range**, and that is intended: the card
  turns it into a specific, actionable message rather than a dead click. No Book
  CTA is offered for an unavailable quote (the sell-gate proper is #48).
- **Two query modes, one endpoint, one cache key** (`["availability", unitId,
  from, to]`): the visible-month sweep greys, the debounced selection quotes. A
  selection that matches a swept window is a cache hit, not a second fetch.
- **State lives in `?from&to&unit`** (the picker writes and reads them), so a
  shared link reproduces the exact quote view - the calendar owns no hidden
  selection state the URL doesn't.
- **The one thing the client enforces alone (past) is the one thing that is
  genuinely a UI concern**, keyed to browser-local today; everything about
  *availability* stays the server's to answer.
