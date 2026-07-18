# ADR-0006: An archived Property is retired, not just incomplete

- **Date**: 2026-07-18
- **Status**: Accepted
- **Issue**: #84
- **Amends**: ADR-0004 (adds the deliberate exception to "the page always renders"); api-spec §4.7

## Context

ADR-0004 established that a property's public URL is a permanent address, not a
view of its state: `GET /public/properties/:slug` 404s on an unknown slug and
nothing else, so that deleting a photo - which drops the property below
`publishable` - can never silently 404 a link already pasted into an OTA profile or
forwarded on WhatsApp. "The page always renders" was the whole point.

Archive (ADR-0005) introduces a *new* reason a page might not render: the owner has
deliberately retired the Property. The issue's own words are that archived
inventory "disappears from the public page." That collides head-on with ADR-0004 -
so either archive doesn't really hide a Property, or ADR-0004 has an exception. This
ADR is that exception, stated so a future reader does not read it as ADR-0004 being
quietly broken.

## Decision

**An archived Property's `GET /public/properties/:slug` returns `404`** - the same
status and body as an unknown slug. An archived *Unit* under a live Property simply
drops out of the page's unit list (the is-active predicate); only a whole archived
Property makes the page 404.

- **Enforced in `findPublicBySlug`** (archived property → the row query returns
  null → 404), *not* in `PublicScope.enterFromSlug`, which stays visibility-
  agnostic: it resolves the tenant from the slug and nothing more, because §5.3's
  future `POST /public/bookings` still needs that tenant resolved to answer a `409`
  for an archived Unit (ADR-0003's "resolve, then scope").
- **The slug row persists** (archived, not deleted), so the address stays reserved
  and **unarchive brings the exact URL back to life.**

## Why

**The line is intent, not mechanism.** ADR-0004 guards against a URL dying as a
*side effect of an edit nobody thought was about the URL* - a photo delete, a
rename. Those are surprising deaths, and the product cannot afford them. Archive is
the opposite: a *deliberate* act whose entire purpose is to take the listing down.
Honouring that intent is not the failure ADR-0004 prevents; it is the owner getting
what they asked for. So `publishable` (an incomplete checklist) never gates the
page, and archive (a deliberate retirement) does - and those two facts are
consistent, not contradictory, once the axis is "did the owner mean to hide this?"

**404, not 410 or a tombstone.** `410 Gone` is more honest HTTP, but it confirms the
slug was once real - an existence oracle the rest of the API refuses (it 404s
another tenant's property rather than 403, api-spec §1). A "no longer available"
tombstone is friendlier for a guest holding an old link, but it is a product
decision that keeps a public surface for retired inventory and leaks existence.
`404` matches the convention already load-bearing everywhere else: hidden is
indistinguishable from never-existed.

**The permanent-address guarantee survives.** ADR-0004's promise was that the
*address* does not move or vanish under the owner's feet. Archive keeps the slug
row, so the address is still there - it is the *resource* that is currently retired,
and unarchive restores it byte-for-byte. Reserving the slug is also what stops a
re-mint collision if the owner ever recreates the listing.

## Consequences

- **A guest with an old link to an archived Property sees the generic 404**, not an
  explanation. Accepted for v1; a tombstone page is the upgrade path if it becomes a
  real complaint, exactly as ADR-0004 pointed at an explicit `published` flag for
  its own upgrade path.
- **`enterFromSlug` deliberately does not check archive.** A reviewer greps that
  method as the one cross-tenant read; keeping it a pure tenant-resolver (not a
  visibility gate) preserves that property and leaves the M2 booking path free to
  resolve the tenant and *then* answer `409` for an archived Unit.
- **The public payload is unchanged.** Archived inventory is simply absent from it;
  no field is added or removed, so ADR-0004's "no PII, parsed on the way out"
  guarantee is untouched.
