---
route: /app/properties/$propertyId
status: shipped
prd_section: "FR-PROP-1 · FR-PROP-2 · FR-PROP-3 · FR-SYNC-1 · FR-SYNC-3"
adrs: [ADR-0001, ADR-0002, ADR-0004, ADR-0005, ADR-0006, ADR-0012, ADR-0015, ADR-0016, ADR-0025, ADR-0028, ADR-0030, ADR-0032]
verified: true
---

# Property workbench - `/app/properties/$propertyId`

> Migrated from [`../page-spec.md`](../page-spec.md) §4.5. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/properties/{property-edit-page, photos-section, units-section,
> channels-section, verified-badge}.tsx`, `apps/web/src/features/settings/use-settings.ts`, and
> `packages/shared/src/{property, unit, photo, channel, settings, conflict, money}.ts`.
>
> The largest page in the app: six independent sections over fourteen endpoints. The per-Unit
> **Prices** panel (PRD-product P0-2) was amended in as a draft and built in the same PR; its
> `[code]` rows read from `prices-section.tsx` at that PR's head.

---

## 1. Purpose

Everything that makes one Property's public page complete and its calendars synced - details, photos,
Units, per-Unit Channels, and per-Unit Prices - plus the two owner-only verbs that retire or destroy it.
*(page-spec §4.5; Prices added by the P0-2 amendment)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | A card on `/app/properties`, and automatically after creating a Property. |
| **Exits to** | `/p/$slug` (the public page, new tab), `/app/settings` (from the gallery-full hint), `/app/properties` (after a successful delete), `/app/inbox` (a connection's conflict badge). |
| **URL params** | `$propertyId`. Unknown or cross-tenant → renders "Property not found." Unassigned, for Staff → also 404 from RLS, so the same copy. |
| **Query state** | None. Five sections, no filters, no shareable sub-view. |
| **Not in the URL** | Which Unit row is being edited, upload progress, copy-confirmation flashes, per-connection sync results. |
| **Auth** | Authed. Staff may do everything **inside** an assigned Property; archive, unarchive and delete are owner-only and are **hidden**, not disabled (ADR-0032's verb line: the Owner decides the shape of the Tenant). |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Header | title | `name` | `propertyResponseSchema` | `GET /properties/:id` | raw | [code] |
| Header | Verified badge | `verified` | `propertyResponseSchema` | `GET /properties/:id` | BE | [code] |
| Header | "Archived" pill | `archivedAt` | `propertyResponseSchema` | `GET /properties/:id` | FE | [code] |
| Header | public URL + copy button | `slug` | `propertyResponseSchema` | `GET /properties/:id` | FE | [code] |
| Header | "offline while archived" struck-through URL | `archivedAt`, `slug` | `propertyResponseSchema` | `GET /properties/:id` | FE | [code] |
| Banner | "retired" notice | `archivedAt` | `propertyResponseSchema` | `GET /properties/:id` | FE | [code] |
| Banner | "incomplete" notice | `publishable` | `propertyResponseSchema` | `GET /properties/:id` | BE | [code] |
| Details | name | `name` | `updatePropertyRequestSchema` | `PATCH /properties/:id` | raw | [code] |
| Details | address | `address` | `updatePropertyRequestSchema` | `PATCH /properties/:id` | raw | [code] |
| Details | latitude / longitude | `latitude`, `longitude` | `updatePropertyRequestSchema` | `PATCH /properties/:id` | raw | [code] |
| Details | time-zone select | `timeZone` | `propertyTimeZoneSchema` | `PATCH /properties/:id` | raw | [code] |
| Details | time-zone labels ("WITA - Bali…") | - | none | - | FE | [code] |
| Details | description | `description` | `updatePropertyRequestSchema` | `PATCH /properties/:id` | raw | [code] |
| Details | licence number | `licenseNo` | `updatePropertyRequestSchema` | `PATCH /properties/:id` | raw | [code] |
| Details | **live** Verified preview | `licenseNo` (unsaved) | `isVerified` | - | FE | [code] |
| Details | deposit % | `depositPct` | `depositPctSchema` | `PATCH /properties/:id` | raw | [code] |
| Details | "Saved" / error line | - | none | - | FE | [code] |
| Photos | gallery images | `photos[].url` | `propertyResponseSchema` | `GET /properties/:id` | raw | [code] |
| Photos | "Cover" badge on the first | `photos[0]` | `propertyResponseSchema` | `GET /properties/:id` | FE | [code] |
| Photos | per-file progress | - | none | - | FE | [code] |
| Photos | per-file type / size / cap errors | - | `photoContentTypeSchema`, `MAX_PHOTO_SIZE_BYTES` | - | FE | [code] |
| Photos | "Gallery is full (N photos)" | `galleryCap` | `tenantSettingsResponseSchema` | `GET /settings` | FE | [code] |
| Photos | settings-failed line + **Retry** | - | none | - | FE | [code] |
| Photos | upload target | `uploadUrl`, `key` | `presignPhotoResponseSchema` | `POST /properties/:id/photos/presign` | raw | [code] |
| Units | name / price / guests / min-stay | `name`, `basePriceIdr`, `maxGuests`, `minStay` | `unitResponseSchema` | `GET /properties/:propertyId/units` | raw | [code] |
| Units | "Archived" pill | `archived` | `unitResponseSchema` | `GET /properties/:propertyId/units` | BE | [code] |
| Units | "not sellable" pill | `basePriceIdr` | `isSellable` | `GET /properties/:propertyId/units` | FE | [code] |
| Units | archive / unarchive verb | `archivedAt` | `unitResponseSchema` | `GET /properties/:propertyId/units` | FE | [code] |
| Units | add row inputs | `name`, `basePriceIdr`, `maxGuests`, `minStay` | `createUnitRequestSchema` | `POST /properties/:propertyId/units` | raw | [code] |
| Units | edit row inputs | `name`, `basePriceIdr`, `maxGuests`, `minStay` | `updateUnitRequestSchema` | `PATCH /units/:id` | raw | [code] |
| Units | duplicate-name error on the field | `code` | `conflictBodySchema` | `POST /properties/:propertyId/units` | BE slug → FE prose | [code] |
| Units | delete-guard error + count | `code`, `count` | `conflictBodySchema` | `DELETE /units/:id` | BE slug + data → FE prose | [code] |
| Prices | override rows: "First night - Last night, Rp N / night" | `from`, `to`, `nightlyPriceIdr` | `priceOverrideResponseSchema` | `GET /units/:unitId/price-overrides` | raw (FE renders `to - 1` as "Last night" via `lastNightOf`) | [code] |
| Prices | base-price line ("all other nights: Rp N") | `basePriceIdr` | `unitResponseSchema` | `GET /properties/:propertyId/units` | raw | [code] |
| Prices | add form: first night, last night, nightly price | `from`, `to`, `nightlyPriceIdr` | `createPriceOverrideRequestSchema` | `POST /units/:unitId/price-overrides` | raw | [code] |
| Prices | overlap error on the form | `code` | `conflictBodySchema` | `POST /units/:unitId/price-overrides` | BE slug → FE prose | [code] |
| Prices | remove verb per row | - | - | `DELETE /price-overrides/:id` | - | [code] |
| Channels | export `.ics` URL | `unit.id` | `unitResponseSchema` | `GET /public/units/:id/calendar.ics` | FE | [code] |
| Channels | channel label | `channel` | `channelSchema` | `GET /units/:unitId/channels` | FE | [code] |
| Channels | status pill | `lastStatus` | `syncStatusSchema` | `GET /units/:unitId/channels` | FE | [code] |
| Channels | `lastError` line | `lastError` | `channelConnectionResponseSchema` | `GET /units/:unitId/channels` | raw | [code] |
| Channels | conflict-count badge → inbox | `openConflicts` | `channelConnectionResponseSchema` | `GET /units/:unitId/channels` | BE | [code] |
| Channels | feed URL | `importIcalUrl` | `channelConnectionResponseSchema` | `GET /units/:unitId/channels` | raw | [code] |
| Channels | connect form (channel + URL) | `channel`, `importIcalUrl` | `createChannelConnectionRequestSchema` | `POST /units/:unitId/channels` | raw | [code] |
| Channels | already-connected options disabled | `channel` | `channelConnectionResponseSchema` | `GET /units/:unitId/channels` | FE | [code] |
| Channels | duplicate-connection error | `code` | `conflictBodySchema` | `POST /units/:unitId/channels` | BE slug → FE prose | [code] |
| Channels | "Synced. N imported, M cancelled, K clashed" | `imported`, `cancelled`, `conflicts` | `syncConnectionResponseSchema` | `POST /channels/:id/sync` | BE → FE sentence | [code] |
| Channels | "Disconnected. N imported bookings kept" | `importedBookingsKept` | `disconnectChannelResponseSchema` | `DELETE /channels/:id` | BE → FE sentence | [code] |
| Archive | zone title + copy | `archivedAt` | `propertyResponseSchema` | `GET /properties/:id` | FE | [code] |
| Danger | delete-guard error + count | `code`, `count` | `conflictBodySchema` | `DELETE /properties/:id` | BE slug + data → FE prose | [code] |

`lastSyncedAt` and `createdAt` are on `channelConnectionResponseSchema` and are **not rendered**;
`galleryCeiling` is fetched with the cap and read only by `/app/settings`.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /properties/:id` | on mount; `retry: false` on 404 | **yes, whole page** | yes - `["properties", id]`, and the photo PATCH paints its response straight into this key |
| `GET /properties/:propertyId/units` | on mount, **twice** (Units and Channels sections use the same key, so Query dedupes) | section only | yes - `["properties", id, "units"]` |
| `GET /settings` | when the photo section mounts | no - only "Add photos" waits | yes - `["settings"]`, shared with `/app/settings`, `staleTime` 5 min |
| `GET /units/:unitId/channels` | once **per Unit** | section only | per-unit key |
| `GET /units/:unitId/price-overrides` | when a Unit's Prices panel is expanded (collapsed by default - most Units, most days, have no override; also keeps the mount fan-out from growing, §10) | panel only | per-unit key `["units", unitId, "price-overrides"]` |
| `PATCH /properties/:id` | Save details | mutation | n/a |
| `POST /properties/:id/photos/presign` | per file | mutation | n/a |
| `PATCH /properties/:id/photos` | after each upload, and on reorder / remove | mutation | n/a |
| `POST /properties/:propertyId/units` · `PATCH /units/:id` · `DELETE /units/:id` · `POST /units/:id/archive`·`/unarchive` | per row | mutations | n/a |
| `POST /units/:unitId/channels` · `DELETE /channels/:id` · `POST /channels/:id/sync` | per connection | mutations | n/a |
| `POST /properties/:id/archive`·`/unarchive` · `DELETE /properties/:id` | owner-only zones | mutations | n/a |

