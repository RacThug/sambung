# Sambung - Page Specification (v1)

> **What this is:** the UX contract - every page the SPA needs across M0-M5: what it is, what it does, which endpoints feed it, and the states it must handle.
> **What this is not:** visual design (that happens in the UI work per milestone) or API shapes (canonical in [`api-spec.md`](./api-spec.md) - referenced below as `api #n` using its §2 endpoint index).
> Routes are TanStack Router paths; **anything after `?` is a typed, zod-validated search-param schema** - URL state is part of each page's contract (ADR 2026-07-16).

---

## 1. Site map

The canonical, **code-verified** route map - every SPA page *and* every API endpoint, plus a
route-tree diagram and the FE↔API wiring - lives in **[`sitemap.md`](./sitemap.md)** and is enforced
against the real router by a test, so it cannot drift. This file is the per-page UX **detail** behind
those routes; `sitemap.md` is the index that links back into it.

Per-page template: **Purpose** (+ FR) · **Actor** · **Route & URL state** · **Data** (endpoints) · **Actions** (mutations) · **States** · **Edge notes**. Milestone tag in the heading.

---

## 2. Shared shell (applies to every page)

- **Auth guard (`/app/*`):** no access token in memory → silent `POST /auth/refresh` (api #3) once → on 401, redirect `/login?next=<current-url>`; after login, return to `next`. Access token lives in memory only; never in `localStorage`.
- **401-retry:** any API 401 triggers one silent refresh + retry (architecture §4.4); a second 401 logs out to `/login`.
- **Language switcher** (public pages + login): `en | id | zh`, persisted per visitor (`localStorage` - fine for a language *preference*; the never-localStorage rule is about tokens). Sent as `Accept-Language`. (FR-I18N-1, M5 for full copy coverage.)
- **Server state = TanStack Query** everywhere; no global store. Mutations invalidate the queries listed per page.
- **Error surfaces:** field-level for zod 400s (`message[].path` maps to inputs); toast for 5xx/network; full-page error boundary with retry as last resort. 404 route for unknown paths.
- **Money display:** `Rp 14.000.000` formatting from integer IDR; dates rendered in the visitor's locale but always transmitted as `YYYY-MM-DD`.

---

## 3. Public funnel

### 3.1 Property page - `/p/:slug` - **M1** (availability picker: M2)
- **Purpose:** the direct-booking landing page a guest reaches from an OTA profile or a shared link; converts lookers into bookers. (FR-PROP-1, G2)
- **Actor:** public · i18n from day one.
- **Route & URL state:** `?from&to` (optional dates) + `?unit` (preselected unit) - a shared URL reproduces the exact quote view.
- **Data:** `GET /public/properties/:slug` (api #22) once; per unit + date change: `GET availability` (api #23), debounced ~300 ms.
- **Sections:** photo gallery · name/address/description · **Verified badge** iff `verified` (FR-PROP-3) · unit cards (price/night, max guests, min stay) · availability picker + quote per unit.
- **Actions:** "Book" → `/p/:slug/book?unit&from&to` carrying the quoted range.
- **States:** loading skeleton · 404 (unknown slug) · picker: empty (no dates) / checking / **available + price** / blocked (localized `reasons`: `overlap` shows blocked ranges on the calendar, `min_stay` shows the minimum) · availability API error (retry inline, page still usable).
- **Edge:** the quote is advisory - checkout recomputes server-side; SEO tier-1: correct meta/OG tags per property (architecture §6).

### 3.2 Checkout - `/p/:slug/book` - **M2** (payment step: M3)
- **Purpose:** guest details → create the booking (hold) → hand off to payment. (FR-BOOK-1)
- **Actor:** public.
- **Route & URL state:** `?unit&from&to` **required** (zod-validated; invalid/missing → bounce back to `/p/:slug`).
- **Data:** re-quote on mount (api #23) - the price shown at submit is fresh.
- **Actions:** submit `{ guestName, guestContact }` → `POST /public/bookings` (api #24) → on 201, immediately `POST .../pay` (api #26) → redirect to Midtrans Snap; provider returns to `/booking/:id`.
- **States:** form + quote summary · submitting · **409 overlap** ("dates were just taken" - re-quote and show alternatives; this is the race the exclusion constraint decides) · 409 min-stay · pay-session failure after booking created → show hold countdown + "retry payment" (booking survives; hold = 15 min).
- **Edge:** a visible **hold countdown** (`holdExpiresAt`) after the booking exists; on expiry, state flips to "hold lapsed - pick dates again".

### 3.3 Confirmation - `/booking/:id` - **M3**
- **Purpose:** the page the guest lands on after payment (and the link in their email): live booking status + what happens next. (FR-PAY-1, FR-NOTIF-2)
- **Actor:** public (unguessable UUID is the access control - v1 trade-off, documented).
- **Data:** `GET /public/bookings/:id` (api #25) - **reconciles on read** (risk R3): if still `pending_payment`, the server double-checks the provider, so a lost webhook still confirms here. Poll every ~5 s while pending, stop on terminal status.
- **Actions:** "Send WhatsApp confirmation" button → opens the prefilled `wa.me` deeplink from the response (FR-NOTIF-2 AC) · "retry payment" when pending with live hold (api #26).
- **States:** confirmed (party view: dates, property, amount paid) · pending + spinner + hold countdown · expired ("hold lapsed") · cancelled · 404.

### 3.4 Login `/login` · Register `/register` - **Built** API, page **M1**
- **Purpose:** owner session start; signup creates tenant + owner (FR-AUTH-1).
- **Data/Actions:** api #2 / #1; on success store the access token in memory → `/app` (or `?next`).
- **States:** field validation (mirror the shared zod schemas client-side) · 401 "invalid credentials" (never says which field) · register 409 "email already registered" · already-authed → redirect `/app`.
- `/invite/:token` - **Built** (#57, FR-AUTH-2): previews who invited you and which Properties you'll manage, then takes a password → staff session (the API sets the refresh cookie exactly as login does, so accepting IS signing in). Unauthenticated - the token in the path is the credential. The email is **shown, never asked for**: a holder must not be able to redirect the seat. English only, and excluded from the language switcher - it is an operator account page, like the dashboard ([ADR-0024](adr/0024-the-funnel-speaks-three-languages-the-wire-speaks-one.md)). A spent link renders its reason and a link to sign in; an unknown one gets generic copy, so a guessed token learns nothing.

---

## 4. Dashboard (`/app/*`, auth)

### 4.1 Unified calendar - `/app/calendar` - **M2** (the home page)
- **Purpose:** one calendar across all properties; spot occupancy and clashes at a glance, color-coded by source (FR-CAL-3, flow 4.3).
- **Route & URL state:** `?from&to` (defaults: current month) `&propertyId?` - a filtered view is a shareable URL.
- **Data:** `GET /bookings?from&to[&propertyId]` (api #18), grouped by unit rows; overlap-window semantics mean bookings straddling the window edges appear.
- **Actions:** click empty range → "manual block / walk-in" dialog → `POST /bookings` (api #20; source `manual_block` or `direct`), invalidates #18 · click booking → detail drawer (§4.3).
- **States:** loading grid · empty tenant (onboarding prompt: "add your first property" → §4.4) · dialog 409 overlap (someone booked meanwhile - refresh view) · color legend: direct / airbnb / booking_com / vrbo / manual, holds hatched (`pending_payment`).
- **Edge:** hold rows show a countdown tooltip; `expired`/`cancelled` never render (they don't occupy).

### 4.2 Reservations - `/app/reservations` - **M2** (CSV: M5)
- **Purpose:** the operational list: find, filter, export (flow 4.3).
- **Route & URL state:** `?from&to&propertyId&status&source` - filters are typed search params.
- **Data:** api #18. **Actions:** row → §4.3 · "Export CSV" → api #19 (same filters, M5).
- **States:** table · empty-with-filters ("no matches") vs empty-tenant · loading.

### 4.3 Booking detail - `/app/bookings/:id` - **M2** (payment panel: M3)
- **Purpose:** everything about one reservation: guest, dates, source, price, payment status.
- **Data:** api #35 (`GET /bookings/:id`, full disclosure - guest phone/email + display names) - deep-linkable, so it fetches its own row rather than depending on a warm calendar cache; payment fields join M3.
- **Actions:** **Cancel** (api #21) with confirm dialog - explains dates free instantly; refunds are manual in v1 (response `refund` field) · for conflicts pointing here: "this booking blocks an OTA import" banner (M4, from api #32 lookup).
- **States:** per-status body (confirmed / pending + hold countdown / cancelled / expired) · cancel 409 (already terminal - refresh) · 404.

### 4.4 Properties - `/app/properties` - **Built** API (list), page **M1**
- **Purpose:** inventory home: list + create (FR-PROP-1).
- **Data:** api #7. **Actions:** create dialog → api #9 → navigate to §4.5.
- **States:** list with `publishable` indicator per property · empty (primary onboarding CTA) · create-form zod errors.

### 4.5 Property edit - `/app/properties/:id` - **M1** (channels tab: M4)
- **Purpose:** the workbench: details, photos, units - everything that makes the public page complete.
- **Data:** api #8 + #15; **Actions:**
  - Details form → api #10 (`licenseNo` ↔ Verified badge preview).
  - **Photos:** file picker → presign (api #12) → browser `PUT` to storage → persist/reorder keys (api #13). Progress per file; type/size errors from presign shown pre-upload.
  - **Units:** inline table → api #14/#15/#16; per-unit price/guests/min-stay. Rows are read-only until **Edit**; a **permanent add row** sits at the bottom (never a dialog), because a Unit is one sellable thing (ADR-0001), so 8 identical rooms are 8 creates in one sitting - Enter submits and the row clears for the next. A zero-priced unit is flagged **not sellable** on its own row: it's storable on purpose (a placeholder, not an error), it just doesn't count toward `publishable`. A duplicate name comes back as a **409** and renders on the name field, identically to a zod 400 - zod can't catch it, since it needs the other rows.
  - Per-unit **channels** section (M4): connect (api #28), list + status (api #29), disconnect (api #30 - shows "n imported bookings kept"), **Sync now** (api #31), copy **export .ics URL** (api #34) with "paste this into the OTA" helper (flow 4.1 step 5).
  - Link out: "view public page" → `/p/:slug` (+ `publishable` checklist when incomplete: needs ≥1 photo + ≥1 unit priced above zero).
  - Delete property → api #11; **409 path renders the reason** ("this property has n bookings - deleting it would destroy that history"). Delete is only for inventory nothing was ever booked on (ADR-0002); the copy says so up front rather than only on failure. Retiring inventory with history is archive (M2, #84).
- **States:** tab-level loading/saving · upload progress/failure per photo · unit delete 409 rendered on the row (same any-booking guard).

### 4.6 Operations inbox - `/app/inbox` - **M4**
> **There is no `/app/channels` page.** Per-Channel connection + health (connect, status, disconnect, copy export URL, Sync now) lives on the Property workbench's per-Unit Channels section (§4.5). What shipped as a standalone page is the **operations inbox** below.
- **Purpose:** the two "the system did the safe thing and now needs a human" queues in one place: **Sync conflicts** (#38 - a Channel sold nights Sambung already held) and **paid-but-lapsed Payments** (#120 - money captured after the Hold lapsed). (FR-SYNC-3)
- **Route & URL state:** none - each is a whole (small) list, acted on in place.
- **Data:** `GET /sync-conflicts` (api #32) + `GET /payments/lapsed` (#36); each conflict derives its blocking bookings at read time.
- **Actions:** conflict row → shows the OTA event vs the blocking booking → "open blocking booking" (§4.3, resolve = cancel one side; next sync auto-closes) or **Dismiss** (api #33, the Owner's judgement - a Sync never reopens it) · lapsed payment → **Mark handled** (#37, a marker only, never the ledger).
- **States:** empty inbox ("no conflicts - calendars agree") · open-conflict count **badged in the nav** · a conflict's blocking-booking list · loading skeleton.

### 4.7 Settings - `/app/settings` - **Built** (gallery cap #67, Team #57)
- **Purpose:** the tenant-wide knobs. Two: the **gallery cap** - how many photos each property may hold (#67, [ADR-0030](adr/0030-a-cap-is-a-preference-the-ceiling-is-the-guard.md)) - and the **Team** (#57, [ADR-0033](adr/0033-an-invite-is-a-hashed-single-use-grant.md)): invite a staff member scoped to chosen properties, see the roster with each person's assignments, change that access (a whole-set write - shortening the list is how access is removed), revoke a pending invite, remove an account. Per-property deposit % is **not** here - it lives on the property edit form (§4.5, api #10), because it is a per-property fact.
- **Data:** api #38. **Actions:** save the cap → api #39.
- **Copy carries the guarantee:** "Lowering this never deletes photos - a gallery already above the new limit stays as it is, and you simply can't add more until you remove some." That is the behaviour, not reassurance: the write blocks only growth.
- **States:** owner sees the forms; **staff sees the gallery cap read-only** with "only an account owner can change this", and the Team section as one explanatory sentence rather than a form - the owner-only reads are never even issued, so a staff member's session produces no stray 403s. (The server enforces all of it: the writes are 403 for staff, which explains the role, never the existence.) Loading skeleton; field error on an out-of-bounds cap, rendered from the same shared schema the API validates with. Removing a staff account asks for confirmation - it is not undone by another click.
- **Edge notes:** the property workbench's photo section reads the cap from here (one `["settings"]` cache key), so raising the cap unblocks "Add photos" without a reload. Until that query resolves, the workbench disables **Add photos** rather than guessing a limit.

---

## 5. Completeness cross-check (every endpoint has a home)

| api # | Consumed by |
|---|---|
| 1-5 | §3.4 login/register + shell auth guard |
| 6 | §4.7 settings (M5) + `/invite/:token` |
| 7-16 | §4.4 properties list · §4.5 property edit |
| 17 | (folded into §4.1 via #18; per-unit calendar view optional later) |
| 18-21, 35 | §4.1 calendar · §4.2 reservations · §4.3 detail (#35 = the deep-linkable single-booking read) |
| 22-24 | §3.1 property page · §3.2 checkout |
| 25-26 | §3.3 confirmation · §3.2 checkout |
| 27 | no page - machine consumer (payment provider) |
| 28-31, 34 | §4.5 property edit (channels section) - note #31 "Sync now" has no FE consumer yet |
| 32-33 | §4.6 conflict inbox |
| 36-37 | §4.6 inbox (paid-but-lapsed payments) |
| 38-39 | §4.7 settings · §4.5 property edit reads #38 for the gallery cap |

Two endpoints intentionally have no page (#27 webhook, #34 iCal export - machines). One endpoint (#17) is currently redundant with #18 for the unified view - keep it spec'd for a per-unit calendar widget, or drop it at M2 if unused. **If a future endpoint lands without a row here (or a page without endpoints), one of the two specs is lying - fix in the same PR.**

## 6. Out of scope (v1)

Marketing/landing site (root redirects to login; guests arrive via direct property links) · guest accounts · owner mobile layouts beyond responsive basics · notification preferences UI · theme switching.
