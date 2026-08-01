---
route: /booking/$bookingId
status: shipped
prd_section: "FR-PAY-1 · FR-NOTIF-2"
adrs: [ADR-0018, ADR-0020, ADR-0023, ADR-0024]
verified: true
---

# Confirmation - `/booking/$bookingId`

> Migrated from [`../page-spec.md`](../page-spec.md) §3.3. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/public-booking/confirmation-page.tsx` and
> `packages/shared/src/booking-confirmation.ts`.

---

## 1. Purpose

The page a **Guest** lands on after paying, and the link in their email: live booking status, what was
paid, and what happens next. *(page-spec §3.3)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | The Provider's redirect after Snap, and the confirmation email (ADR-0021). Must work stone cold - no session, no referrer, possibly days later. |
| **Exits to** | `/` via "back home" on the three non-confirmed states. The WhatsApp deeplink leaves the app entirely (`target="_blank"`). |
| **URL params** | `$bookingId` - **the unguessable UUID is the access control** (api-spec §6.3, a documented v1 trade-off). Unknown id → 404 state. |
| **Query state** | None. |
| **Not in the URL** | Nothing; the page has no local state beyond the query. |
| **Auth** | Public. |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Shell | page title | - | none | - | FE | [code] |
| Body | which state renders | `status` | `bookingConfirmationResponseSchema` | `GET /public/bookings/:id` | raw | [code] |
| Confirmed | "Stay" - property + unit | `propertyName`, `unitName` | `bookingConfirmationResponseSchema` | `GET /public/bookings/:id` | raw | [code] |
| Confirmed | check-in date | `checkIn` | `bookingConfirmationResponseSchema` | `GET /public/bookings/:id` | raw | [code] |
| Confirmed | check-out date | `checkOut` | `bookingConfirmationResponseSchema` | `GET /public/bookings/:id` | raw | [code] |
| Confirmed | "paid online" | `amountPaidIdr` | `bookingConfirmationResponseSchema` | `GET /public/bookings/:id` | BE | [code] |
| Confirmed | "balance at the property" | `balanceIdr` | `bookingConfirmationResponseSchema` | `GET /public/bookings/:id` | BE | [code] |
| Confirmed | WhatsApp button | `waLink` | `bookingConfirmationResponseSchema` | `GET /public/bookings/:id` | BE | [code] |
| Pending | spinner + copy | - | none | - | FE | [code] |
| Expired / Cancelled | title + body | `status` | `bookingConfirmationResponseSchema` | `GET /public/bookings/:id` | raw | [code] |
| (behaviour) | poll interval | `status` | `bookingConfirmationResponseSchema` | `GET /public/bookings/:id` | FE | [code] |

`totalPriceIdr` is on the wire and is now read by nothing: it was the input to the balance the page used
to compute, and the server states that directly. Kept on the shape rather than removed - it is the
booking's full price, which a confirmation legitimately carries.

`amountPaidIdr` and `waLink` are `BE`: the first is the sum of settled payments (api-spec §6.3), the
second is built server-side by shared `buildWaMeLink`, which returns `null` when the stored phone is not
canonical E.164 - so the button is omitted rather than linking to nowhere.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /public/bookings/:id` | on mount, then **every 5 s while `status === "pending_payment"`**, stopping on any terminal status | **yes, whole body** | no - `["booking-confirmation", bookingId]` is this page's alone |

One blocking request. The read **reconciles on the server** (ADR-0020): a pending booking makes the
handler pull the Provider's status through the same idempotent transition the webhook uses, so a lost
webhook still confirms here. Nothing on the client knows that; the page just polls.

---

## 5. States

Not governed by [`_list-pattern.md`](./_list-pattern.md) (public funnel).

| State | Behaviour |
|---|---|
| Loading | `h-56` pulse block inside the page shell. |
| 404 | Own title + body, distinguished from a generic failure; `retry: false`. |
| Error | Separate title + body. No retry affordance. |
| Confirmed | The party view: tick, stay, dates, amount paid, optional balance, optional WhatsApp button. |
| Pending | Spinner with `role="status"` + copy saying the page updates itself. Polling is live. |
| Expired | Terminal card ("hold lapsed"). |
| Cancelled | Terminal card. |

No empty state: a booking id either resolves or 404s.

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| "Send WhatsApp confirmation" | opens `waLink` in a new tab | browser hand-off | - | - | n/a | yes |
| "Back home" | `<Link>` → `/` | navigation | - | - | n/a | yes |

**No mutation on this page**, and that is the point: the only thing that turns a Hold into a confirmed
booking is the Settlement (CONTEXT.md), and the read reconciles rather than the user acting.

**Documented but not implemented:** page-spec §3.3 lists a *"retry payment" when pending with live hold
(api #26)* action. No such control exists in `confirmation-page.tsx`. Recorded in §10.

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| A pending booking is re-checked against the Provider on every read | BE | `status` | - |
| Amount paid = the sum of settled payments | BE | `amountPaidIdr` | - |
| A WhatsApp link exists only for a canonical E.164 number | BE | `waLink` | - |
| Balance at the property, clamped at zero | BE | `balanceIdr` | - |
| Show the balance line only when there is one | FE | `balanceIdr` | - |
| Poll while pending, stop on terminal | FE | `status` | - |

**No leaks.** Both money rules moved to the server; the remaining FE row is a visibility check on a
field the server already decided, not arithmetic.

The polling rule is FE and not a leak: "how often should this client ask again" is a client concern, and
the terminal-status set it keys on comes from the shared status enum.

---

## 8. Schema implications

**None.** `bookingConfirmationResponseSchema` carries every field the page reads.

**Closed:** `balanceIdr` was added to `bookingConfirmationResponseSchema` - a `packages/shared` +
`apps/api` change with no migration, since the value is derived from two columns that already existed.

---

## 9. Out of scope

- **The webhook.** Boss fight #4 (ADR-0018) is the push side; this page is the pull side.
- **The confirmation email.** Fired post-commit behind the `Mailer` port (ADR-0021), not by this page.
- **Refunds.** Manual and offline in v1 (ADR-0011).
- **Owner-facing detail.** `/app/bookings/$bookingId` is the same booking with full disclosure.

---

## 10. Open questions

- [ ] **page-spec §3.3 specifies a "retry payment" action that does not exist.** A guest whose hold is
  still live but whose payment did not start has no way forward from this page; the equivalent control
  lives on `/p/$slug/book`, which they have already left. Build it, or delete the line? **Owner:**
  RacThug. **Blocks:** nothing today.
- [x] ~~**The balance is computed in the browser from two fields.**~~ **Closed:** the server sends
  `balanceIdr`, clamped at zero so an overpayment cannot render as a negative.
- [ ] **The 5-second poll has no stop condition other than terminal status.** A booking that stays
  `pending_payment` polls forever while the tab is open. Acceptable at portfolio scale, but it is an
  unbounded request loop against a public endpoint that is not `@ThrottleSensitive`. **Owner:** RacThug.