**One blocking read**, but the request *count* is the highest in the app: a Property with 8 Units issues
`1 + 1 + 1 + 8 = 11` reads on mount. Recorded in §10.

---

## 5. States

Follows [`_list-pattern.md`](./_list-pattern.md). Deltas:

- **Loading is a line of text that replaces the header** (D1), gated on `isLoading` (D2).
- **There is no error branch**: any post-loading failure renders `Property not found.`, so a network blip
  claims a 404 (D5). This page is the second-clearest instance after `/app/properties`.
- **The photo section is the app's only degrade-and-retry** partial-failure policy (`_list-pattern.md`
  §3.5): a failed `["settings"]` read blocks only "Add photos" and offers the app's one dashboard
  **Retry**; removing and reordering stay live, because neither needs the cap.
- **Each of the five sections has its own loading and empty treatment**, and Units, Channels and the
  per-Unit connection lists all use an inline sentence rather than a card (D4) and have no error branch
  at all (D5).
- **The Prices panel is collapsed per Unit and fetches on expand** - most Units, most
  days, have no override, and the mount fan-out is already the app's highest (§10). An archived
  Property makes it read-only exactly like the Units section; the override list stays visible.
- **Archive changes the page's shape, not just a badge**: the incomplete banner is replaced by the
  retirement notice, the Units add-row disappears, per-Unit edit and archive controls disappear, and new
  Channel connections are refused - while the export `.ics` link stays live, because the feed is
  archive-blind on purpose (ADR-0016).

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| Save details | `PATCH /properties/:id` | button → "Saving…" | "Saved" + invalidate `["properties"]` | 400 → fields; non-`ApiError` → generic | no | yes |
| Copy public link / export URL | clipboard write | label → "Copied" for 2 s | - | silent | no | yes |
| Add photos | presign → PUT → `PATCH …/photos` per file, sequentially | per-file progress bar | `setQueryData` the fresh row, invalidate the list | per-file error line + Dismiss | no | yes - a whole-set write |
| Reorder / remove a photo | `PATCH …/photos` | buttons disable while busy | same | inline line | no | yes |
| Add / edit a Unit | `POST` / `PATCH` | button → "Saving…"; Enter submits | invalidate `["properties"]` prefix so `publishable` moves in the same paint; add-row clears and refocuses | 409 → **on the name field**; 400 → fields; other → row-spanning line | no | **no** for add - the name unique is what catches a double submit |
| Archive / unarchive a Unit | `POST /units/:id/archive`\|`/unarchive` | button → "Archiving…" | invalidate `["properties"]` | inline line | no | yes |
| Delete a Unit | `window.confirm` → `DELETE /units/:id` | button → "Deleting…" | invalidate `["properties"]` | 409 → the guard's count as prose; other → generic | no | yes |
| Add a price override | `POST /units/:unitId/price-overrides` | button → "Saving…" | invalidate `["units", unitId, "price-overrides"]` only - quotes are computed server-side, so no other key holds a stale price | 409 → `price_override_overlap` on the form; 400 → fields | no | **no** - the exclusion constraint is what catches a double submit |
| Remove a price override | `DELETE /price-overrides/:id` | row buttons disable | invalidate the same key | 404 swallowed (already gone = done); other → inline | no | yes |
| Connect a channel | `POST /units/:unitId/channels` | button → "Connecting…" | invalidate the connection list, clear the form | 409 → on the channel field; 400 → fields | no | **no** - the `(unit, channel)` unique is what catches it |
| Sync now (one feed) | `POST /channels/:id/sync` | button → "Syncing…" | invalidate connections + `["bookings"]` + `["sync-conflicts"]`, then the summary line | inline "Sync failed" | no | yes |
| Disconnect | `window.confirm` → `DELETE /channels/:id` | button → "Disconnecting…" | invalidate connections, show kept-count | inline line | no | yes |
| Archive / unarchive the Property | `POST …/archive`\|`/unarchive` | button label swaps | invalidate `["properties"]` | inline line | no | yes |
| Delete the Property | `window.confirm` → `DELETE /properties/:id` | button → "Deleting…" | invalidate, navigate to `/app/properties` | 409 → the guard's count as prose | no | yes |

