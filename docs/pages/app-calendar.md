---
route: /app/calendar
status: shipped
prd_section: "FR-CAL-3 · flow 4.3"
adrs: [ADR-0005, ADR-0007, ADR-0010, ADR-0011, ADR-0012, ADR-0025, ADR-0037]
verified: true
---

# Unified calendar - `/app/calendar`

> Migrated from [`../page-spec.md`](../page-spec.md) §4.1. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/calendar/{calendar-page, calendar-grid, source-legend, sync-now-button,
> manual-booking-dialog}.tsx`, `{calendar-model, calendar-search, use-calendar}.ts`, and
> `packages/shared/src/{booking-list, booking, unit, property, channel, conflict}.ts`.

---

## 1. Purpose

The dashboard home: one occupancy view across every Property an **Owner** or **Staff** member can see,
one row per Unit, every Occupying booking a bar coloured by source. *(page-spec §4.1)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | `/app` (the index redirects here), the sidebar, the wordmark, and the reservations empty state. |
| **Exits to** | `/app/bookings/$bookingId` (clicking a bar), `/app/properties` (every empty-state CTA), `/app/inbox` (from the Sync-now summary's "see Inbox" wording, as prose - not a link). |
| **URL params** | None. |
| **Query state** | `calendarSearchSchema` - `?from&to` (the visible window, defaulting to the current month) and `?propertyId`. Each `.catch(undefined)`, so a pasted bad value opens the current month rather than crashing the home page. |
| **Not in the URL** | The manual-booking dialog's open state and seed, and everything inside it. |
| **Auth** | Authed. Staff see only assigned Properties, narrowed by RLS - nothing on this page filters (ADR-0032). |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Header | page title | - | none | - | FE | [code] |
| Header | Sync-now result summary | `feeds`, `imported`, `cancelled`, `conflicts`, `errored` | `syncAllResponseSchema` | `POST /channels/sync` | BE → FE sentence | [code] |
| Toolbar | window label ("March 2027") | `?from`, `?to` | `calendarSearchSchema` | - | FE | [code] |
| Toolbar | prev / Today / next | - | none | - | FE | [code] |
| Toolbar | property filter options | `id`, `name` | `propertyResponseSchema` | `GET /properties` | raw | [code] |
| Legend | source swatches + labels | `source` | `bookingSourceSchema` | - | FE | [code] |
| Legend | "Hold (unpaid)" hatch | - | none | - | FE | [code] |
| Grid | property group headers | `name` | `propertyResponseSchema` | `GET /properties` | raw | [code] |
| Grid | unit row labels | `name` | `unitResponseSchema` | `GET /units` | raw | [code] |
| Grid | row "Archived" pill | `archived` | `unitResponseSchema` | `GET /units` | BE | [code] |
| Grid | day columns (date, weekday, weekend tint) | `?from`, `?to` | `calendarSearchSchema` | - | FE | [code] |
| Grid | bar position and width | `checkIn`, `checkOut` | `bookingRowSchema` | `GET /bookings` | FE | [code] |
| Grid | bar colour | `source` | `bookingRowSchema` | `GET /bookings` | FE | [code] |
| Grid | bar hatching (hold) | `status` | `bookingRowSchema` | `GET /bookings` | FE | [code] |
| Grid | bar label | `guestName` | `bookingRowSchema` | `GET /bookings` | FE | [code] |
| Grid | "continues" edge affordance | `checkIn`, `checkOut` | `bookingRowSchema` | `GET /bookings` | FE | [code] |
| Grid | bar tooltip (who, dates, nights, source, hold countdown) | `guestName`, `checkIn`, `checkOut`, `source`, `status`, `holdExpiresAt` | `bookingRowSchema` | `GET /bookings` | FE | [code] |
| Dialog | unit + property name | `unitName`, `propertyName` | `unitResponseSchema`, `propertyResponseSchema` | - | FE | [code] |
| Dialog | check-in / check-out | `checkIn`, `checkOut` | `createOwnerBookingRequestSchema` | `POST /bookings` | raw | [code] |
| Dialog | nights | - | `countNights` | - | FE | [code] |
| Dialog | guest name / phone / email / guests | `guestName`, `guestPhone`, `guestEmail`, `guestCount` | `createOwnerBookingRequestSchema` | `POST /bookings` | raw | [code] |
| Dialog | price placeholder + "leave blank for …" hint | `basePriceIdr` | `unitResponseSchema` | `GET /units` | FE | [code] |
| Dialog | 409 banner | `reasons` | `conflictBodySchema` | `POST /bookings` | BE slug → FE prose | [code] |

**Every visual property of a bar is FE.** The server returns whole booking rows (owner disclosure,
ADR-0010) and the client does all the geometry, because the exclusion constraint makes each Unit row a
non-overlapping sequence - there is no layout to centralise. See §7.

**`guestCount` and `totalPriceIdr` ride on `bookingRowSchema` and are not rendered here.** The tooltip
shows neither; the detail page does.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /properties` | on mount | **body only** | yes - `["properties"]`, shared with reservations, properties list, and the Team section |
| `GET /units` | on mount | **body only** | yes - `["units"]`, shared with reservations |
| `GET /bookings?from&to[&propertyId]&status×2` | on mount and on every window / property change | **body only** | no - keyed by window + filter; `keepPreviousData` so paging a month never flashes empty |
| `POST /channels/sync` | "Sync now" | mutation | n/a |
| `POST /bookings` | dialog submit | mutation | n/a |

