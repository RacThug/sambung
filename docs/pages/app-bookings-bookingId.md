---
route: /app/bookings/$bookingId
status: shipped
prd_section: "flow 4.3"
adrs: [ADR-0007, ADR-0010, ADR-0011, ADR-0012]
verified: true
---

# Booking detail - `/app/bookings/$bookingId`

> Migrated from [`../page-spec.md`](../page-spec.md) §4.3. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/bookings/{booking-detail-page.tsx, booking-badges.tsx,
> booking-display.ts}` and `packages/shared/src/{booking-list, booking, availability}.ts`.

---

## 1. Purpose

Everything about one Booking for the **Owner** or assigned **Staff** - guest, dates, source, price - and
the one verb that frees its nights. *(page-spec §4.3)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | A calendar bar, a reservations row, an inbox conflict's "view booking", and a lapsed payment's "view booking". Deep-linkable: it fetches its own row rather than leaning on a warm cache, so a bookmarked or forwarded link opens cold. |
| **Exits to** | `/app/calendar` via the back link. Cancelling stays on the page. |
| **URL params** | `$bookingId`. Unknown or cross-tenant → **404**, indistinguishable by design (api-spec §1). |
| **Query state** | None. |
| **Not in the URL** | The cancel dialog's open state. |
| **Auth** | Authed. A booking on a Property a Staff member is not assigned is a 404, not a 403 - RLS narrows the read, so the row is not there to refuse (ADR-0032). |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Nav | back link | - | none | - | FE | [code] |
| Header | page title | `source`, `guestName` | `bookingDetailSchema` | `GET /bookings/:id` | FE | [code] |
| Header | status badge | `status` | `bookingStatusSchema` | `GET /bookings/:id` | FE | [code] |
| Header | source badge | `source` | `bookingSourceSchema` | `GET /bookings/:id` | FE | [code] |
| Header | hold countdown | `holdExpiresAt` | `bookingDetailSchema` | `GET /bookings/:id` | FE | [code] |
| Body | Property | `propertyName` | `bookingDetailSchema` | `GET /bookings/:id` | BE | [code] |
| Body | Unit | `unitName` | `bookingDetailSchema` | `GET /bookings/:id` | BE | [code] |
| Body | check-in | `checkIn` | `bookingDetailSchema` | `GET /bookings/:id` | raw | [code] |
| Body | check-out + nights | `checkOut` | `bookingDetailSchema` | `GET /bookings/:id` | raw + FE | [code] |
| Body | total | `totalPriceIdr` | `bookingDetailSchema` | `GET /bookings/:id` | raw | [code] |
| Body | guests | `guestCount` | `bookingDetailSchema` | `GET /bookings/:id` | raw | [code] |
| Body | phone | `guestPhone` | `bookingDetailSchema` | `GET /bookings/:id` | raw | [code] |
| Body | email | `guestEmail` | `bookingDetailSchema` | `GET /bookings/:id` | raw | [code] |
| Cancel | button label ("Cancel booking" / "Remove block") | `source` | `bookingDetailSchema` | `GET /bookings/:id` | FE | [code] |
| Cancel | dialog title + description | `source` | `bookingDetailSchema` | `GET /bookings/:id` | FE | [code] |
| Cancel | error line | - | none | - | FE | [code] |

`propertyName` and `unitName` are `BE`: the detail read joins them server-side, unlike the reservations
table which composes the same two names client-side from the flat lists it holds. Two pages, two
strategies, one contract - and this one is the reason a deep link works cold.

`bookingDetailSchema.propertyId` and `.id` are on the wire and are **not rendered**; `propertyId` has no
reader at all on this page.

**`cancelBookingResponseSchema.refund` is returned and never read.** api-spec §5.6 specifies `"manual"`
when a paid payment exists, so the owner can be told a refund is owed - the mutation ignores the body.
See §10.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /bookings/:id` | on mount; `retry: false` on a 404 | **yes, whole body** | no - `["booking", bookingId]` is this page's alone, deliberately: a detail page must survive a cold cache |
| `POST /bookings/:id/cancel` | dialog confirm | mutation | n/a |

