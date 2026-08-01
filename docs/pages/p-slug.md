---
route: /p/$slug
status: shipped
prd_section: "FR-PROP-1 · G2"
adrs: [ADR-0003, ADR-0004, ADR-0007, ADR-0008, ADR-0013, ADR-0019, ADR-0023, ADR-0024]
verified: true
---

# Property page - `/p/$slug`

> Migrated from [`../page-spec.md`](../page-spec.md) §3.1. `[code]` rows were read at commit
> **6702881** from: `apps/web/src/features/public-booking/{property-page,availability-picker,property-meta}.tsx`,
> `{availability-model,availability-copy,use-availability,property-search}.ts`,
> `packages/shared/src/{public-property,availability,og,money,unit}.ts`. Backend derivations cite the
> shared schema's own contract note or a single read line in `apps/api`, marked per row.

---

## 1. Purpose

The direct-booking landing page a **Visitor** reaches from an OTA profile or a forwarded link, where
they see the villa, pick dates, and get a price. *(page-spec §3.1)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | A pasted or forwarded link (the product's actual distribution channel, ADR-0019), an OTA profile, the landing page's demo link (`landing-page.tsx`, `DEMO_SLUG`). A cold deep link **must** work: the page fetches its own data and reads the whole selection from the URL. |
| **Exits to** | `/p/$slug/book?unit&from&to` via the Book CTA (`availability-picker.tsx`, `Available`). No other outbound navigation. |
| **URL params** | `$slug` - the Property's permanent public address (ADR-0004). Unknown slug → `404` copy; malformed slug → also `404`, refused at the API boundary by `SlugParamPipe` (api-spec §4.7). |
| **Query state** | `propertySearchSchema` (`features/public-booking/property-search.ts`): `?unit` (which unit's picker is open), `?from`, `?to` (the picked stay). Each is `.catch(undefined)`, so a pasted bad value degrades to "nothing picked" and the page still renders. |
| **Not in the URL** | The picker's *visible month* (local `useState` in `AvailabilityPicker`) - it is a scroll position, not a selection. |
| **Auth** | Public. No token; the slug resolves the Tenant and everything reads under RLS (ADR-0003). |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Head | `<title>`, `og:title`, `twitter:title` | `title` | `PropertyOgTags` | `GET /public/properties/:slug` | FE | [code] |
| Head | `og:description`, `<meta description>` | `description` | `PropertyOgTags` | `GET /public/properties/:slug` | FE | [code] |
| Head | `og:image`, `twitter:image` | `image` | `PropertyOgTags` | `GET /public/properties/:slug` | FE | [code] |
| Head | `twitter:card` | `twitterCard` | `PropertyOgTags` | `GET /public/properties/:slug` | FE | [code] |
| Head | `og:url` | - | none | - | FE | [code] |
| Gallery | hero image | `photos[0].url` | `publicPropertyResponseSchema` | `GET /public/properties/:slug` | raw | [code] |
| Gallery | up to 4 thumbnails | `photos[1..4].url` | `publicPropertyResponseSchema` | `GET /public/properties/:slug` | raw | [code] |
| Gallery | image `alt` text | - | none | - | FE | [code] |
| Header | property name | `name` | `publicPropertyResponseSchema` | `GET /public/properties/:slug` | raw | [code] |
| Header | Verified badge | `verified` | `publicPropertyResponseSchema` | `GET /public/properties/:slug` | BE | [code] |
| Header | address line | `address` | `publicPropertyResponseSchema` | `GET /public/properties/:slug` | raw | [code] |
| Body | description paragraph | `description` | `publicPropertyResponseSchema` | `GET /public/properties/:slug` | raw | [code] |
| Rooms | "no rooms yet" line | - | none | - | FE | [code] |
| Room card | unit name | `name` | `publicUnitSchema` | `GET /public/properties/:slug` | raw | [code] |
| Room card | capacity ("sleeps N") | `maxGuests` | `publicUnitSchema` | `GET /public/properties/:slug` | raw | [code] |
| Room card | min-stay note | `minStay` | `publicUnitSchema` | `GET /public/properties/:slug` | raw | [code] |
| Room card | price per night | `basePriceIdr` | `publicUnitSchema` | `GET /public/properties/:slug` | raw | [code] |
| Room card | "price on request" / "not bookable yet" | `basePriceIdr` | `publicUnitSchema` | `GET /public/properties/:slug` | FE | [code] |
| Room card | "Check availability" / "Close" | - | none | - | FE | [code] |
| Picker | greyed booked nights | `blockedRanges` | `availabilityResponseSchema` | `GET /public/units/:id/availability` | BE | [code] |
| Picker | past days disabled | - | none | - | FE | [code] |
| Picker | opening month | `?from` | `propertySearchSchema` | - | FE | [code] |
| Quote | available verdict | `available` | `availabilityResponseSchema` | `GET /public/units/:id/availability` | BE | [code] |
| Quote | nights | `nights` | `availabilityResponseSchema` | `GET /public/units/:id/availability` | BE | [code] |
| Quote | total price | `totalPriceIdr` | `availabilityResponseSchema` | `GET /public/units/:id/availability` | BE | [code] |
| Quote | refusal reason lines | `reasons` | `availabilityReasonSchema` | `GET /public/units/:id/availability` | BE slug → FE prose | [code] |
| Quote | min-stay number inside that copy | `minStay` | `availabilityResponseSchema` | `GET /public/units/:id/availability` | BE | [code] |
| Quote | "Booked: 10 Aug - 12 Aug" labels | `blockedRanges` | `blockedRangeSchema` | `GET /public/units/:id/availability` | FE | [code] |
| Quote | Book CTA | - | none | - | FE | [code] |

**Notes on three rows.**

- The four `PropertyOgTags` rows are `FE` but are **not** a leak: `property-meta.tsx` calls
  `buildPropertyOgTags` from `packages/shared`, and `apps/api` calls the identical helper for the
  crawler stub. One implementation running in two places is not two definitions (ADR-0019).
- `verified` is `BE` on the evidence of the shared contract itself: `public-property.ts` documents that
  the repository returns a row that has **never carried** `licenseNo`, so the boolean cannot be derived
  client-side. Not read in `apps/api` for this page.
- `blockedRanges` is `BE` (coalesced in `apps/api/src/bookings/availability.service.ts:82` via shared
  `coalesceRanges`), but its **conversion to displayable nights** is FE - see §7.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /public/properties/:slug` | on mount | **yes, whole page** - `PropertySkeleton` replaces everything until it lands | yes - key `["public-property", slug]`, shared with `/p/$slug/book` |
| `GET /public/units/:id/availability` (month sweep) | when a unit's picker opens, and on every visible-month change | no - the calendar renders ungreyed | yes - key `["availability", unitId, from, to]`, `staleTime` 60 s |
| `GET /public/units/:id/availability` (selection quote) | debounced ~300 ms once a full stay is picked | no - quote card only | yes - same key shape; a selection matching a fetched window is a cache hit, and `/p/$slug/book` re-quotes on the same key |

One blocking request. The month sweep and the selection quote are the same endpoint in the two modes
api-spec §5.1 specifies, which is why they share one cache key.

---

## 5. States

**[`_list-pattern.md`](./_list-pattern.md) does not govern this page.** Its §0 scopes it to `/app/*`
dashboard lists; this is a public-funnel page under the other half of the two-surface doctrine
(ADR-0007). Nothing here is a delta from it - the states below are the whole set. Whether the funnel
needs its own counterpart document is §10.

| State | Behaviour |
|---|---|
| Loading | `PropertySkeleton` - a **shaped** placeholder (hero rectangle, title bar at `w-2/3`, subtitle at `w-1/3`, two unit cards), not the dashboard's single grey block. The funnel's skeleton promises the page that is coming (ADR-0007). |
| 404 | Own copy: "not found" title + body, distinguished from a generic failure. `retry: false` on a 404 - a slug is either an address or it is not. |
| Error (network / 5xx) | Separate title + body from the 404 branch. No retry affordance at page level. |
| Empty (no units) | One muted line. Reachable on purpose: `publishable` never gates this page (ADR-0004). |
| Empty (no photos) | The gallery renders **nothing** rather than a placeholder frame. |
| Picker: no dates | "Select dates" line. |
| Picker: checking | "Checking…" with `aria-live="polite"`, shown while the debounce is catching up *or* the query is fetching. |
| Picker: available | Green line + nights + total + Book CTA. |
| Picker: blocked | "Not available", one line per `reason`, then the clipped booked nights. **All reasons are listed**, not ranked - this page has no precedence rule (unlike checkout, which does). |
| Picker: quote error | Inline message + the app's only other **Retry** button (`quote.refetch()`). The rest of the page stays usable. |

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| "Check availability" | `navigate` → `?unit=<id>` (merge-patched) | picker expands | picker mounts, month sweep fires | n/a - no request | n/a | yes |
| "Close" | `navigate` → `?unit=undefined` | picker collapses | - | n/a | n/a | yes |
| Pick a day / range | `navigate` → `?from&to` with `replace: true` | selection highlights immediately | debounced quote fires | n/a | n/a | yes |
| "Retry" (quote error) | `quote.refetch()` | card returns to "Checking…" | quote renders | stays on the error card | no | yes |
| "Book" | `<Link>` → `/p/$slug/book?unit&from&to` | navigation | checkout re-quotes | n/a | n/a | yes |

No mutation on this page. `replace: true` on date picking is deliberate: a range selection is two clicks
and would otherwise stack two history entries per stay.

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| Verified badge = a licence is on file | BE | `verified` | - |
| A Unit is bookable iff its nightly rate is above zero | FE (shared helper) | `basePriceIdr` | - |
| A blocked `[from, to)` range displays as nights `from … to-1` | FE (shared helper) | `blockedRanges` | - |
| A selection is a stay only when `to > from` | FE | `?from`, `?to` | `leak: true` |
| Days before the guest's local today are unselectable | FE | - | - |
| A booked night is greyed but still selectable; the server decides | FE | `blockedRanges` | - |
| Availability, price and min-stay verdicts | BE | `available`, `totalPriceIdr`, `reasons` | - |

One leak, recorded in §10.

"Bookable" and the blocked-night labels are FE but **not** leaks: both call a shared helper (`isSellable`, `lastNightOf`), the same helper the dashboard's units
table and the API's `publishable` derivation use. It was an inline `basePriceIdr > 0` until the page-spec
migration found the second spelling.

The last two FE rows are deliberately **not** leaks. "What is today" is genuinely the browser's question
- a guest in Bali and one in Los Angeles must each get their own (ADR-0013). And "greyed but selectable"
is the *absence* of a client rule: refusing to disable a booked night is what keeps the server the single
authority on "taken" (invariants #3/#5), so a range spanning one is still sent and answered.

---

## 8. Schema implications

**None.** Every field cited exists in `packages/shared` today: `publicPropertyResponseSchema`,
`publicUnitSchema`, `availabilityResponseSchema`, `availabilityReasonSchema`, `blockedRangeSchema`,
`PropertyOgTags`. No migration, no new column, no index.

---

## 9. Out of scope

- **The booking write.** Guest details, the Hold, and payment are `/p/$slug/book` (page-spec §3.2).
- **Owner-facing fields.** `licenseNo`, `tenantId`, `property.id`, `publishable` and `createdAt` are
  deliberately absent from the public payload (api-spec §4.7 lists each exclusion and why).
- **`depositPct`.** It rides on `publicPropertyResponseSchema` but is consumed by checkout, not rendered
  here.
- **The crawler card.** `GET /public/properties/:slug/og` is a separate machine route (ADR-0019); this
  page only shares its values through `buildPropertyOgTags`.
- **Archived Property.** Returns `404` from the API (ADR-0006), so it lands on the 404 state above and
  is not a state of its own.

---

## 10. Open questions

- [x] ~~**`bookable` is an inline copy of a rule that already exists as a shared helper.**~~ **Closed:**
  `property-page.tsx` now calls shared `isSellable`.
- [x] ~~**The half-open → inclusive conversion exists twice in the funnel.**~~ **Closed:** both sites now
  call `lastNightOf` from `packages/shared`, beside `countNights` - the same fact asked the other way.
  Five tests pin it, including one that checks it agrees with `countNights`.
- [ ] **`to > from` is validated client-side and again server-side.** `stayFromRange` gates the quote,
  and `availabilityQuerySchema` refines the same rule. This is the UX-vs-correctness split invariant #5
  blesses, but the spec should say which is authoritative here rather than leaving it implied.
  **Owner:** RacThug.
- [ ] **Does the public funnel need its own shared-pattern document?** `_list-pattern.md` covers `/app/*`
  only, so §5 above carries the page's whole state set rather than deltas. `/p/$slug`, `/p/$slug/book`
  and `/booking/$bookingId` already share conventions (shaped skeletons, 404-vs-error branching,
  `retry: false` on 404, slug/id-in-URL as the access control). **Owner:** RacThug. **Blocks:** the
  remaining two funnel migrations, which will otherwise each restate them.
- [ ] **page-spec §3.1's "Edge" line says "SEO tier-1: correct meta/OG tags per property".** Tier 2
  shipped since (ADR-0019, the crawler stub). Is the stub in this page's spec, or its own machine-route
  spec? Recorded as out of scope above pending the answer. **Owner:** RacThug.