Four `window.confirm` calls here - every one of the app's uses except booking-cancel (D10).

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| Verified = a licence is on file | BE | `verified` | - |
| The same rule, previewed live from the unsaved input | FE | `licenseNo` | `leak: true` |
| Publishable = ≥1 photo and ≥1 priced, active Unit | BE | `publishable` | - |
| Effective-archived = the Unit's flag OR its Property's | BE | `archived` | - |
| An archived Property makes its whole Units section read-only | FE | `archivedAt` | `leak: true` |
| An archived Unit hides its edit affordance | FE | `archivedAt` (own flag) | - |
| A Unit priced at zero is "not sellable" | FE (shared helper) | `basePriceIdr` | - |
| The gallery is full at `length >= cap` | FE | `galleryCap` | `leak: true` |
| A write may never **grow** a gallery past the cap | BE | - | - |
| Photo type and size limits | FE (pre-check) + BE (signed) | - | - |
| One connection per (Unit, Channel) | FE (disabled options) + BE (unique) | `channel` | `leak: true` |
| Delete only if never booked, with the count as data | BE | `code`, `count` | - |
| Archive is idempotent and reversible | BE | `archivedAt` | - |
| Disconnect keeps imported bookings | BE | `importedBookingsKept` | - |
| A retired Property's public URL is offline but reserved | FE (display) / BE (404) | `slug`, `archivedAt` | `leak: true` |
| A night's price = the override covering it, else the base | BE - inside `quote()`, the one price/interval authority | `totalPriceIdr` | - |
| Overrides on one Unit never overlap | BE - exclusion constraint `price_override_no_overlap`; the form's 409 is UX (invariant #5) | `from`, `to` | - |
| A booking's price is a snapshot; a later override never re-prices it | BE - already true (`total_price_idr` written at booking, ADR-0015 snapshots the payment) | `totalPriceIdr` | - |
| Owner walk-ins price through the same overrides | BE - `sweepQuoteOrThrow` calls the same `quote()` (ADR-0011) | `totalPriceIdr` | - |
| Override ranges are half-open on the wire, "First/Last night" in the UI | FE (shared helper `lastNightOf` - not a leak) | `to` | - |

