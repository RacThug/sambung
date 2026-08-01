---
route: /app/inbox
status: shipped
prd_section: "FR-SYNC-3 · FR-PAY-2"
adrs: [ADR-0002, ADR-0018, ADR-0022, ADR-0025, ADR-0027, ADR-0037]
verified: true
---

# Operations inbox - `/app/inbox`

> Migrated from [`../page-spec.md`](../page-spec.md) §4.6. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/dashboard/{inbox-page.tsx, use-inbox-count.ts}`,
> `features/channels/{sync-conflicts-section.tsx, use-sync-conflicts.ts}`,
> `features/payments/{lapsed-payments-section.tsx, use-lapsed-payments.ts}`, and
> `packages/shared/src/{sync-conflict, payment-inbox, booking, channel}.ts`.

---

## 1. Purpose

The two queues where Sambung took the safe action and now needs a human: a Channel sold nights already
booked here, and money that settled after the Hold lapsed. *(page-spec §4.6)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | The sidebar (with a count badge), and a connection's conflict badge on the Property workbench. |
| **Exits to** | `/app/bookings/$bookingId` - from a conflict's blocking-booking list and from a lapsed payment's "view booking". Resolution happens *there*, by cancelling one side; this page cannot fix either problem. |
| **URL params** | None. |
| **Query state** | **None.** Each queue is a whole, small list acted on in place - no filter, no window, nothing to share. `listSyncConflictsQuerySchema` supports `?status` and `?propertyId`; the page sends neither and takes the server's `open` default. |
| **Not in the URL** | Nothing. |
| **Auth** | Authed; both reads are tenant-scoped, and Staff see only their assigned Properties' rows via RLS. |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Header | page title | - | none | - | FE | [code] |
| Conflicts | section heading + explanation | - | none | - | FE | [code] |
| Conflicts | "Airbnb booking couldn't be imported" | `channel` | `channelSchema` | `GET /sync-conflicts` | FE | [code] |
| Conflicts | property - unit | `propertyName`, `unitName` | `syncConflictSchema` | `GET /sync-conflicts` | BE | [code] |
| Conflicts | refused stay | `stay.from`, `stay.to` | `syncConflictSchema` | `GET /sync-conflicts` | raw | [code] |
| Conflicts | nights | - | `countNights` | - | FE | [code] |
| Conflicts | "First seen …" | `firstDetectedAt` | `syncConflictSchema` | `GET /sync-conflicts` | raw | [code] |
| Conflicts | "Already booked here" list | `blockingBookings[]` | `blockingBookingSchema` | `GET /sync-conflicts` | **BE, derived at read time** | [code] |
| Conflicts | per-blocker source + status badge | `source`, `status` | `bookingSourceSchema`, `bookingStatusSchema` | `GET /sync-conflicts` | FE | [code] |
| Conflicts | per-blocker guest + dates | `guestName`, `checkIn`, `checkOut` | `blockingBookingSchema` | `GET /sync-conflicts` | raw | [code] |
| Conflicts | Dismiss button | - | none | `POST /sync-conflicts/:id/dismiss` | FE | [code] |
| Conflicts | error line (non-404) | - | none | - | FE | [code] |
| Payments | section heading + explanation | - | none | - | FE | [code] |
| Payments | amount | `amountIdr` | `lapsedPaymentSchema` | `GET /payments/lapsed` | raw | [code] |
| Payments | booking status badge | `bookingStatus` | `bookingStatusSchema` | `GET /payments/lapsed` | FE | [code] |
| Payments | guest + phone + email | `guestName`, `guestPhone`, `guestEmail` | `lapsedPaymentSchema` | `GET /payments/lapsed` | raw | [code] |
| Payments | property - unit | `propertyName`, `unitName` | `lapsedPaymentSchema` | `GET /payments/lapsed` | BE | [code] |
| Payments | stay + nights | `checkIn`, `checkOut` | `lapsedPaymentSchema` | `GET /payments/lapsed` | raw + FE | [code] |
| Payments | "view booking" link | `bookingId` | `lapsedPaymentSchema` | `GET /payments/lapsed` | raw | [code] |
| Payments | "Mark handled" button | - | none | `POST /payments/:id/handle` | FE | [code] |
| Payments | error line (non-404) | - | none | - | FE | [code] |
| Sidebar | count badge | - | none | both reads | FE | [code] |

`syncConflictSchema.externalUid`, `.status`, `.lastSeenAt`, `.closedAt`, `.propertyId`, `.unitId` and
`lapsedPaymentSchema.provider`, `.createdAt` are on the wire and **not rendered**.

`blockingBookings` is the interesting `BE` row: it is derived at read time by overlapping the conflict's
stay against the Unit's Occupying bookings, using the same `daterange &&` over the same
`OCCUPYING_STATUSES` the exclusion constraint uses - so it is exactly the set that caused the refusal,
and it is never stored, because which booking blocks changes as the owner works (ADR-0027).

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /sync-conflicts` | on mount **and on every `/app/*` page**, because the sidebar badge calls the same hook | section only | yes - `["sync-conflicts"]`, shared with the badge and invalidated by both Sync-now buttons |
| `GET /payments/lapsed` | same | section only | yes - `["lapsed-payments"]`, shared with the badge |
| `POST /sync-conflicts/:id/dismiss` | per row | mutation | n/a |
| `POST /payments/:id/handle` | per row | mutation | n/a |