**Three blocking reads** - at the threshold, not over it. All three block the *body* only; the header,
toolbar and legend paint immediately (`_list-pattern.md` §1.1).

The bookings query names the two occupying statuses explicitly via the shared `OCCUPYING_STATUSES`, which
a single-valued filter could not express - so a Cancelled or expired booking never draws a phantom bar.

---

## 5. States

Follows [`_list-pattern.md`](./_list-pattern.md). Deltas:

- **Empty has three variants**, not the pattern's usual two, and they are chosen from the *inventory*
  rather than the URL: no Properties → "Add your first property"; Properties but no Units → "Add a
  unit"; Units but all effectively archived → "No active units". All three link to `/app/properties`.
- **Partial-failure policy: all-or-nothing.** The three reads compose into one artifact - a booking row
  without its Unit and Property names is not a row that can be drawn - so any error replaces the whole
  grid (`_list-pattern.md` §3.5).
- **A row is not always drawn.** An *active* Unit always gets a row, even empty ("this villa is wide
  open"); an effectively-archived Unit gets one only if it carries a booking in the window, so retired
  empty inventory is not noise. A Property with no visible rows drops out entirely.
- **Sync-now reports inline, not by toast** (`role="status" aria-live="polite"` beside the button), which
  is the divergence `_list-pattern.md` D7 records.

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| ‹ / › / Today | `navigate` → `?from&to` | window label + grid move | new bookings query | n/a | n/a | yes |
| Property filter | `navigate` → `?propertyId` | grid narrows | refetch | n/a | n/a | yes |
| Click a bar | `<Link>` → `/app/bookings/$bookingId` | navigation | - | n/a | n/a | yes |
| Click an empty day (active Unit) | opens the dialog seeded with that Unit + date | dialog | - | n/a | n/a | yes |
| Dialog submit | `POST /bookings` | button → "Saving…" | invalidate `["bookings"]`, close | 400 → fields; 409 → banner from `reasons`; other → generic | no | **no** - a second submit would be a second Block/walk-in |
| "Sync now" | `POST /channels/sync` | button spins, status line reads "Syncing…" | invalidate `["bookings"]` + `["sync-conflicts"]` | inline "Sync failed" | no | yes - a re-pull re-imports nothing (ADR-0025) |

No confirm on the create dialog: a Block or walk-in is undone by cancelling it, which is one click on
the detail page (ADR-0011's universal free-the-dates verb).

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| Only Occupying bookings draw a bar | BE (filtered) / FE (the ask) | `status` | - |
| Effective-archived = the Unit's flag OR its Property's | BE | `archived` | - |
| An archived-and-empty Unit is dropped from the grid | FE | `archived`, bookings | `leak: true` |
| An archived Unit's day cells do not invite a create | FE | `archived` | - |
| A stay clips to the window; `end <= start` drops it | FE | `checkIn`, `checkOut` | `leak: true` |
| A Property with no visible rows is not rendered | FE | - | - |
| The default window is the current calendar month | FE | - | - |
| Overlap refusal (the one chokepoint) | BE | `reasons` | - |
| An archived Unit refuses a manual booking with `archived` | BE | `reasons` | - |
| min_stay and max_guests are **not** enforced for the owner | BE | - | - |

Two leaks, down from four. The other two closed together when `archived` moved server-side: api-spec §4.6 used to
*mandate* the client-side derivation, and amending it was the precondition for the change (ADR-0005
unaffected - what archive MEANS did not move, only who computes it).

What remains is the row rule (an archived-and-empty Unit is dropped from the grid) and the bar clip -
both view decisions about drawing, not domain facts, and neither has a server counterpart to defer to.

---

## 8. Schema implications

**None** for the page as built.

**Closed:** `unitResponseSchema` now carries a derived `archived`, computed in `apps/api` from the join
the read already performed - a `packages/shared` + `apps/api` change with **no migration**, since both
`archived_at` columns already existed.

---

## 9. Out of scope

- **Cancelling.** The detail page (page-spec §4.3); the calendar only links to it.
- **Every status.** This view shows Occupying bookings as bars; the Reservations list shows every status
  as rows (ADR-0010).
- **Per-Channel health.** The Property workbench's Channels section; only the tenant-wide "Sync now"
  lives here.
- **Conflict resolution.** `/app/inbox`.

---

## 10. Open questions

- [x] ~~**Effective-archived is derived in the browser in four places app-wide.**~~ **Closed:** the
  server derives it (`UnitResponse.archived`); api-spec §4.6 amended, with the old wording quoted so the
  reversal is legible. Three API tests pin it, one proven red against the pre-change derivation.
- [ ] **The window is replaced, not patched.** `calendar-page.tsx`'s `go()` writes the whole search
  object, so every handler must re-thread `propertyId` by hand. It works today; a fourth control would
  silently clear the filter (`_list-pattern.md` D9). **Owner:** builder.
- [ ] **The manual-booking submit is not idempotent.** A double submit creates two Blocks. **Owner:**
  builder.
- [ ] **page-spec §4.1 says a bar opens a "detail drawer"; it opens a page.** And its Data line names
  only api #18, while the page issues three reads. This spec records the code. **Owner:** RacThug.