**Five leaks**, still the most of any page - which is what makes this the workbench: it is where the owner's
mental model of "what state is this thing in" is rendered, and almost every one of those states is
derived client-side from two nullable timestamps.

Two closed since the migration: effective-archived is now a server-derived `archived` field, and the
"archived Unit hides its edit affordance" rule reads the Unit's OWN `archivedAt`, which is the correct
question for a verb that acts on that flag.

`isSellable` is FE but **not** a leak: it is the shared helper, called rather than re-implemented - and
the public property page now calls it too.

---

## 8. Schema implications

**None.** Every field cited exists: `propertyResponseSchema`, `updatePropertyRequestSchema`,
`propertyTimeZoneSchema`, `depositPctSchema`, `unitResponseSchema`, `createUnitRequestSchema`,
`presignPhotoResponseSchema`, `updatePhotosRequestSchema`, `tenantSettingsResponseSchema`,
`channelConnectionResponseSchema`, `createChannelConnectionRequestSchema`,
`syncConnectionResponseSchema`, `disconnectChannelResponseSchema`, `conflictBodySchema`, `isVerified`,
`isSellable`, `isArchived`.

**Closed:** `unitResponseSchema` gained a derived `archived` (api-spec §4.6, amended), so this page no
longer computes effective-archived at all. No migration was needed - both `archived_at` columns already
existed and the read already joined `property`.

