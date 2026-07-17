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
| 19 | `GET /bookings/export.csv?…` | CSV export (same filters) | M5 | - |
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
| 31 | `POST /channels/:id/sync` | Force "Sync now" | M4 | SYNC-1 |
| 32 | `GET /sync-conflicts?status=open` | Conflict inbox (#38) | M4 | SYNC-3 |
| 33 | `POST /sync-conflicts/:id/dismiss` | Dismiss a conflict | M4 | SYNC-3 |
| 34 | `GET /public/units/:id/calendar.ics` | iCal export feed | M4 | SYNC-2 |

Notifications (FR-NOTIF-1/2) have **no endpoints**: email fires on the `confirmed` transition (webhook handler); the WhatsApp `wa.me` deeplink is a field on #25's response.

---

## 3. Auth - **Built** (M0)

Shared types: `packages/shared/src/auth.ts` (`registerRequestSchema`, `loginRequestSchema`, `authResponseSchema`, `meResponseSchema`).

### 3.1 `POST /auth/register` → 201
Creates a **tenant + its owner user atomically**, starts a session.
Body: `{ tenantName (2-120), email (≤254), password (8-200) }`.
Response: `AuthResponse = { accessToken, user: { id, email, role, tenantId }, tenant: { id, name } }` + refresh cookie. Password hash never appears in any response.
Errors: `400` zod; `409` email already registered - including the **concurrent-signup race**: two simultaneous registers with one email → exactly one 201, one 409 (the citext UNIQUE is the guard; the pre-check is UX). Test-proven.

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
Fields: `name` (required, 2-160), `address?`, `latitude?`/`longitude?` (valid ranges), `description?`, `licenseNo?` (NIB). Response includes derived `verified: boolean` - true iff `licenseNo` is non-empty (FR-PROP-3). A public page needs ≥1 photo + ≥1 unit with a price **above zero** to render "complete" (FR-PROP-1 AC) - the API exposes `publishable: boolean` computed from that rule. A zero-rupiah unit is storable (§4.6) but never counts toward publishability: it's a placeholder, not a sellable listing.

### 4.4 `DELETE /properties/:id` → 204 - **Built** (M1)
**Guarded:** if **any** booking has ever referenced a unit under it - past, cancelled and expired included - → `409` naming the count. Same rule for `DELETE /units/:id`. Delete is only for inventory that was never booked; retiring inventory that has history is **archive** (M2, #84).

Two layers, per invariant #5: the service guard produces the count and the message, and both `booking → unit` FKs are `on delete no action` so the database refuses too ([ADR-0002](adr/0002-deleting-inventory-never-destroys-the-ledger.md)). The FK is deliberately **not** mapped in the constraint map - the guard locks the unit before counting, so nothing can slip in behind it, and a FK that fires anyway means a code path skipped the guard: a 500, not a 409.

> **Superseded:** this used to read "*future occupying* booking → 409 … (cancel bookings first)". That guard protected the calendar, not the ledger - it never saw past or cancelled bookings, so `DELETE` returned 204 and cascaded them, and their `payment` rows, into nothing. "Cancel them first" is also gone: cancelling doesn't remove the row, so it promised an escape that doesn't exist.

### 4.5 Photos - **Built** (#39, architecture §3.6)
Shared types: `packages/shared/src/photo.ts` (`presignPhotoRequestSchema`, `presignPhotoResponseSchema`, `updatePhotosRequestSchema`).
- `POST /properties/:id/photos/presign` body `{ contentType, size }` → 201 `{ uploadUrl, key, expiresInSeconds }`. Validates: content type in `image/jpeg|png|webp`, `size ≤ 5 MB`, property ownership. Key is tenant-prefixed (`<tenantId>/<propertyId>/<uuid>.<ext>`). Browser PUTs bytes directly to storage (Garage dev / R2 prod) - the API never proxies bytes. Content type **and** length are signed headers: an upload that doesn't repeat them exactly fails at the storage layer (403), test-proven against Garage.
- `PATCH /properties/:id/photos` body `{ keys: string[] }` (ordered, ≤ 30, all must carry the caller's `<tenantId>/<propertyId>/` prefix - a key for another tenant OR another own property → 400) → 200 full `PropertyResponse`. Persist + reorder + delete in one idempotent set-operation. Keys **new to the gallery** must reference a real uploaded image - one ranged GET verifies existence + magic bytes against the stored content type (presigned-but-never-uploaded or junk-bytes-as-jpeg → 400); already-persisted keys are trusted, so reorders cost nothing. Orphaned objects are GC'd out-of-band (deferred).
- `PropertyResponse` carries `photos: [{ key, url }]` (order = gallery order, url = `STORAGE_PUBLIC_BASE_URL/<key>`); `publishable` counts these photos.

### 4.6 Units - **Built** (#45)
`POST /properties/:id/units` → 201, `GET /properties/:id/units` → 200 (`createdAt` asc), `PATCH /units/:id` → 200, `DELETE /units/:id` → 204 (guarded, §4.4).
Shared types: `packages/shared/src/unit.ts` (`createUnitRequestSchema`, `updateUnitRequestSchema`, `unitResponseSchema`, `isSellable`).

Fields: `name`, `basePriceIdr` (int ≥ 0; a 0 price is storable but keeps the property unpublishable - §4.3), `maxGuests` (int ≥ 1, default 2), `minStay` (nights, int ≥ 1, default 1). The DB CHECKs mirror these bounds - a bypassed app check still cannot store garbage. Every field is mutable: a booking snapshots its own `totalPriceIdr`, and `minStay` applies when booking, so neither is retroactive. `404` for another tenant's property or unit id (indistinguishable from unknown).

**A Unit is one sellable thing, not a room type with a quantity** ([ADR-0001](adr/0001-unit-is-one-sellable-thing.md)): three identical garden rooms are three units. `name` is therefore `unique(property_id, name)` → `409` on a duplicate within one property (two *different* properties may each have a "Garden Room"). This is the one unit constraint that IS mapped in the constraint map - zod cannot check it, since the answer depends on the other rows, so the DB isn't a backstop here, it's the only check.

**Bounds are proven per layer, not per request** (#45's "rejected twice over"): if zod works, a negative price never reaches the CHECK, so one request cannot exercise both. zod is proven in `packages/shared/test/unit.test.ts`, the CHECKs in `packages/db/test/unit-bounds.test.ts` (raw inserts as the owner role, asserting `23514`). A CHECK firing in production means the boundary is broken → 500, unmapped, deliberately.

### 4.7 `GET /public/properties/:slug` → 200 - **Built** (#46, no auth)
Shared types: `packages/shared/src/public-property.ts` (`publicPropertyResponseSchema`).

`PublicPropertyResponse = { slug, name, address, description, verified, photos: [{ url }], units: [{ id, name, basePriceIdr, maxGuests, minStay }] }`. `404` unknown slug - the only failure.

**A malformed slug is a `404`, not the `400` §1 mandates for a malformed UUID.** A string that can't match `SLUG_PATTERN` can't exist in the column (`property_slug_format` guarantees it), so "no such page" is the true answer, not a euphemism - and it's what a guest with a mistyped link needs to read. §1's actual principle, refuse before touching the database, is upheld: `SlugParamPipe` rejects at the boundary. This is not optional politeness - taking the slug raw made `%00` a NUL byte, an unmapped `22021`, and a **500 on the one route with no auth in front of it** (found in review of #46).

**The payload is a deliberate subset, not `PropertyResponse` minus a field.** Absent: `licenseNo` (only the `verified` boolean - the repository returns a row that has never had the column, so the service cannot leak what it never received), `tenantId`, `property.id` (no consumer - M2 books a *unit*), `publishable` (an owner's checklist, not a fact about the villa), `createdAt`. The response is parsed against the shared schema on the way out, so zod strips anything a future refactor spreads in - "no PII" is enforced, not promised. `unit.id` IS included: M2's `?unit` param and #23 address a unit by it.

**`publishable` does NOT gate this endpoint** ([ADR-0004](adr/0004-a-public-url-is-an-address-not-a-view-of-state.md)). A property with no photos renders without a gallery. It reads like a gate, but every spec that uses it (page-spec §4.4, §4.5) uses it as an owner-facing readiness checklist - and a gate would mean deleting a photo silently 404s a link already pasted into an OTA profile.

**No auth, but a tenant.** The slug resolves to one via `PublicScope` and everything renders under RLS as that tenant ([ADR-0003](adr/0003-a-visitor-is-a-principal.md), #77).

**Known and accepted: public photo URLs embed the tenant and property UUIDs.** The URL is `STORAGE_PUBLIC_BASE_URL/<key>` and keys are `<tenantId>/<propertyId>/<uuid>.<ext>` (§4.5), so omitting the `key` field changes nothing - the URL *is* the key. Those ids are identifiers, not capabilities: RLS scopes on a GUC set from a verified JWT or a slug resolution, never from a value a visitor supplies, so knowing one grants nothing. The alternatives are worse - re-keying means migrating storage and losing the prefix check that makes `PATCH /photos` ownership-safe, and proxying bytes discards #39's "the API never proxies bytes" and R2's zero-egress. Read "no tenant internals" as the payload's *fields*, which is what it constrains.

**Schema:** `property.slug` is globally unique (the URL carries no tenant, so the slug is what finds one), minted once at create from the name, and **never moved by a rename** (ADR-0004). Collisions are resolved by the mint loop, never surfaced: `INSERT ... ON CONFLICT (slug) DO NOTHING`, retried with a random suffix. `property_slug_key` is deliberately absent from the constraint map - with `ON CONFLICT` it cannot raise, so if it ever does, a path skipped the mint: a 500, not a 409.

---

## 5. Availability, calendar & bookings - M2 (boss fights #1, #2)

### 5.1 `GET /public/units/:id/availability?from&to` → 200 (no auth)
The quote endpoint the date-picker calls (FR-CAL-1/2).
Rules: `from < to`, both `YYYY-MM-DD`, window ≤ 366 nights, else 400.
Response:
```json
{
  "available": true,
  "nights": 4,
  "totalPriceIdr": 14000000,
  "minStay": 2,
  "reasons": [],
  "blockedRanges": [ { "from": "2026-08-10", "to": "2026-08-14" } ]
}
```
`available=false` carries machine-readable `reasons`: `overlap` and/or `min_stay` (localized message text per `?lang`). Price = `basePriceIdr × nights` (v1 pricing; no seasonal rates - PRD non-goal). `blockedRanges` = occupying bookings clipped to the queried window, **half-open**, with no source/guest information leaked.

### 5.2 `GET /units/:id/calendar?from&to` → 200 (auth) - owner calendar (FR-CAL-3)
Same shape but full-fat: each range carries `bookingId, source, status, guestName?`, so the dashboard can color-code direct/airbnb/manual and show holds.

### 5.3 `POST /public/bookings` → 201 (no auth) - the guest funnel (FR-BOOK-1)
Body: `{ unitId, checkIn, checkOut, guestName, guestContact, lang? }`.
Behavior - **the race-condition path** (architecture flow A):
1. Re-validate availability + min-stay inside the transaction (friendly 409 with `reasons` - UX layer).
2. INSERT booking `status=pending_payment`, `holdExpiresAt = now() + 15 min` (pessimistic hold, db-design §4.4), server-computed `totalPriceIdr`.
3. A racing overlap loses at the **exclusion constraint** → mapped to the *same* 409 shape. The client cannot tell (and must not care) which layer refused.
Response: `{ bookingId, status: "pending_payment", holdExpiresAt, totalPriceIdr, nights }`.
Unpaid holds are flipped to `expired` by the 5-min sweeper cron - no endpoint does this.

### 5.4 `POST /bookings` → 201 (auth) - manual block / walk-in
Body: `{ unitId, checkIn, checkOut, source: "manual_block" | "direct", guestName?, guestContact?, totalPriceIdr? }`. Born `confirmed` (no payment dance). `guestName` required for `direct`, forbidden-optional for `manual_block`. Same 409 overlap semantics. Staff may only touch assigned properties' units (403 otherwise, M5).

### 5.5 `GET /bookings?from&to&propertyId&unitId&status&source` → 200 (auth)
Reservation list for the dashboard; all filters optional AND-ed; window filter uses **overlap** semantics (a booking intersecting `[from,to)` matches). Sorted by `checkIn`. CSV twin at `GET /bookings/export.csv` (M5) - same filters, `text/csv`.

### 5.6 `POST /bookings/:id/cancel` → 200 (auth)
FSM-guarded: `pending_payment|confirmed → cancelled`; anything else → 409 (`already cancelled`, `expired`). Cancelling frees the dates instantly (the row drops out of the exclusion constraint's WHERE). Cancelling a paid booking does **not** auto-refund in v1 (sandbox; noted in response as `refund: "manual"`).

---

## 6. Payments - M3 (boss fight #4)

### 6.1 `POST /public/bookings/:id/pay` → 201 (no auth)
Creates the provider session for a `pending_payment` booking whose hold hasn't lapsed.
Response: `{ provider: "midtrans", token, redirectUrl, amountIdr, deposit: false }`. Amount = deposit % (per-property setting, default 100%) of `totalPriceIdr`.
Errors: 404 unknown id; 409 wrong status (`confirmed`, `expired`, `cancelled`) or hold expired. Calling twice re-uses the open payment session (idempotent-ish: one `payment` row per booking attempt cycle).

### 6.2 `POST /webhooks/payment/:provider` → 200 - **the idempotency path**
Provider delivers **at-least-once**; this endpoint must be duplicate-proof and race-proof:
1. Verify the provider signature (Midtrans `signature_key`) → 401 on mismatch; unknown `:provider` → 404. Raw payload stored on the `payment` row.
2. **In one transaction:** INSERT `payment_event (provider, providerEventId)` - a unique-violation means "already processed" → commit nothing, return 200. Otherwise apply the transition: settlement → `payment.status=paid`, `booking.status=confirmed`; failure/expiry → `payment.status=failed` (booking stays `pending_payment` until the hold sweeper expires it).
   *The event insert and the state change share the transaction* - a crash between them must replay, not drop, the event.
3. Post-commit side effects: confirmation email to guest + owner (FR-NOTIF-1). Side-effect failure never fails the webhook (log + retry queue-less v1: resend from the confirmation page).
Always 200 for well-formed, verified duplicates - providers retry non-2xx forever.

### 6.3 `GET /public/bookings/:id` → 200 (no auth) - confirmation page
`{ status, checkIn, checkOut, propertyName, unitName, totalPriceIdr, amountPaidIdr, waLink }` - `waLink` is the prefilled `wa.me` deeplink (FR-NOTIF-2). **Reconciles on read** (risk R3): if status is `pending_payment`, the handler queries the provider's status API before answering, so a lost webhook still confirms here. Unguessable UUID is the v1 access control; no PII beyond what the guest themselves entered.

---

## 7. Channel sync - M4 (boss fight #3, #38)

### 7.1 `POST /units/:id/channels` → 201 (auth)
Body: `{ channel: "airbnb" | "booking_com" | "vrbo", importIcalUrl }` (https URL, validated + fetched once immediately as a smoke test → `lastStatus`). One connection per (unit, channel) → 409 duplicate.

### 7.2 `GET /units/:id/channels` → 200 (auth)
Connections with `lastSyncedAt, lastStatus: never|ok|error, lastError?, openConflicts: number` (FR-SYNC-3 - failures surface, never silent).

### 7.3 `POST /channels/:id/sync` → 202 (auth)
Queues an immediate sync ("Sync now"); response `{ queued: true }`. Same pipeline as the 30-min cron (architecture flow B): healthy parse → per-VEVENT savepointed upserts by `externalUid` → absent-UID cancellation **only on a healthy feed** → conflicts recorded, never crash the cycle.

### 7.4 `DELETE /channels/:id` → 204 (auth)
Disconnects. Already-imported bookings are **kept** (they may reflect real stays) but stop being reconciled; the response body lists how many remain so the owner can clean up deliberately. Safer than auto-cancelling reality.

### 7.5 Conflict inbox (#38, db-design §4.8)
- `GET /sync-conflicts?status=open&propertyId?` → 200: `{ id, unitId, channel, externalUid, stay: {from,to}, firstDetectedAt, lastSeenAt, status }` - an imported VEVENT the exclusion constraint refused (a real-world double-sell).
- `POST /sync-conflicts/:id/dismiss` → 200 (`open → dismissed`; e.g. the OTA side was cancelled out-of-band).
- There is **no "resolve" endpoint**: resolution = cancel the blocking booking via §5.6, and the next sync cycle imports cleanly and auto-closes the conflict. The API never auto-cancels a confirmed booking (ADR 2026-07-16).

### 7.6 `GET /public/units/:id/calendar.ics` → 200 - export feed (FR-SYNC-2)
`Content-Type: text/calendar`. One all-day `VEVENT` per **confirmed occupying booking** (direct + imported + manual): `UID` = booking id, `DTSTART`/`DTEND` = half-open dates (DTEND exclusive - matches iCal semantics natively), `SUMMARY` = `"Unavailable (Sambung)"` - **no guest names, no prices** (this URL is pasted into OTAs). Unguessable unit UUID is the v1 access control; a per-unit feed token is the noted hardening step if the repo goes public-demo.

---

## 8. Cross-cutting behaviors (spec'd once, enforced everywhere)

1. **404-over-403 for cross-tenant probes** - verified by test per resource (the pattern exists for properties; every new resource copies it).
2. **Every write is FSM- and constraint-checked** - invalid transitions and overlaps are 409s with stable machine-readable `message` slugs; clients switch on those, not prose.
3. **Public endpoints are rate-limit candidates** (`/auth/*`, `/public/bookings*`) - deferred to M5, named here so it isn't forgotten. No CAPTCHA in v1.
4. **BigInt discipline:** DB `bigint` ⇄ JSON number happens in one serialization helper - `toRupiah()` in `packages/shared/src/money.ts` (#45); no `JSON.stringify` of raw rows with BigInt fields. The `Rupiah` brand is what enforces it: a bare `number` doesn't typecheck as a money field, so a response path can't skip the helper. It throws above `MAX_SAFE_INTEGER` rather than rounding - a stored value that big never came through `rupiahSchema`, so it's corruption, not a price.
5. **Testing seam** (matches existing prior art - `auth.spec.ts`, `properties.spec.ts`): behaviors in this spec are tested with supertest over real HTTP against the booted app + real Postgres; DB-owned invariants at the `packages/db` vitest seam; the only fakes sit at the outbound provider edge (Midtrans client, iCal fetch) so webhook/feed fixtures can drive flows end-to-end.
6. **A shared enum that mirrors a `pgEnum` is pinned to it by a test.** The web app must never import `packages/db` (invariant #1), so a wire-level enum (`booking_source`, `booking_status`, `payment_status`, `sync_status`, `user_role`) is necessarily hand-copied into `packages/shared` - two sources of truth for one list. `apps/api` is the only workspace that legitimately imports **both**, so the equality test lives there: `expect([...someSchema.options].sort()).toEqual([...somePgEnum.enumValues].sort())`. Add it in the same PR as the enum, never after.

   *Why this rule exists:* `bookingSourceSchema` shipped in M0 saying `"booking"`/`"manual"` where the pgEnum says `booking_com`/`vrbo`/`manual_block`, and `vrbo` was missing outright. Nothing imported it, so nothing failed - it sat waiting for M2 to import a type that **typechecks and then fails at the INSERT**, while `BookingSource` existed in `@sambung/db` *and* `@sambung/shared` with different values under the same name. It was deleted rather than fixed (#45 review): a wrong contract is worse than no contract, and the fix without this test just resets the clock.

## 9. Out of scope (v1, per PRD §2.2)

Real OTA push APIs · dynamic/seasonal pricing · multi-currency & real payouts · refunds via API · guest accounts/login · reviews · pagination · API versioning (single consumer) · access-token revocation lists.

---

*Change discipline: when an endpoint lands, its zod schema in `packages/shared` becomes the type truth and this doc's row flips to Built. If implementation diverges from a behavior written here, update this doc in the same PR - one source of truth per fact.*
