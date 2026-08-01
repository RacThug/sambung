---
route: /app/reservations
status: shipped
prd_section: "flow 4.3"
adrs: [ADR-0010, ADR-0014, ADR-0037]
verified: true
---

# Reservations - `/app/reservations`

> Migrated from [`../page-spec.md`](../page-spec.md) §4.2. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/reservations/*` and `packages/shared/src/{booking-list, booking,
> unit, property, availability}.ts`.

---

## 1. Purpose

The operational list: an **Owner** or **Staff** member finds, filters and exports Bookings of *every*
status, including the cancelled and expired ones the Calendar never draws. *(page-spec §4.2,
CONTEXT.md "Reservation")*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | The sidebar. |
| **Exits to** | `/app/bookings/$bookingId` (a row), `/app/calendar` (the empty-upcoming CTA). The CSV export is a download, not a navigation. |
| **URL params** | None. |
| **Query state** | `reservationsSearchSchema` - `?from&to&propertyId&status&source`. `status` and `source` are **repeatable set-params**, normalised from `undefined` / bare string / array, and written back in canonical order so `?status=a&b` and `?status=b&a` are one cache entry. Every field `.catch(undefined)`. |
| **Not in the URL** | Nothing. The whole view is a shareable link, which is the AC. |
| **Auth** | Authed; Staff narrowed by RLS. |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Header | page title | - | none | - | FE | [code] |
| Header | "Export CSV" button | - | none | - | FE | [code] |
| Filters | property select | `id`, `name` | `propertyResponseSchema` | `GET /properties` | raw | [code] |
| Filters | From / To date inputs | `?from`, `?to` | `reservationsSearchSchema` | - | raw | [code] |
| Filters | window error hint | - | none | - | FE | [code] |
| Filters | "showing upcoming" caption | - | none | - | FE | [code] |
| Filters | status chips | `status` | `bookingStatusSchema` | - | FE | [code] |
| Filters | source chips | `source` | `bookingSourceSchema` | - | FE | [code] |
| Filters | "Clear filters" | - | none | - | FE | [code] |
| Row | guest / title cell | `source`, `guestName` | `bookingRowSchema` | `GET /bookings` | FE | [code] |
| Row | property name | `propertyId` → `name` | `unitResponseSchema` + `propertyResponseSchema` | `GET /units`, `GET /properties` | FE | [code] |
| Row | unit name | `unitId` → `name` | `unitResponseSchema` | `GET /units` | FE | [code] |
| Row | check-in | `checkIn` | `bookingRowSchema` | `GET /bookings` | raw | [code] |
| Row | check-out | `checkOut` | `bookingRowSchema` | `GET /bookings` | raw | [code] |
| Row | source badge | `source` | `bookingSourceSchema` | `GET /bookings` | FE | [code] |
| Row | status badge | `status` | `bookingStatusSchema` | `GET /bookings` | FE | [code] |
| Row | total | `totalPriceIdr` | `bookingRowSchema` | `GET /bookings` | raw | [code] |
| Footer | "N reservations" | - | none | - | FE | [code] |
| (download) | CSV file | - | none | `GET /bookings/export.csv` | BE | [code] |
| (download) | filename | `?from`, `?to` | `reservationsSearchSchema` | - | FE | [code] |

`guestCount` and `holdExpiresAt` ride on `bookingRowSchema` and are not rendered in the table.

The property and unit name columns are `FE`: the server sends `unitId` only, and the view joins it to
the two flat lists it already holds (ADR-0010, composed not served).

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /properties` | on mount | **body only** | yes - `["properties"]` |
| `GET /units` | on mount | **body only** | yes - `["units"]`, so arriving from the calendar refetches neither |
| `GET /bookings?…` | on mount and on every filter change | **body only** | no - the key carries the whole filter set, and shares the `["bookings"]` prefix so a manual block on the calendar invalidates this list too |
| `GET /bookings/export.csv?…` | "Export CSV" | not a render path | n/a - fetched as a Blob through `api.getBlob`, never cached |

**Three blocking reads.** At the threshold, not over it.

The export shares **one query-string builder** with the list (`bookingsQueryString`), so "the file matches
what you are looking at" is true by construction rather than by a second implementation.

---

## 5. States

Follows [`_list-pattern.md`](./_list-pattern.md). Deltas:

- **The two empty states are the pattern's canonical example** (§2.2): "No upcoming reservations" when
  the untouched default window is empty, "No matches" when a filter excluded everything - chosen from
  `hasActiveFilters(search)`, which reads the URL, not the result count. A lone `from` counts as filtered,
  so the owner gets "no matches" plus the pair hint rather than a misleading "you have no bookings".
- **Partial-failure policy: all-or-nothing**, same reasoning as the calendar.
- **A lone or invalid window is never sent.** `resolveWindow` falls back to the default upcoming window
  and surfaces a hint, so the API's 400 for a lone edge is unreachable from this page.
- **The row count in the footer** is the only list-size feedback in the app (`_list-pattern.md` D12).

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| Any filter control | `navigate` with a **patched** search object | chips/inputs update; rows persist via `keepPreviousData` | new query | n/a | n/a | yes |
| "Clear filters" | `navigate` → `search: {}` | back to the default upcoming window | refetch | n/a | n/a | yes |
| Click a row | `navigate` → `/app/bookings/$bookingId` | navigation | - | n/a | n/a | yes |
| "Export CSV" | `GET /bookings/export.csv` → Blob → `<a download>` | button → "Exporting…" | file saves | inline "Export failed" | no | yes |

The row is reachable two ways on purpose: the row `onClick` is the mouse convenience, the guest-cell
`<Link>` is the keyboard and middle-click path, so there is no nested-interactive trap.

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| The default view is `[today, today + 366)` | FE | - | `leak: true` |
| A window must be a pair, `from < to`, at most 366 nights | FE **and** BE | `?from`, `?to` | `leak: true` |
| "Filtered" means the URL was touched, not that rows are few | FE | search params | - |
| Rows keep the server's check-in order; the client never re-sorts | FE (by omission) | - | - |
| A booking whose Unit is unknown is dropped rather than crashing | FE | `unitId` | - |
| A booking title is the guest, or "Manual block", or "Walk-in" | FE | `source`, `guestName` | `leak: true` |
| Filters are AND-ed; no filter means every status | BE | - | - |
| CSV escaping and formula-injection neutralisation | BE | - | - |

Three leaks. The window rules are the deliberate UX-vs-correctness split (invariant #5) - the client
checks so it never fires a request the boundary would 400 - but they are still a second copy of
`listBookingsQuerySchema`'s refinements. The booking-title rule encodes the Walk-in definition
(CONTEXT.md: a confirmed direct booking with no payment) as a display fallback.

---

## 8. Schema implications

**None.** `listBookingsQuerySchema`, `bookingRowSchema`, `unitResponseSchema`, `propertyResponseSchema`
and `MAX_AVAILABILITY_NIGHTS` all exist.

---

## 9. Out of scope

- **Editing a booking.** Only cancel exists, on the detail page.
- **Pagination.** Deliberately absent product-wide (api-spec §1, §9); the window is the filter.
- **Occupancy layout.** The Calendar's job.
- **Sorting controls.** The server sorts by check-in; see §7.

---

## 10. Open questions

- [ ] **Window validation exists on both sides.** `resolveWindow` re-implements
  `listBookingsQuerySchema`'s three refinements. Should the client import a shared predicate instead of
  restating them? **Owner:** builder.
- [ ] **The default window is a client decision with no server counterpart.** `[today, today + 366)` is
  invented in `reservations-model.ts`; a different client would show a different default list. **Owner:**
  RacThug.
- [ ] **page-spec §4.2 lists only api #18 as Data** and does not mention the default window or the
  lone-edge fallback. This spec records the code. **Owner:** RacThug.