**P0-2 (built):** the Prices amendment's schema work, all landed with migration 0017:

| Change | Table / package | Migration | Why |
|---|---|---|---|
| `unit_price_override` (id, `tenant_id`, `unit_id`, `from date`, `to date`, `nightly_price_idr bigint`) | `packages/db` | `0017_unit_price_override.sql` | The dated price layer over `base_price_idr` (PRD-product P0-2) |
| composite FK `(unit_id, tenant_id) → unit (id, tenant_id)` | `packages/db` | same | A cross-tenant override unrepresentable, the #40 pattern |
| exclusion constraint `price_override_no_overlap` (`unit_id WITH =`, `daterange(from, to) WITH &&`) - hand-written SQL | `packages/db` | same | One authority for "no two prices for one night", the `booking_no_overlap` pattern; the app pre-check is UX only |
| CHECKs: `from < to`, `price_override_nightly_range` (`between 1 and 1000000000`) - the cap hand-copied from `unit_base_price_max`, pinned the same way; the floor is 1, not 0, because a zero override has no placeholder role (`isSellable` reads only the base) | `packages/db` | same | Keeps the #47 overflow argument: a 366-night stay sums to ≤ 366 × 1e9, far under `MAX_SAFE_INTEGER` |
| RLS policy with the `app_property_visible()` term (via the Unit's Property) - hand-written SQL | `packages/db` | same | Tenant isolation (invariant #2) + the Staff property axis (ADR-0032) |
| `priceOverrideResponseSchema` | `packages/shared` | n/a | The wire shape §3 cites |
| `createPriceOverrideRequestSchema` (`strictObject`, ADR-0031; `from < to` refine) | `packages/shared` | n/a | The one inbound body |
| `price_override_overlap` added to the closed `conflictCodeSchema` + `describeConflict` copy | `packages/shared` + web | n/a | ADR-0012: the 409 carries a code; the web owns the words |
| `quoteTotalIdr(basePriceIdr, nights)` → prices a night list: override covering the night, else base | `packages/shared` | n/a | The seam its own comment reserved: "a future seasonal model changes one function". Both #47's read and #48's write flow through it unchanged |
| `AvailabilityRepository.fetchUnitPricing` also fetches overrides clipped to the window, inside the same `db.run` | `apps/api` | n/a | `quote()` stays the single authority; no second price read path |

---

## 9. Out of scope

- **Bookings.** The calendar, reservations and detail pages.
- **The sync-conflict inbox.** `/app/inbox`; this page only badges the count per connection, because one
  conflict is about two bookings across two systems - a reconciliation task, not a settings one.
- **The gallery cap itself.** `/app/settings` owns the number; this page reads it.
- **The iCal import pipeline.** Boss fight #3 runs on a cron (ADR-0025); "Sync now" only forces it.
- **Creating a Property.** `/app/properties`.
- **Rate plans, occupancy-based pricing, LOS rules, recurring weekend rules.** PRD-product P0-2 defers
  them by name (Channex-phase work). A weekend uplift is expressible today as explicit ranges.
- **Editing an override in place.** MVP is add + remove; a change is remove-then-add. Revisit if owners
  actually ask.
- **Calendar-visual price editing and per-night prices in the guest picker.** The range list is the MVP;
  the funnel keeps showing the server's total, which is already override-correct by construction.

---

## 10. Open questions

- [ ] **A Property with N Units issues N + 3 reads on mount.** Eight Units is eleven requests. There is
  no batched `GET /properties/:id/channels`. **Owner:** RacThug. **Blocks:** nothing today at portfolio
  scale.
- [ ] **Seven FE business rules, four of them the same effective-archived derivation.** See
  `app-calendar.md` §10 - closing it is an API-contract change, and this page is where the cost shows.
  **Owner:** RacThug.
- [ ] **No error branch: any failure reads as "Property not found."** D5, and here it is actively
  wrong copy. **Owner:** builder.
- [x] ~~**The web validates a Unit edit with the create schema.**~~ **Closed:** the edit row now parses
  with `updateUnitRequestSchema`, the same schema `units.controller.ts` validates the PATCH with.
  Clearing "guests" or "min stay" on an edit used to reset the stored value to the create-schema default
  (2 and 1); it now means "leave it alone", which is what PATCH means.
- [ ] **page-spec §4.5 documents neither `timeZone`, `depositPct`, the Archive zone, nor the public-link
  control.** Four shipped features with no spec line. This file records them. **Owner:** RacThug.
- [ ] **`lastSyncedAt` is fetched and never shown.** The status pill says "Synced" without saying when,
  which is the one thing an owner debugging a stale calendar wants. **Owner:** RacThug.
- [x] ~~**The public page's headline still reads `basePriceIdr` as "from Rp N / night".**~~
  **Closed (owner, 2026-08-17): keep the base as the headline** and document "base = your everyday
  price" in the Prices panel's helper copy; a computed "from" (min upcoming nightly) is polish, revisit
  if an owner models low-season discounts.
- [x] ~~**Can Staff manage prices?**~~ **Closed (owner, 2026-08-17): yes** - pricing an assigned Unit
  is operating it, exactly like the `basePriceIdr` edit Staff already have; the ADR-0032 verb line
  reserves tenant-shape verbs, not rates. No `@Roles` guard on the three routes.
- [x] ~~**REQ-PR-02/03 mapping.**~~ **Closed (owner, 2026-08-17):** nothing else hid behind REQ-PR-03;
  this amendment IS the whole requirement (dated overrides over base, funnel totals correct by
  construction). The EARS spec ids in `docs/spec/` reference PRD-product P0-2 directly.

