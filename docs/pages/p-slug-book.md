---
route: /p/$slug/book
status: shipped
prd_section: "FR-BOOK-1"
adrs: [ADR-0009, ADR-0012, ADR-0015, ADR-0023, ADR-0024]
verified: true
---

# Checkout - `/p/$slug/book`

> Migrated from [`../page-spec.md`](../page-spec.md) §3.2. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/public-booking/{checkout-page.tsx, phone.ts, availability-copy.ts,
> use-availability.ts, property-search.ts}` and `packages/shared/src/{booking, payment, availability,
> public-property, property, conflict}.ts`.
>
> **page-spec §3.2 is stale on the request body** and is recorded as such below rather than carried
> forward: it specifies `{ guestName, guestContact }`; `guest_contact` was split by migration 0007.

---

## 1. Purpose

Where a **Visitor** becomes a **Guest**: enter contact details, create the Hold, and hand off to the
payment Provider. *(page-spec §3.2)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | The Book CTA on `/p/$slug` (page-spec §3.1), carrying the quoted range. |
| **Exits to** | The Provider's hosted page via `window.location.assign(session.redirectUrl)` - a full document navigation out of the SPA. Back to `/p/$slug` on "pick other dates", "pick dates again", and the back link. The Provider returns the guest to `/booking/$bookingId`. |
| **URL params** | `$slug`. |
| **Query state** | `propertySearchSchema` - `?unit&from&to`, **all three required in practice**: missing or `to <= from` renders a "choose your dates" shell instead of the form. page-spec §3.2 says invalid params "bounce back to `/p/:slug`"; the code renders the shell in place and offers a link. |
| **Not in the URL** | The whole form (name, country, phone, email, guests), the created Hold, and the lapsed flag. A reload after the Hold exists loses the reference to it. |
| **Auth** | Public. `PublicScope.enterFromUnitId` resolves the Tenant from `unitId` in the body (api-spec §5.3). |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Shell | back link, page title | - | none | - | FE | [code] |
| Summary | stay dates | `?from`, `?to` | `propertySearchSchema` | - | raw | [code] |
| Summary | nights | - | `countNights` | - | FE | [code] |
| Summary | total price | `totalPriceIdr` | `availabilityResponseSchema` | `GET /public/units/:id/availability` | BE | [code] |
| Summary | "deposit due now" | - | `depositAmountIdr` | - | FE | [code] |
| Summary | deposit percentage label | `depositPct` | `publicPropertyResponseSchema` | `GET /public/properties/:slug` | raw | [code] |
| Summary | "balance at the property" | - | none | - | FE | [code] |
| Warning | re-quote refusal lines | `reasons` | `availabilityReasonSchema` | `GET /public/units/:id/availability` | BE slug → FE prose | [code] |
| Warning | booked nights list | `blockedRanges` | `blockedRangeSchema` | `GET /public/units/:id/availability` | FE | [code] |
| Form | full name | `guestName` | `createBookingRequestSchema` | `POST /public/bookings` | raw | [code] |
| Form | country selector | - | none | - | FE | [code] |
| Form | WhatsApp number | `guestPhone` | `e164PhoneSchema` | `POST /public/bookings` | FE | [code] |
| Form | email (optional) | `guestEmail` | `createBookingRequestSchema` | `POST /public/bookings` | raw | [code] |
| Form | guests | `guestCount` | `createBookingRequestSchema` | `POST /public/bookings` | raw | [code] |
| Form | 409 refusal banner | `reasons` | `conflictBodySchema` | `POST /public/bookings` | BE slug → FE prose | [code] |
| Held | hold countdown `mm:ss` | `holdExpiresAt` | `createBookingResponseSchema` | `POST /public/bookings` | FE | [code] |
| Held | "payment couldn't start" | - | none | - | FE | [code] |
| (exit) | Provider redirect target | `redirectUrl` | `paymentSessionResponseSchema` | `POST /public/bookings/:id/pay` | raw | [code] |

**Carried on the wire but never rendered here:** `paymentSessionResponseSchema.provider`, `.token`,
`.amountIdr`, `.deposit`, and `createBookingResponseSchema.status`/`.nights`/`.totalPriceIdr`. The page
reads only `redirectUrl` and `holdExpiresAt` from those two responses. Recorded rather than dropped,
because a field with no reader is a question for §10, not an omission.

**On `guestPhone` being FE.** The stored value is assembled in the browser from (country, national
number) by `phone.ts`'s `toE164`, which wraps `libphonenumber-js/min`. The shared schema is the *shape*
gate (`e164PhoneSchema`); `apps/api` layers a per-country validity refine on top (#124). So the client
composes the value and the server judges it - see §7.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /public/units/:id/availability` | on mount, debounce 0 | no - the form renders while it settles | yes - same `["availability", unitId, from, to]` key as the picker, so arriving from `/p/$slug` is usually a cache hit |
| `GET /public/properties/:slug` | on mount | no - advisory only; a miss hides the deposit line and never blocks checkout | yes - `["public-property", slug]`, shared with `/p/$slug` |
| `POST /public/bookings` | on submit | mutation | n/a |
| `POST /public/bookings/:id/pay` | immediately after a 201, and on Retry | mutation | n/a |

**Zero blocking reads.** Both reads are advisory: the page's gate is the URL, not the network.

---

## 5. States

Not governed by [`_list-pattern.md`](./_list-pattern.md) (public funnel - see `p-slug.md` §5 and the
open question there). The full set:

