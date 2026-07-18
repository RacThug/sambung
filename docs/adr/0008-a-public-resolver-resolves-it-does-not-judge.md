# ADR-0008: A public resolver resolves, it does not judge

- **Date**: 2026-07-18
- **Status**: Accepted
- **Issue**: #47 (boss fight #2)
- **Broadens**: ADR-0003 (a Visitor is scoped by the public identifier they opened - slug *or* unit id); builds on ADR-0006

## Context

ADR-0003 gave the public funnel its entry: a Visitor has no token, so
`PublicScope.enterFromSlug(slug)` resolves the tenant from the slug on the owner
connection, seeds a Visitor principal, and everything after runs under RLS. #47
adds the second public entry - `GET /public/units/:id/availability` - which
addresses a **Unit by raw UUID**, not a slug. The unit id is already a
deliberately-public value: the public property page returns it precisely so this
endpoint (and the picker's `?unit`) can address a Unit by it (api-spec §4.7).

So we need a second resolver, `enterFromUnitId(id)`. The real decision is not
*whether* to add it but **how much it is allowed to know**. A Unit can be
effectively archived (its own `archived_at`, or its parent Property's), and an
archived Unit is hidden from the public page (ADR-0006). The tempting move is to
fold that check into the resolver: 404 an archived Unit at the door, one step,
done. That temptation is the thing this ADR exists to refuse.

## Decision

**Public resolvers resolve the tenant for any *existing* row and make no
visibility judgement.** `enterFromUnitId(id)` runs a one-column
`SELECT tenant_id FROM unit WHERE id = $1` on the owner connection, throws `404`
only when no such Unit exists, seeds the Visitor principal, and returns. It does
**not** look at `archived_at`. Whether a resolvable-but-retired Unit is refused,
and how, is decided downstream at the booking chokepoint:

- **#47 read** (`GET availability`): `AvailabilityService` fetches the Unit under
  RLS and returns `404` when `unit.archived_at IS NOT NULL OR property.archived_at
  IS NOT NULL` - indistinguishable from unknown, matching the public page.
- **#48 write** (`POST /public/bookings`): resolves the Unit, then answers `409`
  for an archived Unit (api-spec §4.8) - "these dates can't be booked", the same
  shape as a taken Unit.

This is the exact rule ADR-0006 already applied to `enterFromSlug` ("stays a pure
tenant-resolver so §5.3 can resolve-then-409 an archived Unit"), now stated as the
general property of *every* public resolver rather than a one-off note.

## Why

**#48 cannot both resolve and be pre-empted.** §5.3's specified behaviour is
resolve-the-Unit-then-refuse-it-with-a-409. A resolver that 404'd an archived Unit
makes that impossible: the write path would 404 at the door and could never reach
its 409. One resolver serving a 404 for the read and a 409 for the write is only
possible if the resolver itself stays silent on archive and each caller decides.

**One entry point, not two that drift.** If `enterFromUnitId` judged visibility,
#48 would need its *own* resolver that doesn't - two functions doing the same
cross-tenant lookup with a subtly different contract, which is exactly the
duplicate-with-a-difference the codebase keeps deleting (the drifted booking enums,
§8.6; the two-copies constraint strings, #80). Keeping the resolver pure means both
callers share one lookup and cannot disagree about what "this Unit exists" means.

**The resolver is the grep target.** `PublicScope` is the one class allowed to
query across tenants for an unauthenticated request; a reviewer greps it and reads
its whole surface. Every rule folded into it (visibility, pricing, archive) is
another thing that surface has to be trusted to get right. A resolver that only
ever selects `tenant_id`, keyed by a public value, and never branches on row state,
is the smallest, most auditable thing it can be - and the reason a future
`payout_account` column can't leak through it is that it selects one column and
judges nothing.

## Consequences

- **A stale `?unit=` link to a retired room reads as `404`** on the quote, like the
  archived Property page (ADR-0006). The write path will distinguish archived (409)
  from unknown (404); that read/write asymmetry is deliberate and finalized in #48.
- **`enterFromUnitId` mirrors `enterFromSlug` byte-for-byte in spirit**: one column,
  a public key, 404-or-seed, no branch on row state. A future third resolver copies
  the same shape.
- **The `Visitor` principal is unchanged** - it still names exactly one tenant, the
  one that owns whatever public identifier the Visitor opened. "Scoped by the slug"
  in ADR-0003 generalizes to "scoped by the public identifier."
- **The archived judgement now lives in two services** (availability read, booking
  write) instead of one resolver. That is the point: the judgement is a *chokepoint*
  concern (invariant #5), and there are two chokepoints with two correct answers.
