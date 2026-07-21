# Sambung - API Specification (v1)

> **What this is:** the map of every REST endpoint Sambung needs across M0-M5 - path, shape, and behavior.
> **What this is not:** the type source of truth. Canonical request/response types + zod schemas live in `packages/shared` (added per milestone); this doc names them.
> Status per endpoint: **Built** · **M1**..**M5** (matches PRD §7 milestones). FR-x references point to PRD §5.

---

## 1. Conventions (apply to every endpoint)

| Concern | Rule |
|---|---|
| Base path | All paths below are under the global prefix **`/api`**. One origin in prod (Caddy serves SPA + proxies `/api` - architecture §7). |
| Content type | `application/json; charset=utf-8`, except the iCal export (`text/calendar`). |
| Auth | `Authorization: Bearer <access token>` (~15 min, kept in memory by the SPA). Refresh token: httpOnly cookie `refresh_token`, `SameSite=Lax`, `Secure` in prod, **path-scoped to `/api/auth`**, 7 days. On 401 the client silently calls `/auth/refresh` once and retries. |
| Tenancy | Every authenticated request is scoped to the JWT's `tenantId` (app filter + Postgres RLS). A resource belonging to another tenant is indistinguishable from a nonexistent one: **404, never 403** - existence is hidden. `403` is reserved for *role* denials inside your own tenant (staff hitting owner-only routes, FR-AUTH-2). |
| Validation | Every external input (body, query, webhook, iCal) is parsed with the shared zod schema at the boundary. Failure → **400** with `message: [{ path, message }, ...]` (one entry per zod issue). |
| Error envelope | `{ "statusCode": number, "message": string \| object[], "error": string }` (NestJS envelope). Errors never leak internals: no SQL, no constraint values, no stack. |
| IDs | UUIDs. A malformed UUID in a path param → 400 before any lookup. |
| Dates | Calendar dates as `"YYYY-MM-DD"` strings. Stays are **half-open** `[checkIn, checkOut)` (db-design §4.2): checkout day is free for the next check-in. Timestamps are ISO-8601 UTC. |
| Money | Integer rupiah as JSON numbers (`totalPriceIdr: 14000000`). Never floats, never cents. Safe: IDR magnitudes sit far below 2^53. (Invariant #6.) |
| Availability | Always *derived* from booking rows - there is no availability resource to GET or PUT (invariant #3). "Occupying" = status `pending_payment` or `confirmed`. |
| Overlap truth | App-level availability checks are UX; the DB exclusion constraint is correctness (invariant #5). A lost race surfaces as the same **409** the pre-check would give. |
| Idempotency | Payment webhooks dedupe by `(provider, providerEventId)`; iCal imports by `(channelConnectionId, externalUid)`. Duplicates are acknowledged, never re-applied. (Invariant #7.) |
| Pagination | Deliberately deferred (portfolio scale). List endpoints take **date-window filters** instead (`?from&to`). Revisit if any list outgrows one screen. |
| i18n | Public endpoints accept `Accept-Language` / `?lang=en\|id\|zh` for localized *copy* in responses (e.g. availability messages). Data is language-neutral. (FR-I18N-1; mostly an SPA concern.) |

### Booking status FSM (db-design §5) - referenced throughout

```
direct booking:   (none) → pending_payment → confirmed
                                  │                │
                                  ├→ expired       └→ cancelled
                                  └→ cancelled
imported/manual:  (none) → confirmed → cancelled
```
Sources: `direct | airbnb | booking_com | vrbo | manual_block`. Transitions outside the FSM → 409.

---

## 2. Endpoint index

| # | Method + path | Purpose | Status | FR |
|---|---|---|---|---|
| 1 | `POST /auth/register` | Signup: tenant + owner + session | **Built** | AUTH-1 |
| 2 | `POST /auth/login` | Start session | **Built** | AUTH-1 |
| 3 | `POST /auth/refresh` | Rotate access token via cookie | **Built** | AUTH-1 |
| 4 | `POST /auth/logout` | Clear refresh cookie | **Built** | AUTH-1 |
| 5 | `GET /auth/me` | Current session | **Built** | AUTH-1 |
| 6 | `POST /auth/invites` (+ accept) | Invite staff scoped to properties | M5 | AUTH-2 |
| 7 | `GET /properties` | List my properties | **Built** | PROP-1 |
| 8 | `GET /properties/:id` | One property | **Built** | PROP-1 |
| 9 | `POST /properties` | Create property | M1 | PROP-1 |
| 10 | `PATCH /properties/:id` | Update (incl. `licenseNo` → badge) | M1 | PROP-1/3 |
| 11 | `DELETE /properties/:id` | Delete (guarded) | M1 | PROP-1 |
| 12 | `POST /properties/:id/photos/presign` | Presigned photo upload | **Built** | PROP-1 |
| 13 | `PATCH /properties/:id/photos` | Persist/reorder photo keys | **Built** | PROP-1 |
| 14 | `POST /properties/:id/units` | Create unit | **Built** | PROP-2 |
| 15 | `GET /properties/:id/units` | List units | **Built** | PROP-2 |
| 16 | `PATCH /units/:id` · `DELETE /units/:id` | Update/delete unit (guarded) | **Built** | PROP-2 |
| 17 | `GET /units/:id/calendar?from&to` | Owner calendar (all sources) | M2 | CAL-3 |
| 18 | `GET /bookings?from&to&propertyId&status&source` | Reservations list/filter | M2 | - |
| 19 | `GET /bookings/export.csv?…` | CSV export (same filters) | **Built** (#59) | - |
| 20 | `POST /bookings` | Manual block / walk-in | M2 | CAL-1 |
| 21 | `POST /bookings/:id/cancel` | Cancel (FSM) | M2 | - |
| 22 | `GET /public/properties/:slug` | Public property page data | **Built** | PROP-1 |
| 23 | `GET /public/units/:id/availability?from&to` | Availability + quote | M2 | CAL-1/2 |
| 24 | `POST /public/bookings` | Guest booking → hold | M2 | BOOK-1 |
| 25 | `GET /public/bookings/:id` | Confirmation-page status (reconciles) | M3 | PAY-1 |
| 26 | `POST /public/bookings/:id/pay` | Create sandbox payment session | M3 | PAY-1 |
| 27 | `POST /webhooks/payment/:provider` | Idempotent payment webhook | M3 | PAY-2 |
| 28 | `POST /units/:id/channels` | Connect an OTA iCal | M4 | SYNC-1 |
| 29 | `GET /units/:id/channels` | Connections + sync status | M4 | SYNC-3 |
| 30 | `DELETE /channels/:id` | Disconnect | M4 | SYNC-1 |
| 31 | `POST /channels/:id/sync` | Force "Sync now" | **Built** (#56) | SYNC-1 |
| 32 | `GET /sync-conflicts?status=open` | Conflict inbox | **Built** (#38) | SYNC-3 |
| 33 | `POST /sync-conflicts/:id/dismiss` | Dismiss a conflict | **Built** (#38) | SYNC-3 |
| 34 | `GET /public/units/:id/calendar.ics` | iCal export feed | M4 | SYNC-2 |
| 35 | `GET /bookings/:id` | Booking detail (owner, full disclosure) | M2 | - |
| 36 | `GET /payments/lapsed` | Paid-but-lapsed inbox (owner) | **Built** (#120) | PAY-2 |
| 37 | `POST /payments/:id/handle` | Mark a lapsed payment handled | **Built** (#120) | PAY-2 |

Notifications (FR-NOTIF-1/2) have **no endpoints**: email fires on the `confirmed` transition (webhook handler); the WhatsApp `wa.me` deeplink is a field on #25's response.

---

## 3. Auth - **Built** (M0)

Shared types: `packages/shared/src/auth.ts` (`registerRequestSchema`, `loginRequestSchema`, `authResponseSchema`, `meResponseSchema`).

### 3.1 `POST /auth/register` → 201
Creates a **tenant + its owner user atomically**, starts a session.
Body: `{ tenantName (2-120), email (≤254), password (8-200) }`.
Response: `AuthResponse = { accessToken, user: { id, email, role, tenantId }, tenant: { id, name } }` + refresh cookie. Password hash never appears in any response.
Errors: `400` zod; `409` `code: "email_taken"` (§8.2, ADR-0012) - including the **concurrent-signup race**: two simultaneous registers with one email → exactly one 201, one 409 (the citext UNIQUE is the guard; the pre-check is UX). Both layers throw the same factory, so the bodies are byte-identical. Test-proven.

### 3.2 `POST /auth/login` → 200
Body: `{ email, password }`. Same `AuthResponse` + cookie.
`401` for wrong email **and** wrong password - identical message, no account-existence oracle.

### 3.3 `POST /auth/refresh` → 200
No body - reads the `refresh_token` cookie (only sent to `/api/auth/*`). Returns fresh `AuthResponse`, re-sets the cookie. `401` when missing/invalid/expired, or the user no longer exists.

### 3.4 `POST /auth/logout` → 204
Clears the cookie. Always succeeds. (Access token simply ages out ≤15 min; v1 keeps no denylist - documented trade-off.)

### 3.5 `GET /auth/me` → 200 (auth)
`MeResponse = { user, tenant }`. `401` without/with a garbage token.

### 3.6 Staff invites - M5 (FR-AUTH-2)
`POST /auth/invites` (owner-only: email + propertyIds[]) → invite token emailed; `POST /auth/invites/accept` (token + password) → staff user scoped via `user_property`. Staff hitting owner-only routes (settings, billing, invites) → **403**. Requires the `user_property` tenant-consistency follow-up noted in #40.

---

## 4. Properties & photos - partially built, rest **M1**

### 4.1 `GET /properties` → 200 - **Built**
Tenant-scoped list, `createdAt` ascending. Empty tenant → `[]` (never other tenants' rows - the #34 "money shot" test).

### 4.2 `GET /properties/:id` → 200 - **Built**
`404` for another tenant's id or an unknown id (indistinguishable). `400` malformed UUID.

### 4.3 `POST /properties` → 201 · `PATCH /properties/:id` → 200 - M1
Fields: `name` (required, 2-160), `address?`, `latitude?`/`longitude?` (valid ranges), `description?`, `licenseNo?` (NIB). Response includes derived `verified: boolean` - true iff `licenseNo` is non-empty (FR-PROP-3). A public page needs ≥1 photo + ≥1 unit with a price **above zero** to render "complete" (FR-PROP-1 AC) - the API exposes `publishable: boolean` computed from that rule. A zero-rupiah unit is storable (§4.6) but never counts toward publishability: it's a placeholder, not a sellable listing. An **archived** unit (or any unit under an archived property) also never counts - `publishable` is `isSellable AND active`, so a property whose only priced unit is archived reports `publishable: false` (§4.8, [ADR-0005](adr/0005-archived-is-derived-not-cascaded.md)). `PropertyResponse` and `UnitResponse` carry `archivedAt: string | null` (the owner sees their own retired inventory); the public payload never does.

### 4.4 `DELETE /properties/:id` → 204 - **Built** (M1)
**Guarded:** if **any** booking has ever referenced a unit under it - past, cancelled and expired included - → `409` naming the count **and pointing to archive as the exit** (§4.8). Same rule for `DELETE /units/:id`. Delete is only for inventory that was never booked; retiring inventory that has history is **archive** (§4.8, #84) - the two are orthogonal verbs, delete destroys the row, archive hides it and keeps the ledger.

The `409` carries `code: "property_has_bookings"` / `"unit_has_bookings"` with the `count` as structured **data**, not baked into an English sentence - the web composes "this unit has 14 bookings…" and can localize it (§8.2, ADR-0012, #82). Two layers, per invariant #5: the service guard produces the count, and both `booking → unit` FKs are `on delete no action` so the database refuses too ([ADR-0002](adr/0002-deleting-inventory-never-destroys-the-ledger.md)). The FK is deliberately **not** mapped in the constraint map - the guard locks the unit before counting, so nothing can slip in behind it, and a FK that fires anyway means a code path skipped the guard: a 500, not a 409.

> **Superseded:** this used to read "*future occupying* booking → 409 … (cancel bookings first)". That guard protected the calendar, not the ledger - it never saw past or cancelled bookings, so `DELETE` returned 204 and cascaded them, and their `payment` rows, into nothing. "Cancel them first" is also gone: cancelling doesn't remove the row, so it promised an escape that doesn't exist.

### 4.5 Photos - **Built** (#39, architecture §3.6)
Shared types: `packages/shared/src/photo.ts` (`presignPhotoRequestSchema`, `presignPhotoResponseSchema`, `updatePhotosRequestSchema`).
- `POST /properties/:id/photos/presign` body `{ contentType, size }` → 201 `{ uploadUrl, key, expiresInSeconds }`. Validates: content type in `image/jpeg|png|webp`, `size ≤ 5 MB`, property ownership. Key is tenant-prefixed (`<tenantId>/<propertyId>/<uuid>.<ext>`). Browser PUTs bytes directly to storage (Garage dev / R2 prod) - the API never proxies bytes. Content type **and** length are signed headers: an upload that doesn't repeat them exactly fails at the storage layer (403), test-proven against Garage.
- `PATCH /properties/:id/photos` body `{ keys: string[] }` (ordered, ≤ 30, all must carry the caller's `<tenantId>/<propertyId>/` prefix - a key for another tenant OR another own property → 400) → 200 full `PropertyResponse`. Persist + reorder + delete in one idempotent set-operation. Keys **new to the gallery** must reference a real uploaded image - one ranged GET verifies existence + magic bytes against the stored content type (presigned-but-never-uploaded or junk-bytes-as-jpeg → 400); already-persisted keys are trusted, so reorders cost nothing. Orphaned objects are GC'd out-of-band (deferred).
- `PropertyResponse` carries `photos: [{ key, url }]` (order = gallery order, url = `STORAGE_PUBLIC_BASE_URL/<key>`); `publishable` counts these photos.

### 4.6 Units - **Built** (#45)
`POST /properties/:id/units` → 201, `GET /properties/:id/units` → 200 (`createdAt` asc, **includes archived** - it's the owner's history), `PATCH /units/:id` → 200, `DELETE /units/:id` → 204 (guarded, §4.4), `POST /units/:id/archive` → 200, `POST /units/:id/unarchive` → 200 (§4.8).
`GET /units` → 200 (auth) - **Built** (#49): a flat, tenant-wide list of every unit (archived included), `createdAt` asc. The unified calendar composes its row skeleton from this + `GET /properties` + `GET /bookings` ([ADR-0010](adr/0010-the-calendar-is-composed-not-served.md)); #50's manual-block dialog and #51's filters reuse it. Effective-archived (the unit's own flag OR its property's) is DERIVED client-side from this joined with `GET /properties` - both carry their own `archivedAt` - not a server flag. Same `unitResponseSchema` as the nested list.
Shared types: `packages/shared/src/unit.ts` (`createUnitRequestSchema`, `updateUnitRequestSchema`, `unitResponseSchema`, `isSellable`, `isArchived`).

Fields: `name`, `basePriceIdr` (int, `0 ≤ price ≤ 1,000,000,000`; a 0 price is storable but keeps the property unpublishable - §4.3), `maxGuests` (int ≥ 1, default 2), `minStay` (nights, int ≥ 1, default 1). The DB CHECKs mirror these bounds - a bypassed app check still cannot store garbage. The nightly-rate ceiling is a domain bound (no real rate approaches a billion rupiah) that also keeps `basePriceIdr × nights` from overflowing the §5.1 availability quote - `unit_base_price_max`, added after the #47 review found a write-accepted price × a long window could 500 the no-auth endpoint. Every field is mutable: a booking snapshots its own `totalPriceIdr`, and `minStay` applies when booking, so neither is retroactive. `404` for another tenant's property or unit id (indistinguishable from unknown).

**A Unit is one sellable thing, not a room type with a quantity** ([ADR-0001](adr/0001-unit-is-one-sellable-thing.md)): three identical garden rooms are three units. `name` is therefore `unique(property_id, name)` → `409` `code: "unit_name_taken"` (§8.2, ADR-0012) on a duplicate within one property (two *different* properties may each have a "Garden Room"). This is the one unit constraint that IS mapped in the constraint map - zod cannot check it, since the answer depends on the other rows, so the DB isn't a backstop here, it's the only check.

**Bounds are proven per layer, not per request** (#45's "rejected twice over"): if zod works, a negative price never reaches the CHECK, so one request cannot exercise both. zod is proven in `packages/shared/test/unit.test.ts`, the CHECKs in `packages/db/test/unit-bounds.test.ts` (raw inserts as the owner role, asserting `23514`). A CHECK firing in production means the boundary is broken → 500, unmapped, deliberately.

### 4.7 `GET /public/properties/:slug` → 200 - **Built** (#46, no auth)
Shared types: `packages/shared/src/public-property.ts` (`publicPropertyResponseSchema`).

`PublicPropertyResponse = { slug, name, address, description, verified, photos: [{ url }], units: [{ id, name, basePriceIdr, maxGuests, minStay }] }`. `404` for an unknown slug **or an archived property** - the two are indistinguishable, by design (§4.8). Archived *units* are filtered out of the `units` array; a live property with a mix shows only its active units.

**A malformed slug is a `404`, not the `400` §1 mandates for a malformed UUID.** A string that can't match `SLUG_PATTERN` can't exist in the column (`property_slug_format` guarantees it), so "no such page" is the true answer, not a euphemism - and it's what a guest with a mistyped link needs to read. §1's actual principle, refuse before touching the database, is upheld: `SlugParamPipe` rejects at the boundary. This is not optional politeness - taking the slug raw made `%00` a NUL byte, an unmapped `22021`, and a **500 on the one route with no auth in front of it** (found in review of #46).

**The payload is a deliberate subset, not `PropertyResponse` minus a field.** Absent: `licenseNo` (only the `verified` boolean - the repository returns a row that has never had the column, so the service cannot leak what it never received), `tenantId`, `property.id` (no consumer - M2 books a *unit*), `publishable` (an owner's checklist, not a fact about the villa), `createdAt`. The response is parsed against the shared schema on the way out, so zod strips anything a future refactor spreads in - "no PII" is enforced, not promised. `unit.id` IS included: M2's `?unit` param and #23 address a unit by it.

**`publishable` does NOT gate this endpoint** ([ADR-0004](adr/0004-a-public-url-is-an-address-not-a-view-of-state.md)). A property with no photos renders without a gallery. It reads like a gate, but every spec that uses it (page-spec §4.4, §4.5) uses it as an owner-facing readiness checklist - and a gate would mean deleting a photo silently 404s a link already pasted into an OTA profile.

**No auth, but a tenant.** The slug resolves to one via `PublicScope` and everything renders under RLS as that tenant ([ADR-0003](adr/0003-a-visitor-is-a-principal.md), #77).

**Known and accepted: public photo URLs embed the tenant and property UUIDs.** The URL is `STORAGE_PUBLIC_BASE_URL/<key>` and keys are `<tenantId>/<propertyId>/<uuid>.<ext>` (§4.5), so omitting the `key` field changes nothing - the URL *is* the key. Those ids are identifiers, not capabilities: RLS scopes on a GUC set from a verified JWT or a slug resolution, never from a value a visitor supplies, so knowing one grants nothing. The alternatives are worse - re-keying means migrating storage and losing the prefix check that makes `PATCH /photos` ownership-safe, and proxying bytes discards #39's "the API never proxies bytes" and R2's zero-egress. Read "no tenant internals" as the payload's *fields*, which is what it constrains.

**Schema:** `property.slug` is globally unique (the URL carries no tenant, so the slug is what finds one), minted once at create from the name, and **never moved by a rename** (ADR-0004). Collisions are resolved by the mint loop, never surfaced: `INSERT ... ON CONFLICT (slug) DO NOTHING`, retried with a random suffix. `property_slug_key` is deliberately absent from the constraint map - with `ON CONFLICT` it cannot raise, so if it ever does, a path skipped the mint: a 500, not a 409.

### 4.8 Archive - M2 ([ADR-0005](adr/0005-archived-is-derived-not-cascaded.md), [ADR-0006](adr/0006-an-archived-property-is-retired-not-addressed.md), #84)

The verb for **retiring inventory that has history** - the exit ADR-0002's delete guard pointed to but didn't yet have. An archived Unit/Property keeps its bookings and payments, disappears from guests, and stays visible to the owner as history.

`POST /units/:id/archive` → 200 · `POST /units/:id/unarchive` → 200 · `POST /properties/:id/archive` → 200 · `POST /properties/:id/unarchive` → 200. Each returns the updated resource. **Idempotent:** re-archiving keeps the original `archivedAt`; unarchiving something active is a no-op, not a 409. `404` for another tenant's id (indistinguishable from unknown). Verb-subresources, not a `PATCH`-a-field: archive is a transition like `POST /bookings/:id/cancel` (§5.6), and `archivedAt` appears in no request schema - like `slug`, it is set by a transition, not edited.

**Representation & derivation.** `archived_at timestamptz` (nullable) on `unit` and `property`. Effective-archived is **derived, never cascaded**: `unit.archived_at IS NOT NULL OR property.archived_at IS NOT NULL`. Archiving a Property touches only the property row; its Units are hidden by the `OR`, and unarchiving the Property restores exactly the Units that weren't archived on their own account - no cascade write, no restore-marker (ADR-0005).

**What archive hides, and where it's enforced.** The correctness boundary is the **booking chokepoint**, not a global filter (invariant #5). An effectively-archived Unit is refused there, and the code differs by verb: the **quote read** (§5.1) returns **`404`** - indistinguishable from an unknown Unit, matching the public page that hides it; the **booking write** (§5.3) resolves the Unit and then answers **`409`** - "these dates can't be booked", the taken-Unit shape. Both enforce it *after* the pure resolver, never in it ([ADR-0008](adr/0008-a-public-resolver-resolves-it-does-not-judge.md)). Everything else filters for UX - a miss there is cosmetic, not a double-booking: the public page (§4.7) drops archived Units and `404`s an archived Property (ADR-0006), and `publishable` (§4.3) stops counting archived Units.

**What archive keeps.** Existing bookings are untouched - a confirmed future stay still shows up, stays on the reservation list (§5.5), and (M4) **still exports to iCal so an OTA cannot resell those nights** (export is archive-blind for a Unit with bookings). Archive changes sellability, not the ledger; cancel (§5.6) is the separate verb for removing a guest. `channel_connection` rows survive archive untouched; the import-vs-export policy for an archived Unit is an M4 decision.

**Not RLS.** Archive is intra-tenant visibility - the owner must still see their archived inventory, so the predicate is application-level, not a policy (which would hide it from the owner too). A tenant-isolation test covers archive/unarchive; no policy changes.

> **Landed / deferred:** the **quote read** `404` for an archived Unit shipped with #47 (§5.1), and the `POST /public/bookings` → `409` (`unavailable`) refusal shipped with #48 (§5.3). The iCal export-archive-blind behavior still lands with M4 (channel-sync doesn't exist yet) - recorded here so the later build honours it.

---

## 5. Availability, calendar & bookings - M2 (boss fights #1, #2)

### 5.1 `GET /public/units/:id/availability?from&to` → 200 (no auth) - **M2** (#47, boss fight #2)
The quote endpoint the date-picker calls (FR-CAL-1/2). Shared types: `packages/shared/src/availability.ts` (`availabilityQuerySchema`, `availabilityResponseSchema`).
Rules: `from < to`, both `YYYY-MM-DD`, window ≤ 366 nights, else 400. Malformed unit UUID → 400; unknown or **effectively-archived** unit → 404 (see below). No past-date check - the quote is a pure, stateless function of `(unit, from, to)`; the picker disables past dates in the UI.
Response:
```json
{
  "available": true,
  "nights": 4,
  "totalPriceIdr": 14000000,
  "minStay": 2,
  "reasons": [],
  "blockedRanges": []
}
```
- **`blockedRanges`** = every *occupying* booking (`pending_payment`|`confirmed`) intersecting `[from,to)`, clipped to the window, **half-open**, contiguous/overlapping ranges **coalesced into maximal intervals**, and carrying `{from,to}` only - no `source`/`guest`/`bookingId`/`status` ever. It is **unconditional**: always the occupied nights in the window. So the picker uses this one endpoint in two modes - query the visible month to grey out booked nights (ignore `available`/price), then query the concrete selection to quote. Coalescing also means a Visitor never sees the *seam* between two adjacent bookings (a checkout-day = next check-in), only "these nights are unavailable".
- **`available`** = `blockedRanges` empty **and** `nights ≥ minStay`. Because `blockedRanges` is unconditional, a non-empty one *is* the overlap signal - there is no separate availability query. (So for one window, `available:true` ⟺ `blockedRanges` empty.)
- **`reasons`** = machine-readable slugs, subset of `overlap` (blockedRanges non-empty) and `min_stay` (`nights < minStay`); both may be present. **Slugs only, no prose** - the response is language-neutral (§1); the SPA composes localized copy from the slug + `minStay`/`blockedRanges` using its own i18n. `?lang` is accepted (public-endpoint convention) but unused here.
- **`totalPriceIdr`** = `basePriceIdr × nights`, always computed (v1 pricing; no seasonal rates - PRD non-goal). A zero-priced (placeholder) unit quotes honestly at `0`; whether it can actually be *booked* is the write chokepoint's call (§5.3), not the read's.

**Tenant scope & archive.** No auth, but a tenant: `PublicScope.enterFromUnitId(id)` resolves the tenant from the unit id (one column, owner connection) exactly as `enterFromSlug` does for a slug ([ADR-0003](adr/0003-a-visitor-is-a-principal.md), [ADR-0008](adr/0008-a-public-resolver-resolves-it-does-not-judge.md)). The resolver stays pure - it 404s only a *nonexistent* unit; the **effectively-archived** check (`unit.archived_at IS NOT NULL OR property.archived_at IS NOT NULL` → 404, §4.8) is enforced in `AvailabilityService` at the chokepoint, from the same unit-fetch that reads `basePriceIdr`/`minStay`.

**The interval math is the DB's.** Overlap and clipping run in Postgres with the *same* `daterange(check_in, check_out, '[)') && / *` operators as the `booking_no_overlap` exclusion constraint (db-design §4.2/4.3), so the read can never say "free" for a stay the write would reject; `nights`/price/min-stay/coalesce are pure functions in `@sambung/shared`. `AvailabilityService.quote()` is the single interval authority - §5.3's in-transaction re-check calls the same service and joins its transaction (#72), so the read and the write share one definition of "overlap".

### 5.2 `GET /units/:id/calendar?from&to` → 200 (auth) - owner calendar (FR-CAL-3)
Same shape but full-fat: each range carries `bookingId, source, status, guestName?`, so the dashboard can color-code direct/airbnb/manual and show holds.

### 5.3 `POST /public/bookings` → 201 (no auth) - the guest funnel (FR-BOOK-1) - **Built** (#48, boss fight #1)
Body: `{ unitId, checkIn, checkOut, guestName, guestPhone, guestEmail?, guestCount }` (validated in `@sambung/shared`; `unitId` is in the body, and `PublicScope.enterFromUnitId` resolves the tenant from it). **No price field** - the server recomputes `totalPriceIdr`, the client quote is advisory. `guestPhone` is required and plausibility-checked because WhatsApp is M3's confirmation channel; the old free-text `guestContact` was split into `guest_phone`/`guest_email` and `guest_count` added (migration 0007, ADR-0009 PR).
Behavior - **the race-condition path** (architecture flow A), all in ONE transaction:
1. Opportunistic **intra-tenant sweep** of this unit's lapsed holds (ADR-0009), so a dead-but-unswept hold never blocks a live guest, then
2. Re-validate availability + min-stay by calling `AvailabilityService.quote()` (the one interval authority, joined into this txn), plus the write-only `guest_count ≤ max_guests` check → friendly `409 { reasons }` (UX layer). An archived Unit is resolved-then-refused here as `unavailable` (ADR-0008).
3. INSERT booking `status=pending_payment`, `holdExpiresAt = now() + 15 min` on the **DB clock** (pessimistic hold, db-design §4.4), server-computed `totalPriceIdr`.
4. A racing overlap loses at the **exclusion constraint** → mapped (via the constraint map) to the *same* 409 shape. The client cannot tell (and must not care) which layer refused.
Refusal `reasons` (machine-readable, AC #4): `overlap | min_stay | max_guests | unavailable` - `unavailable` is an archived Unit, named for its guest-facing effect (the wire never carries "archived"). 409 body: `{ statusCode, error, code: "dates_unavailable", message, reasons }` (the shared 409 shape, §8.2 / ADR-0012); the checkout UI re-quotes on `overlap`, sends the guest back to search on `unavailable`.
Response (201): `{ bookingId, status: "pending_payment", holdExpiresAt, totalPriceIdr, nights }`.
Unpaid holds are flipped to `expired` by the 5-min **cross-tenant** sweeper cron - the backstop of ADR-0009's two-scope sweep; no endpoint does this.

### 5.4 `POST /bookings` → 201 (auth) - manual block / walk-in
The owner-side write - a booking the Owner creates directly, born `confirmed`, no payment dance ([ADR-0011](adr/0011-the-owner-is-an-authority-not-a-customer.md)). Body is a **discriminated union on `source`** (`@sambung/shared`):
- `source: "manual_block"` (a **Block**) → `{ unitId, checkIn, checkOut }`. No guest, no price - a Block occupies but sells nothing (`guest_*` and `total_price_idr` stored NULL).
- `source: "direct"` (a **walk-in**) → `{ unitId, checkIn, checkOut, guestName, guestPhone?, guestEmail?, guestCount?, totalPriceIdr? }`. `guestName` is **required** (AC #2). Contact is optional (the booking is already confirmed - no WhatsApp step). `totalPriceIdr` optional: omitted → the server computes `basePriceIdr × nights` (the same figure `quote()` gives); provided → the Owner's offline / negotiated rate, validated by `rupiahSchema` (≥ 0, ≤ the nightly-rate cap).

**Authority, not funnel.** The write reuses the guest funnel's *one* overlap chokepoint - the opportunistic in-txn hold-sweep + `quote()`'s re-check + the `booking_no_overlap` constraint → the **same** `409 {reasons:['overlap']}` (AC #4) - but it authenticates (`JwtAuthGuard` → owner RLS connection; **no** `enterFromUnitId`, so a cross-tenant / unknown unit is invisible → **404**) and enforces **only** the physical invariant. The guest-protection policy checks are **skipped**: `min_stay` (the Owner may block or walk-in a single night) and `max_guests` (the Owner records the real party size). An **archived** Unit is refused `409 {reasons:['archived']}` - archive retires a Unit from every new-booking path (§4.8, ADR-0006), and the Owner can see it (history), so a 404 would lie. Staff may only touch assigned properties' units (403 otherwise, M5).

### 5.5 `GET /bookings?from&to&propertyId&unitId&status&source` → 200 (auth) - **Built** (#49)
Reservation list for the dashboard - THE one booking-read path, shared by the unified calendar (#49) and the reservations list (#51), and consulted by the booking detail drawer (#50); [ADR-0010](adr/0010-the-calendar-is-composed-not-served.md). All filters optional, AND-ed. The window (`from`,`to`) is a validated **pair** (both or neither - a lone `from` is a 400) with **overlap** semantics (a stay intersecting `[from,to)` matches, straddling edges included; a touching changeover does not) and the §5.1 366-night cap. `status` and `source` are **repeatable** set-filters (`?status=pending_payment&status=confirmed`) - the calendar names the two occupying statuses (`OCCUPYING_STATUSES`) this way, which a single-valued param could not express; no `status` = every status (a management list surfaces cancelled/expired too). Returns **whole rows** - real `checkIn`/`checkOut`, not window-clipped - because this is owner-facing (the opposite disclosure rule from §5.1's public read, which clips for privacy); the calendar clips the bar visually. Sorted by `checkIn`. Shared types: `packages/shared/src/booking-list.ts` (`listBookingsQuerySchema`, `bookingRowSchema`, `OCCUPYING_STATUSES`). **CSV twin** at `GET /bookings/export.csv` (**Built**, #59) - the SAME `listBookingsQuerySchema` filters (one shared condition-builder, so "respects the active filters" holds by construction), `text/csv` attachment with a UTF-8 BOM, property/unit NAMES joined in, and integer IDR emitted as exact `bigint` digits (never a float - no separators, no scientific notation). Guest names (attacker-controlled, from the funnel) are RFC-4180-escaped AND formula-injection-neutralised.

### 5.6 `POST /bookings/:id/cancel` → 200 (auth)
FSM-guarded as **one atomic UPDATE**: `SET status='cancelled' WHERE id=$id AND status IN ('pending_payment','confirmed')` (the FSM lives in the `WHERE`, mirroring the archive verb-subresource). One row updated → 200; zero rows → a follow-up existence check in the same transaction picks the error: unknown / cross-tenant id → **404** (404-over-403), an already-terminal booking → **409** `code: "booking_not_cancellable"` with the terminal `status` (`cancelled` / `expired`) as data (§8.2, ADR-0012). Cancelling frees the dates instantly (the row drops out of the exclusion constraint's WHERE). It is the universal *free-these-dates* verb - it lifts a Block and a walk-in exactly as it cancels a guest booking. Response: `{ status: "cancelled", refund }` where `refund` = `"manual"` if a `paid` payment exists (owner refunds out-of-band; v1 has no refund API), else `"none"`. At M2 there are no payments, so `refund` is always `"none"`; the field is wired now so M3 doesn't retrofit it.

### 5.7 `GET /bookings/:id` → 200 (auth) - booking detail (#50)
The deep-linkable read behind `/app/bookings/:id` (page-spec §4.3) and the calendar's detail drawer. `GET /bookings` (§5.5) is a *list* with no identity filter, and a detail page must survive a cold cache (a bookmarked or forwarded link), so the honest shape is a single-resource GET, not an id smuggled into the list filters. Tenant-scoped by RLS: an unknown or cross-tenant id → **404** (404-over-403). Returns the full owner-facing row - `bookingRowSchema` plus `guestPhone`, `guestEmail`, and display names (`propertyName`, `unitName`) - richer than the list row because this is the one place the Owner inspects a single reservation in full (owner disclosure, the opposite of §5.1's public clip; ADR-0010). Payment fields join at M3.

---

## 6. Payments - M3 (boss fight #4)

### 6.1 `POST /public/bookings/:id/pay` → 201 (no auth)
Creates the provider session for a `pending_payment` booking whose hold hasn't lapsed.
Response: `{ provider: "midtrans", token, redirectUrl, amountIdr, deposit: false }`. Amount = deposit % (per-property setting, default 100%) of `totalPriceIdr`.
Errors: 404 unknown id; 409 wrong status (`confirmed`, `expired`, `cancelled`) or hold expired. Calling twice re-uses the open payment session (idempotent-ish: one `payment` row per booking attempt cycle).

### 6.2 `POST /webhooks/payment/:provider` → 200 - **the idempotency path**
Provider delivers **at-least-once**; this endpoint must be duplicate-proof and race-proof:
1. Verify the provider signature (Midtrans `signature_key`) → 401 on mismatch; unknown `:provider` → 404. Verified raw payload stored on the `payment_event` row (ADR-0018) - **not** on `payment.raw_payload`, which holds the open Snap session a pay-retry reads back (ADR-0015), so a `failure` event can't destroy a session the guest still needs.
2. **In one transaction:** INSERT `payment_event (provider, providerEventId)` - a unique-violation means "already processed" → commit nothing, return 200. Otherwise apply the transition: settlement → `payment.status=paid`, `booking.status=confirmed`; failure/expiry → `payment.status=failed` (booking stays `pending_payment` until the hold sweeper expires it).
   *The event insert and the state change share the transaction* - a crash between them must replay, not drop, the event.
3. Post-commit side effects: confirmation email to guest + owner (FR-NOTIF-1). Side-effect failure never fails the webhook (log + retry queue-less v1: resend from the confirmation page).
Always 200 for well-formed, verified duplicates - providers retry non-2xx forever.

### 6.3 `GET /public/bookings/:id` → 200 (no auth) - confirmation page
`{ status, checkIn, checkOut, propertyName, unitName, totalPriceIdr, amountPaidIdr, waLink }` - `waLink` is the prefilled `wa.me` deeplink (FR-NOTIF-2). **Reconciles on read** (risk R3): if status is `pending_payment`, the handler queries the provider's status API before answering, so a lost webhook still confirms here. Unguessable UUID is the v1 access control; no PII beyond what the guest themselves entered.

### 6.4 Paid-but-lapsed inbox (auth) - **Built** (#120, [ADR-0022](adr/0022-the-paid-but-lapsed-inbox-marks-not-mutates.md))
The owner-facing surface for the **late-settlement** case §6.2 handles safely but silently (ADR-0018): a guest settles AFTER their hold lapsed (swept to `expired`) or the booking was cancelled, so `payment.status = paid` while `booking.status IN (expired, cancelled)` and the booking is never resurrected. A `WARN` is not a workflow, so:
- `GET /payments/lapsed` → 200: `LapsedPayment[]` - each `{ paymentId, bookingId, bookingStatus, provider, amountIdr, guestName, guestPhone, guestEmail, checkIn, checkOut, propertyName, unitName, createdAt }`, i.e. enough to act (amount, guest + contact, dates, why). Owner RLS connection; scoped by `booking.tenant_id` beside RLS (`payment` has no `tenant_id` of its own - its policy scopes through the booking join). Only `paid` payments on a lapsed booking that are **not yet handled**.
- `POST /payments/:id/handle` → 200: `{ paymentId, handledAt }`. Sets a nullable `payment.handled_at` marker (migration 0011) and **nothing else** - `payment.status` stays `paid`, the booking stays expired/cancelled (the ledger is never mutated to clear an inbox item, ADR-0002). The item drops from `GET /payments/lapsed` by the list's predicate, not by any ledger change. Idempotent (already-handled → 200 no-op); unknown / cross-tenant / non-inbox id → 404 (404-over-403). Refund stays **manual** at sandbox (ADR-0011) - handling records "I dealt with it", it does not move money.

---

## 7. Channel sync - M4 (boss fight #3, #38)

### 7.1 `POST /units/:id/channels` → 201 (auth) - **Built** (#55, ADR-0016)
Body: `{ channel: "airbnb" | "booking_com" | "vrbo", importIcalUrl }` (https URL, validated at the boundary by `createChannelConnectionRequestSchema` + fetched once immediately as a smoke test → `lastStatus`; a feed that's down still connects, with `error` status, so the failure surfaces instead of hiding). One connection per (unit, channel) → `409 channel_already_connected` (ADR-0012 code; the app pre-check and the `channel_connection_unit_channel_uniq` constraint are indistinguishable, §5.3). Unknown/foreign unit → 404. The outbound fetch is a `IcalFetcher` port (fake bound in tests, §8.5), and refuses private/loopback hosts (SSRF hygiene).

### 7.2 `GET /units/:id/channels` → 200 (auth) - **Built** (#55)
Connections with `lastSyncedAt, lastStatus: never|ok|error, lastError?` (FR-SYNC-3 - failures surface, never silent) and **`openConflicts`** - **Built** (#38): how many imported VEVENTs this connection currently cannot land because they overlap an existing booking (§7.5). Its own count rather than an `error` status, because the feed is *healthy*: it downloaded, parsed, and mostly imported - only what clashed is stuck, and that needs a human, not a retry. One grouped count for the whole unit, never a query per row.

### 7.3 `POST /channels/:id/sync` → 200 (auth) - **Built** (#56, ADR-0025)
"Sync now": force this connection's import off the 30-min cron, **immediately**. Runs **synchronously** and returns the connection's post-sync health + a summary - `SyncConnectionResponse = { lastStatus: never|ok|error, lastSyncedAt, lastError, imported, cancelled, conflicts }` (`conflicts` = VEVENTs refused as double-sells and filed in the inbox, #38) - not `202 { queued: true }`: there is no job queue on a single VPS (Redis/BullMQ = a heavy dep), so the honest contract is the result, not a promise ([ADR-0025](adr/0025-a-healthy-feed-reconciles-a-doubtful-one-does-nothing.md)). Unknown/foreign id → 404 (resolved under the owner's RLS scope first, existence hidden). Same reconcile core as the cron (architecture flow B): fetch **outside** the txn → parse → one txn with a **savepoint per VEVENT** (an overlap `23P01` skips that event, never crashes the cycle - the #38 seam) → upsert by `externalUid` → absent-UID cancellation **only on a healthy feed with ≥ 1 event** (`imported`/`cancelled` count what this pull did; both 0 on an unhealthy feed).

**"Healthy" is a whole, terminated calendar.** A non-2xx / unreachable / timeout pull, or a body that is not a terminated `BEGIN:VCALENDAR … END:VCALENDAR` (truncation loses the `END`), is **unhealthy** → `lastStatus: 'error'`, zero writes. A healthy-but-empty calendar stamps `ok` but cancels nothing (empty is indistinguishable from truncated-to-zero - never mass-cancel real bookings).

### 7.4 `DELETE /channels/:id` → 200 (auth) - **Built** (#55)
Disconnects. Already-imported bookings are **kept** (they may reflect real stays) but stop being reconciled - the `booking.channel_connection_id` FK is `set null`, so they survive with their source/status intact; the response body `{ importedBookingsKept }` counts them (measured before the delete) so the owner can clean up deliberately. Safer than auto-cancelling reality. Returns 200 (not 204) because it carries that body. Unknown/foreign id → 404.

### 7.5 Conflict inbox (auth) - **Built** (#38, [ADR-0027](adr/0027-dismiss-is-a-judgement-resolve-is-a-measurement.md), db-design §4.8)
An imported VEVENT the `booking_no_overlap` exclusion constraint refused - a real-world double-sell. ADR-0025's per-VEVENT savepoint makes it survivable; this makes it *visible*. A conflict is an ops item, never an availability source (invariant #3 untouched) and blocks nothing.

- `GET /sync-conflicts?status=open|resolved|dismissed&propertyId?` → 200: `SyncConflict[]`, each `{ id, propertyId, propertyName, unitId, unitName, channel, externalUid, stay: {from,to}, status, firstDetectedAt, lastSeenAt, closedAt, blockingBookings[] }`. `status` **defaults to `open`** - it is an inbox, so a bare GET is what still needs the owner. `blockingBookings` (`{ id, source, status, checkIn, checkOut, guestName }`) is **derived at read time** by overlapping the conflict's stay against the unit's occupying bookings - the same `daterange &&` over the same `OCCUPYING_STATUSES` the exclusion constraint uses, so it is exactly the set that caused the refusal, and §5.6 is one click away. Never stored: which booking blocks changes as the owner works. Newest-seen first. No raw VEVENT is kept or returned - ADR-0025's parser drops a feed's SUMMARY/DESCRIPTION so imported guest PII never enters, and this shape must not be the door that re-admits it.
- `POST /sync-conflicts/:id/dismiss` → 200: `{ id, status, closedAt }`. Writes only `status` + `closed_at`, never a booking or a payment (ADR-0022's rule). Idempotent - dismissing an already-closed conflict echoes its real state rather than refusing, so no ADR-0012 conflict code is needed. Unknown / cross-tenant id → 404 (404-over-403).
- There is **no "resolve" endpoint**: resolution = cancel the blocking booking via §5.6, and the next sync *measures* that the clash is gone and closes the conflict itself. A "mark resolved" button would let the client assert something the constraint still refuses. The API never auto-cancels a confirmed booking (ADR 2026-07-16).
- **Re-detection is asymmetric** (ADR-0027): a still-clashing UID keeps one row (`last_seen_at` + the stay refresh, never `first_detected_at`); a **dismissed** conflict stays dismissed (a judgement no cron may undo, or it resurrects every 30 minutes); a **resolved** one reopens (a measurement, and the clash is back). Auto-closing runs only on a healthy feed with ≥ 1 event - the same guard as the absent-UID cancellation, for the same never-guess-from-a-doubtful-feed reason.

### 7.6 `GET /public/units/:id/calendar.ics` → 200 - export feed (FR-SYNC-2) - **Built** (#55, ADR-0016)
`Content-Type: text/calendar`. One all-day `VEVENT` per **confirmed occupying booking** (direct + imported + manual; `status = 'confirmed'`, so a transient hold is excluded): `UID` = booking id, `DTSTART`/`DTEND` = half-open dates (DTEND exclusive - matches iCal semantics natively), `SUMMARY` = `"Unavailable (Sambung)"` - **no guest names, no prices** (this URL is pasted into OTAs; the serializer's input type has no PII field, so this is a type guarantee, not a convention). No auth: the tenant is resolved from the unit id via `PublicScope.enterFromUnitId` and the read runs under RLS (invariant #2 held structurally). Deliberately **archive-blind** - an archived Unit with bookings keeps serving its calendar, or the subscribed OTA would see free nights and double-book (ADR-0016). Unknown unit → 404. Unguessable unit UUID is the v1 access control; a per-unit feed token is the noted hardening step if the repo goes public-demo.

---

## 8. Cross-cutting behaviors (spec'd once, enforced everywhere)

1. **404-over-403 for cross-tenant probes** - verified by test per resource (the pattern exists for properties; every new resource copies it).
2. **Every write is FSM- and constraint-checked, and every 409 carries a machine-readable `code` slug** - invalid transitions, overlaps, taken emails, duplicate names, and inventory-with-history all refuse with a `409` whose body is `{ statusCode, error, code, message, ...detail }`. The client switches on `code` (a closed enum in `packages/shared`, imported by both sides so a rename is a compile error); `message` is a human default for logs and is **never** rendered to a user (the web owns all copy). Typed `detail` rides alongside per code: a delete guard's `count`, a booking refusal's `reasons`, a cancel FSM's terminal `status`. One convention regardless of which layer refused - an app-level pre-check, an FSM-guarded UPDATE, or a DB constraint mapped by the interceptor (§8 constraint map) - so the client cannot tell (and must not care) which one did ([ADR-0012](adr/0012-a-409-carries-a-code-not-a-sentence.md), #82).
3. **Public endpoints are rate-limited** (`/auth/*`, `/public/bookings*`) - **Built** (#59, [ADR-0014](adr/0014-rate-limits-are-tiered-and-429-follows-the-envelope.md)). Two tiers: a generous `default` throttler on every route (#48) and a TIGHTER `sensitive` throttler on the abuse-prone few - `login`, `register`, `POST /public/bookings` - opted in with `@ThrottleSensitive()` and skipped everywhere else. Both env-driven (protective defaults: 60/60s and 10/60s), in-memory (single VPS, no Redis), per client IP once `TRUST_PROXY` is set behind Caddy. The 429 follows the error envelope `{ statusCode, error, message }` (NOT a conflict `code` - rate limiting is infra back-pressure, not a domain 409) and carries a standard `Retry-After`. No CAPTCHA in v1.
4. **BigInt discipline:** DB `bigint` ⇄ JSON number happens in one serialization helper - `toRupiah()` in `packages/shared/src/money.ts` (#45); no `JSON.stringify` of raw rows with BigInt fields. The `Rupiah` brand is what enforces it: a bare `number` doesn't typecheck as a money field, so a response path can't skip the helper. It throws above `MAX_SAFE_INTEGER` rather than rounding - a stored value that big never came through `rupiahSchema`, so it's corruption, not a price.
5. **Testing seam** (matches existing prior art - `auth.spec.ts`, `properties.spec.ts`): behaviors in this spec are tested with supertest over real HTTP against the booted app + real Postgres; DB-owned invariants at the `packages/db` vitest seam; the only fakes sit at the outbound provider edge (Midtrans client, iCal fetch) so webhook/feed fixtures can drive flows end-to-end.
6. **A shared enum that mirrors a `pgEnum` is pinned to it by a test.** The web app must never import `packages/db` (invariant #1), so a wire-level enum (`booking_source`, `booking_status`, `payment_status`, `sync_status`, `user_role`) is necessarily hand-copied into `packages/shared` - two sources of truth for one list. `apps/api` is the only workspace that legitimately imports **both**, so the equality test lives there: `expect([...someSchema.options].sort()).toEqual([...somePgEnum.enumValues].sort())`. Add it in the same PR as the enum, never after.

   *Why this rule exists:* `bookingSourceSchema` shipped in M0 saying `"booking"`/`"manual"` where the pgEnum says `booking_com`/`vrbo`/`manual_block`, and `vrbo` was missing outright. Nothing imported it, so nothing failed - it sat waiting for M2 to import a type that **typechecks and then fails at the INSERT**, while `BookingSource` existed in `@sambung/db` *and* `@sambung/shared` with different values under the same name. It was deleted rather than fixed (#45 review): a wrong contract is worse than no contract, and the fix without this test just resets the clock.

## 9. Out of scope (v1, per PRD §2.2)

Real OTA push APIs · dynamic/seasonal pricing · multi-currency & real payouts · refunds via API · guest accounts/login · reviews · pagination · API versioning (single consumer) · access-token revocation lists.

---

*Change discipline: when an endpoint lands, its zod schema in `packages/shared` becomes the type truth and this doc's row flips to Built. If implementation diverges from a behavior written here, update this doc in the same PR - one source of truth per fact.*