**Two blocking reads**, and neither blocks the page - each blocks only its own section.

The badge and the page read **one cache entry each**: `use-inbox-count.ts` calls the sections' own hooks
rather than fetching again, so the number in the nav and the rows on the page cannot disagree
(`_list-pattern.md` §6.5).

---

## 5. States

Follows [`_list-pattern.md`](./_list-pattern.md). Deltas, and this page is where the pattern's sharpest
divergence lives:

- **Partial-failure policy: per-section.** The two queues share a page for workflow reasons only, so a
  failed conflicts read says nothing about lapsed payments (`_list-pattern.md` §3.5).
- **The two sections do not agree on empty or error**, which is D3 and D5 seen side by side:

  | | Sync conflicts | Lapsed payments |
  |---|---|---|
  | loading | *(nothing - returns `null`)* | `h-40` skeleton |
  | empty | *(nothing - the whole section disappears)* | "All clear" card |
  | error | *(nothing - identical to empty)* | bordered muted card |

  So on a good day the page has two sections, on a quiet day one, and on a bad day an owner cannot tell
  "no conflicts" from "the conflicts read failed".
- **page-spec §4.6 specifies an empty-inbox message** - *"no conflicts - calendars agree"* - which
  neither section renders.
- **A 404 on either mutation is treated as success** and suppressed (`_list-pattern.md` §3.3): the item
  was already handled elsewhere, or a sync resolved it between render and click.
- **Conflicts come first**, deliberately: a double-sold room has a guest arriving at a door, which beats
  a refund on the clock.

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| "Dismiss" | `POST /sync-conflicts/:id/dismiss` | that row's button → "Working…" | `onSettled` → invalidate `["sync-conflicts"]`; the row leaves because the server's predicate no longer matches | 404 swallowed; other → inline line under the row | no | yes - a guarded UPDATE writing only `status` + `closed_at` |
| "Mark handled" | `POST /payments/:id/handle` | that row's button → "Working…" | `onSettled` → invalidate `["lapsed-payments"]` | 404 swallowed; other → inline line | no | yes - already-handled returns the existing `handledAt` |
| "View booking" | `<Link>` → the detail page | navigation | - | - | n/a | yes |

Both mutations are per-row hooks, so one row's pending state does not spin every button. Neither
confirms: both are annotations, not destructions.

**There is deliberately no "Resolve" button.** Resolution means cancelling the blocking booking in the
real world, which the next sync *measures*; a button asserting it would let the client claim something
the exclusion constraint still refuses (ADR-0027).

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| A conflict is an imported VEVENT the exclusion constraint refused | BE | - | - |
| Which bookings block it, derived per read | BE | `blockingBookings` | - |
| Dismiss is a judgement no sync may undo; resolve is a measurement that can reopen | BE | `status` | - |
| Handling writes only `handled_at` - never the payment or the booking | BE | - | - |
| An item leaves a queue because the server's predicate stops matching, never by client removal | BE | - | - |
| The inbox count is open conflicts **plus** lapsed payments | FE | - | `leak: true` |
| Nights for each row | FE (shared helper) | `stay`, `checkIn`/`checkOut` | - |
| A 404 on dismiss/handle means "already gone", not an error | FE | - | - |
| Channel display labels | FE | `channel` | - |

One leak, and it is a definition rather than a calculation: nothing on the server answers "how many
things need me", so the client defines the inbox by summing two lists. If a third queue is ever added,
the badge is where it will be forgotten.

The 404 rule is FE and deliberately not a leak: it is a rendering decision about a server answer, not a
second opinion about state - the refetch that follows is what establishes the truth.

---

## 8. Schema implications

**None.** `syncConflictSchema`, `blockingBookingSchema`, `dismissSyncConflictResponseSchema`,
`lapsedPaymentSchema`, `markPaymentHandledResponseSchema` all exist.

*If the badge leak is closed*, the smallest change is a counts endpoint or two `X-Total-Count`-style
fields - a `packages/shared` addition with **no migration**.

---

## 9. Out of scope

- **Fixing either problem.** Cancelling the blocking booking is `/app/bookings/$bookingId`; the refund is
  offline (ADR-0011).
- **Per-Channel connection health.** The Property workbench.
- **Filtering by status or property.** The query schema supports both; the page sends neither.
- **The webhook and the import cron.** Boss fights #4 and #3 produce these rows; the page only shows them.

---

## 10. Open questions

- [ ] **The two sections disagree on loading, empty and error** (D3, D5). The conflicts section renders
  `null` for all three, so a failed read is invisible - on the page whose entire purpose is surfacing
  things that need attention. **Owner:** RacThug. **Blocks:** nothing; it is one branch.
- [ ] **page-spec §4.6 specifies empty-inbox copy that does not exist.** Write it, or drop the line?
  **Owner:** RacThug.
- [ ] **The inbox count is defined only in the client.** **Owner:** builder.
- [ ] **Both inbox reads fire on every `/app/*` page** because the sidebar badge shares their hooks.
  Correct for freshness, and it means two extra requests on every dashboard navigation. Acceptable?
  **Owner:** RacThug.
- [ ] **`lastSeenAt` and `closedAt` are fetched and never shown.** For an open conflict, "last seen" is
  the field that tells an owner whether the OTA is still offering the event. **Owner:** RacThug.
