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
> The largest page in the app: five independent sections over eleven endpoints.

---

## 1. Purpose

Everything that makes one Property's public page complete and its calendars synced - details, photos,
Units, and per-Unit Channels - plus the two owner-only verbs that retire or destroy it.
*(page-spec §4.5)*

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

---

## 9. Out of scope

- **Bookings.** The calendar, reservations and detail pages.
- **The sync-conflict inbox.** `/app/inbox`; this page only badges the count per connection, because one
  conflict is about two bookings across two systems - a reconciliation task, not a settings one.
- **The gallery cap itself.** `/app/settings` owns the number; this page reads it.
- **The iCal import pipeline.** Boss fight #3 runs on a cron (ADR-0025); "Sync now" only forces it.
- **Creating a Property.** `/app/properties`.

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