One blocking request.

---

## 5. States

Follows [`_list-pattern.md`](./_list-pattern.md). Deltas:

- **404 is branched from a generic failure** with its own sentence - "this booking doesn't exist, or it
  isn't yours" - which is the pattern's §3.2 example and the only place in the dashboard that does it.
- **The body varies by status**: the hold countdown renders only for `pending_payment`, and the whole
  Cancel section only when the status is Occupying.
- **No empty state.** An id either resolves or 404s.
- The back link renders in **every** state, including 404 and error, so the page is never a dead end.

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| "Cancel booking" / "Remove block" | opens the confirm dialog | dialog | - | n/a | n/a | yes |
| Dialog confirm | `POST /bookings/:id/cancel` | button → "Working…" | close, invalidate `["booking", id]` **and** `["bookings"]` so the calendar frees the dates | **409 → close and refetch** (already terminal); other → inline line | no | yes - the FSM lives in the UPDATE's `WHERE`, so a second cancel is a 409, never a double effect |
| "Keep it" | closes the dialog | - | - | - | n/a | yes |

The confirm dialog is the shadcn `Dialog`, not `window.confirm` - the only destructive action in the app
that gets the styled path, and the one with the most consequential copy ("any payment must be refunded
manually"). That inconsistency is `_list-pattern.md` D10.

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| Cancel is offered only for an Occupying booking | FE | `status` | `leak: true` |
| A Block says "remove", a booking says "cancel" | FE | `source` | - |
| The title is the guest, or "Manual block", or "Walk-in" | FE | `source`, `guestName` | `leak: true` |
| Remaining hold minutes | FE | `holdExpiresAt` | `leak: true` |
| Cancelling frees the nights instantly | BE | `status` | - |
| An already-terminal booking refuses with `booking_not_cancellable` | BE | `code`, `status` | - |
| `refund: "manual"` iff a paid payment exists | BE | `refund` | - |
| Unknown or unassigned → 404, never 403 | BE | - | - |

Three leaks. The first is the one that matters: the client decides whether to *offer* cancel by testing
membership of `OCCUPYING_STATUSES`, while the server decides whether to *allow* it via the FSM in the
UPDATE's `WHERE`. That is the sanctioned UX-vs-correctness split, and the 409 handler proves the client
copy is not trusted - but it is still a rule in two places.

---

## 8. Schema implications

**None.** `bookingDetailSchema`, `cancelBookingResponseSchema`, `OCCUPYING_STATUSES` all exist.

---

## 9. Out of scope

- **Editing dates, price or guest.** No update endpoint exists; cancel and re-create is the path.
- **Refunds.** Manual and offline in v1 (ADR-0011); the API moves no money.
- **Payment history.** api-spec §5.7 says payment fields join at M3; the shape has not gained them.
- **The conflict banner.** page-spec §4.3 mentions a "this booking blocks an OTA import" banner from an
  api #32 lookup. Not built - the inbox links *to* here instead, which is the inverse direction.

---

## 10. Open questions

- [ ] **`refund` is returned and discarded.** The owner is never told a refund is owed. The dialog's
  static copy says payments must be refunded manually, but the response's actual answer for *this*
  booking is dropped. **Owner:** RacThug. **Blocks:** nothing; it is a render of a field already on the
  wire.
- [ ] **page-spec §4.3 specifies a conflict banner that does not exist.** Build it, or delete the line?
  **Owner:** RacThug.
- [ ] **The hold countdown is computed once per render, not ticked.** Documented in the code as
  sufficient for a glancing owner. Worth confirming that is still the intent now that the same page
  shows a live `pending_payment` state. **Owner:** RacThug.