| State | Behaviour |
|---|---|
| Missing / invalid params | "Choose your dates" shell with a back link. No request fires. |
| Form | Default. Country select shows a disabled "Loading…" until the lazy phone chunk lands. |
| Phone chunk failed | `role="alert"` line + **Retry**, rather than a stuck "Loading…" and an unhandled rejection at submit (#125 review). |
| Submitting | Button reads "Starting payment…", disabled through both mutations. |
| Re-quote says unavailable | Warning block with reasons + booked nights + a link back to the picker; **submit is disabled**. |
| 409 on create | Warning banner, own localized copy from `reasons`. The form stays filled. |
| Non-409 create error | Destructive banner, generic copy. |
| Hold created, pay failed | The form is replaced by the Hold panel: countdown + "Retry payment" against the *same* booking. |
| Hold lapsed | Terminal panel + "pick dates again". Entered either by the countdown reaching zero **or** by a `booking_not_payable` 409 from pay. |

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| Submit | `POST /public/bookings` → then `POST …/pay` | button → "Starting payment…" | `window.location.assign(redirectUrl)` | 400 → fields; 409 → banner from `reasons`; other → generic | no | **no** - a second submit would create a second Hold; guarded only by the disabled button |
| "Retry payment" | `POST /public/bookings/:id/pay` | button → "Starting payment…" | redirect | `booking_not_payable` → hold-lapsed panel; other → inline | no | yes - the endpoint reuses the booking's open payment row (ADR-0015) |
| "Retry" (phone chunk) | `import("./phone")` | select repopulates | form usable | stays on the alert | no | yes |
| "Pick other dates" / "pick dates again" | `<Link>` → `/p/$slug` | navigation | - | - | n/a | yes |

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| Amount charged now = `floor(total × depositPct / 100)` | FE **and** BE | `depositPct`, `totalPriceIdr` | - |
| A deposit is "partial" only when `depositPct < 100` | FE | `depositPct` | `leak: true` |
| Balance at the property = `total − deposit` | FE | - | `leak: true` |
| The Hold has lapsed when the client clock passes `holdExpiresAt` | FE | `holdExpiresAt` | `leak: true` |
| A national number resolves to E.164 against the selected country | FE | `guestPhone` | - |
| E.164 shape is the correctness boundary | BE | `guestPhone` | - |
| Availability, price, min-stay, capacity, archived | BE | `reasons` | - |
| Refusal reasons are ranked, not listed: dead unit > overlap > capacity > min-stay | FE | `reasons` | `leak: true` |

The first row is deliberately both sides and is **not** a leak: `packages/shared`'s `depositAmountIdr`
is the number-domain twin of `apps/api`'s BigInt `depositAmountIdr`, and a test in `apps/api` pins the
two implementations together. One rule, two runtimes, one pinned answer.

---

## 8. Schema implications

**None.** Every field cited exists: `createBookingRequestSchema`, `createBookingResponseSchema`,
`e164PhoneSchema`, `paymentSessionResponseSchema`, `availabilityResponseSchema`, `conflictBodySchema`,
`depositAmountIdr`, `publicPropertyResponseSchema`.

---

## 9. Out of scope

- **The overlap decision.** Boss fight #1 lives in the transaction behind `POST /public/bookings`; this
  page renders its verdict (ADR-0009).
- **The Provider's payment UI.** Everything after `redirectUrl` is Midtrans Snap.
- **Confirmation and reconciliation.** `/booking/$bookingId` (page-spec §3.3).
- **Server-side per-country phone validity.** Enforced in `apps/api` (#124); the browser's parse is UX.

---

## 10. Open questions

- [ ] **page-spec §3.2 documents a request body that no longer exists.** It says
  `{ guestName, guestContact }`; the wire takes `{unitId, checkIn, checkOut, guestName, guestPhone,
  guestEmail?, guestCount}`. This spec records the code. page-spec is `status: legacy` and was not
  edited beyond its pointer, so the stale sentence is still there for a reader who finds it first.
  **Owner:** RacThug. **Blocks:** nothing; it is a deletion.
- [ ] **The submit path is not idempotent.** A double submit creates two Holds, prevented only by a
  disabled button. Everything else in the funnel is idempotent by construction (invariant #7).
  **Owner:** builder.
- [ ] **The client clock ends the checkout.** The countdown reaching zero moves the page to a terminal
  state with no server confirmation. A skewed clock ends a live Hold early, or shows a dead one as live
  until the guest presses pay. **Owner:** RacThug.
- [ ] **`balance = total − deposit` and "partial iff `< 100`" are computed in the browser.** The server
  already knows both (`paymentSessionResponseSchema` carries `amountIdr` and `deposit`), and the page
  fetches that response - it just does not read those two fields. Should the panel use them?
  **Owner:** builder.
- [ ] **Four fields of `paymentSessionResponseSchema` have no reader.** `provider`, `token`, `amountIdr`,
  `deposit`. Intentional (the redirect flow needs only the URL) or a missed simplification? **Owner:**
  RacThug.
- [x] ~~**The refusal-precedence rule exists twice in `apps/web`.**~~ **Closed:** the ordering moved to
  `lib/refusal.ts` (`primaryRefusalReason`), which both `availability-copy.ts` and `lib/conflict.ts` now
  switch on. Each still owns its own words - the web owns all 409 copy (ADR-0012) - but they can no
  longer disagree about which reason leads. The rule stays FE and stays a leak; only the duplication is
  gone.
