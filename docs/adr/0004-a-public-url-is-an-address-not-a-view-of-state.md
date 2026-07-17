# ADR-0004: A property's public URL is an address, not a view of its state

- **Date**: 2026-07-17
- **Status**: Accepted
- **Issue**: #46
- **Amends**: CONTEXT.md's definition of *Publishable*; api-spec §4.7

## Context

`/p/:slug` is the entire distribution model. #46's first line is "a guest opens a
shared link"; the link gets pasted into an OTA profile, forwarded on WhatsApp,
printed on a card. Sambung exists to make that link convert, so the link is the
product's most load-bearing artifact - and the owner cannot see it break.

Two independent questions arrived with the public page, and they turn out to be
the same question:

1. An owner renames "Seminyak Beach Villa" to "Seminyak Beach Villa & Spa". Does
   the URL move?
2. An owner deletes their last photo, so the property is no longer `publishable`.
   Does the URL 404?

Both are really: **can a live public URL die as a side effect of an edit nobody
thought was about the URL?**

## Decision

**No. The URL is an address.** It changes only when someone deliberately changes
the address - which, in v1, nobody can.

1. **The slug is minted once, at create, and a rename never moves it.** It
   appears in no request schema. `property.slug` is `NOT NULL UNIQUE` with a
   format CHECK; `createPropertyRequestSchema` has no slug field, and
   `updatePropertyRequestSchema` derives from it, so immutability is structural
   rather than a rule someone enforces.
2. **`publishable` never gates the public page.** `GET /public/properties/:slug`
   404s on an unknown slug and nothing else. A property with no photos renders
   without a gallery; one with no priced unit renders without a price.

## Why

**Renames.** A slug tracking the name breaks every link in the wild, silently, on
an edit the owner believes is cosmetic - and they will never connect the traffic
drop to it. Drift between name and URL is the cheaper failure: it is visible only
to whoever reads the address bar, and it costs a guest nothing. The typo
objection ("Semiyak Beach Vila is permanent") is weaker than it looks: ADR-0002
already permits deleting inventory nothing was ever booked on, which is exactly
the window a fresh typo lives in. The escape hatch exists; it just isn't a
rename.

**Publishable.** It reads like a gate - CONTEXT.md said "complete enough for its
public page to be worth rendering" - but look at where the specs actually use it:
page-spec §4.4 ("list with `publishable` indicator per property"), §4.5
("`publishable` checklist when incomplete"). It is an **owner-facing readiness
checklist**, everywhere it appears. api-spec §4.7 specifies exactly one failure:
"404 unknown slug".

Making it a gate would mean a URL's existence is a *derived* property of
unrelated columns - delete a photo, zero out a price to hide a unit, and the page
a guest bookmarked is gone. That is the rename failure again, through a different
door. It would also have 404'd every property in the demo seed, none of which had
photos.

**Both rules fall out of one principle**, which is why this is one ADR and not
two. Splitting them would duplicate the reasoning into both and leave neither
reading as the reason it exists.

## Consequences

- A half-built property is publicly reachable at a guessable slug the moment it
  is created. Accepted for v1: there is no PII on the page, and the owner
  controls when they share the link. **If this becomes a real complaint, the
  answer is an explicit `published` flag - an owner's decision - not a derived
  gate.** That keeps existence deliberate either way.
- `publishable` stays in `PropertyResponse` (owner-facing) and is absent from
  `PublicPropertyResponse`. It is not a fact about the villa.
- Old-slug redirects (a `property_slug` history table, 301) remain strictly
  additive if renames ever prove painful. Choosing immutability now does not
  paint us in; choosing "follows the name" would have, because links break before
  anyone notices the policy was wrong.
- Slug typos are fixed by delete-and-recreate while unbooked. After M2, archive
  (#84) is the retirement path and a typo becomes permanent. Acceptable: the URL
  is rarely read by a human, and never by the guest who clicked it.
