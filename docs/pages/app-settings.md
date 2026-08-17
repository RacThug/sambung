---
route: /app/settings
status: shipped
prd_section: "FR-PROP-1 · FR-AUTH-2"
adrs: [ADR-0012, ADR-0030, ADR-0032, ADR-0033, ADR-0034]
verified: true
---

# Settings - `/app/settings`

> Migrated from [`../page-spec.md`](../page-spec.md) §4.7. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/settings/{settings-page.tsx, use-settings.ts}`,
> `features/staff/{team-section.tsx, use-staff.ts}`, `apps/web/src/lib/role.ts`, and
> `packages/shared/src/{settings, photo, staff, property, conflict}.ts`.

---

> **AMENDMENT IN DRAFT (per-tenant payments, PRD-product P0-6 / REQ-PA-04, ADR-0039):** the rows
> marked `[TBD]` add a **Payments** section and are NOT built yet. They become `[code]` in the same
> PR that builds them; until then `docs:doctor` is deliberately red on this file (check 6).

## 1. Purpose

The tenant-wide knobs: how many photos a Property's Gallery may hold, who else may work on the
Tenant's Properties, and the Tenant's own payment-gateway credentials. *(page-spec §4.7; Payments
added by the REQ-PA-04 amendment)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | The sidebar, and the "gallery is full - raise the limit in Settings" hint on the Property workbench. |
| **Exits to** | Nowhere. Every action stays on the page. |
| **URL params** | None. |
| **Query state** | None. |
| **Not in the URL** | The cap input's in-progress value, which staff row is being edited, and the invite form. |
| **Auth** | Authed. **`GET /settings` is open to any signed-in member**; every write, and every Team read, is owner-only. Staff get a read-only sentence, and the owner-only reads are **never issued**, so a Staff session produces no stray 403s. The Payments section is owner-only in BOTH directions (read and write) - credentials are the shape of the Tenant's money, the ADR-0032 verb line's clearest case; Staff see nothing, not a read-only sentence. |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Header | page title + lead | - | none | - | FE | [code] |
| Photos | current cap (input value) | `galleryCap` | `tenantSettingsResponseSchema` | `GET /settings` | raw | [code] |
| Photos | input `min` / `max` | `galleryCeiling` | `tenantSettingsResponseSchema` | `GET /settings` | raw | [code] |
| Photos | "between 1 and N" + the never-deletes guarantee | `galleryCeiling` | `tenantSettingsResponseSchema` | `GET /settings` | FE | [code] |
| Photos | staff read-only sentence | `galleryCap` | `tenantSettingsResponseSchema` | `GET /settings` | FE | [code] |
| Photos | field error | `galleryCap` | `updateTenantSettingsRequestSchema` | `PATCH /settings` | FE | [code] |
| Photos | "Saved" / save error | - | none | - | FE | [code] |
| Team | section lead ("staff can manage the properties you assign…") | - | none | - | FE | [code] |
| Team | invite email input | `email` | `createInviteRequestSchema` | `POST /auth/invites` | raw | [code] |
| Team | property picker checkboxes | `id`, `name` | `assignedPropertySchema` / `propertyResponseSchema` | `GET /properties` | raw | [code] |
| Team | "add a property first" | - | none | - | FE | [code] |
| Team | "invite emailed to X" | - | none | - | FE | [code] |
| Team | invite 409 on the email field | `code` | `conflictBodySchema` | `POST /auth/invites` | BE slug → FE prose | [code] |
| Team | staff email | `email` | `staffMemberDtoSchema` | `GET /staff` | raw | [code] |
| Team | staff assignments summary | `properties[].name` | `assignedPropertySchema` | `GET /staff` | FE | [code] |
| Team | "no properties assigned" | `properties` | `staffMemberDtoSchema` | `GET /staff` | FE | [code] |
| Team | "pick at least one property" | - | `assignedPropertyIdsSchema` | - | FE | [code] |
| Team | pending invite email | `email` | `inviteDtoSchema` | `GET /auth/invites` | raw | [code] |
| Team | pending invite properties + expiry | `properties[].name`, `expiresAt` | `inviteDtoSchema` | `GET /auth/invites` | raw | [code] |
| Team | Change access / Remove / Revoke buttons | - | none | - | FE | [code] |
| Payments | status line: "configured <date> · sandbox / production" or "not configured" | `provider`, `environment`, `configuredAt`, `lastVerify` | **NEW** `paymentCredentialStatusResponseSchema` | **NEW** `GET /settings/payment-credentials` | raw | [TBD] |
| Payments | verify badge ("key checked ✓ / key check failed / unchecked") | `lastVerify` | **NEW** `paymentCredentialStatusResponseSchema` | **NEW** `GET /settings/payment-credentials` | BE | [TBD] |
| Payments | paste form: server key + environment select | `serverKey`, `environment` | **NEW** `savePaymentCredentialRequestSchema` | **NEW** `PUT /settings/payment-credentials/:provider` | raw | [TBD] |
| Payments | "never shown again" helper + activation checklist link | - | none | - | FE | [TBD] |
| Payments | save/replace feedback ("Saved. Guests can now pay online.") | - | none | - | FE | [TBD] |

`staffMemberDtoSchema.id` and `.createdAt`, `inviteDtoSchema.id` and `.createdAt` are on the wire;
`createdAt` on both is **not rendered**, and neither `id` is displayed (both are used as mutation
targets).

The **raw invite token appears in no row on purpose**: no endpoint returns it, so a lost email means
revoke and re-invite rather than re-reading it here (ADR-0033).

*(REQ-PA-04 draft)* **The server key appears in no row for the same reason, permanently**: no endpoint
ever returns it - not masked, not last-4 (that is partial readback). What the owner sees is that a key
exists, when it was saved, and whether the last verification call reached Midtrans. A lost key means
paste it again from the Midtrans dashboard - which is also the replace flow, one idempotent PUT.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /settings` | on mount, `staleTime` 5 min | card only | yes - `["settings"]`, shared with the photo gallery, which is why raising the cap unblocks "Add photos" without a reload |
| `GET /staff` | on mount, **owner only** | section only | yes - `["staff"]` |
| `GET /auth/invites` | on mount, **owner only** | section only | yes - `["invites"]` |
| `GET /properties` | on mount, **owner only** (the property picker) | section only | yes - `["properties"]`, usually already warm from the calendar |
| **NEW** `GET /settings/payment-credentials` | on mount, **owner only** | section only | yes - `["payment-credentials"]` |
| `PATCH /settings` · `POST /auth/invites` · `DELETE /auth/invites/:id` · `PATCH /staff/:id` · `DELETE /staff/:id` · **NEW** `PUT /settings/payment-credentials/:provider` | per action | mutations | n/a |

**Four blocking reads for an Owner** - the most on any page - though each blocks only its own card or
list, and a Staff session issues exactly one.

---

## 5. States

Follows [`_list-pattern.md`](./_list-pattern.md). Deltas:

- **Role is a whole-page fork, not a disabled control.** An Owner gets two forms; a Staff member gets one
  read-only sentence per section. This is `_list-pattern.md` §3.4's "403 is never rendered because it is
  never reached", and it is the only page where the fork is the page's main axis.
- **The gallery-cap card has an error branch; the Team section has none.** A failed `GET /staff` renders
  the roster's empty line ("Nobody yet. Invite someone above."), and a failed `GET /auth/invites` renders
  no pending-invites heading at all - D5 twice.
- **The pending-invites list has no loading and no empty state**: it renders only when the array is
  non-empty, so "no pending invites" and "we could not load them" look identical.
- **Save feedback is a quiet "Saved" beside the button**, not a toast (D7).
- The cap input re-syncs from the server's answer after a save via an effect, without stranding what the
  owner is currently typing.

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| Save cap | `PATCH /settings` | button → "Saving…" | `setQueryData(["settings"])` from the response - painted, not refetched | 400 → field; other → inline | no | yes |
| Send invite | `POST /auth/invites` | button → "Sending…" | invalidate `["invites"]`, clear the form, "invite emailed to X" | 409 → email field; 400 → fields | no | **no** - a second live invite for one address is `409 invite_already_pending` |
| Revoke invite | `DELETE /auth/invites/:id` | button → "Revoking…" | invalidate `["invites"]` only - it has no business refetching the roster | *(no error branch)* | no | yes - 404-over-403, idempotent |
| Change access | `PATCH /staff/:id` | button → "Saving…" | invalidate `["staff"]`, close the editor | *(no error branch)* | no | yes - a whole-set write |
| Remove staff | `window.confirm` → `DELETE /staff/:id` | - | invalidate `["staff"]` | *(no error branch)* | no | yes |
| Save / replace a payment key *(draft)* | `PUT /settings/payment-credentials/:provider` | button → "Saving…" (the server verifies against Midtrans inline, so it can take a beat) | invalidate `["payment-credentials"]`, clear the input, show the status line | 400 → field (bad shape); verify-failure is NOT a refusal - the key stores, the badge says "key check failed" (see §7) | no | yes - an idempotent overwrite; replacing with the same key is a no-op in effect |

Removing a colleague asks first: it is not undone by a second click, which is the same bar as deleting
inventory (`_list-pattern.md` §6.4). The three Team mutations have **no failure rendering at all** - a
failed revoke or reassignment is silent.

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| The cap is the tenant's own line; the ceiling is the system guard | BE | `galleryCap`, `galleryCeiling` | - |
| A write may never **grow** a gallery past the cap - so lowering it never deletes a photo | BE | - | - |
| `GET /settings` is open to any member; `PATCH` is owner-only | BE (`@Roles`) | - | - |
| Owner-only sections are hidden, and their reads never issued | FE | - | - |
| A staff member must hold at least one Property | FE (button) + BE (schema min 1) | `propertyIds` | `leak: true` |
| Assignments are a whole-set write - shortening the list removes access | BE | `propertyIds` | - |
| An invite is refused if this Tenant already has a live one for that address | BE | `code` | - |
| An address that already holds a membership **here** is refused; one at another Tenant is invited normally | BE | `code` | - |
| Removing a staff member ends the Membership, not the account | BE | - | - |
| A failed invite email rolls the invite back | BE | - | - |
| The server key is write-only: no endpoint returns it, in any form *(draft)* | BE | - | - |
| Credentials are encrypted at rest with the app-held key; ciphertext is read only on the owner connection at the gateway layer, never under a principal's RLS scope *(draft)* | BE | - | - |
| Online checkout is available iff a credential EXISTS; the verify badge is information, not a gate *(draft)* | BE | `onlinePaymentsAvailable` (public), `lastVerify` (here) | - |
| Verify-on-save stores its outcome instead of refusing: a Midtrans outage must not stop a valid key being saved (the channels smoke-fetch rule, #55) *(draft)* | BE | `lastVerify` | - |
| Payments is owner-only both directions - 403 for staff, before any lookup *(draft)* | BE (`@Roles`) | - | - |

One leak, and a mild one: the "at least one property" rule is enforced by `assignedPropertyIdsSchema`'s
`min(1)` and mirrored by a disabled button plus an explanatory line ("pick at least one property, or
remove them instead"). The client copy is what makes the refusal legible; the schema is what makes it
true.

The fourth row is FE and not a leak: hiding a control is a courtesy, and `@Roles('owner')` answers 403
regardless.

---

## 8. Schema implications

**None for the shipped page.** `tenantSettingsResponseSchema`, `updateTenantSettingsRequestSchema`,
`galleryCapSchema`, `createInviteRequestSchema`, `inviteDtoSchema`, `listInvitesResponseSchema`,
`staffMemberDtoSchema`, `listStaffResponseSchema`, `updateStaffRequestSchema`,
`assignedPropertyIdsSchema` and `assignedPropertySchema` all exist.

**DRAFT (REQ-PA-04 amendment)** - every **NEW** in §3 resolves here:

| Change | Table / package | Migration | Why |
|---|---|---|---|
| `tenant_payment_credential` (id, `tenant_id` unique-with-`provider`, `provider text`, `environment` ('sandbox' / 'production'), `ciphertext bytea`, `nonce bytea`, `key_version smallint`, `last_verify_status` + `last_verify_at`, `created_at`, `updated_at`) | `packages/db` | `0018_tenant_payment_credential.sql` | ADR-0039: credentials on the tenant. A TABLE, not tenant columns - multi-field secret material with a provider axis and a lifecycle, kept out of the hot `tenant` row |
| RLS policy: tenant term only, and the SELECT the dashboard issues never includes `ciphertext`/`nonce` - the decrypting read happens at the gateway layer on the owner connection | `packages/db` | same | A Visitor-scoped pay request must never be able to SELECT secret material; the owner-connection read is the sweeper/webhook category (system config, not an actor browsing) |
| `savePaymentCredentialRequestSchema` (`strictObject`; serverKey trimmed, bounded; environment enum) | `packages/shared` | n/a | The one inbound body. The serverKey field exists ONLY here - in no response schema, ever |
| `paymentCredentialStatusResponseSchema` (provider, environment, configuredAt, lastVerify status+at) | `packages/shared` | n/a | What the owner may know about a stored key |
| `payments_not_configured` added to `conflictCodeSchema` + `describeConflict` copy | `packages/shared` + web | n/a | The pay/booking refusal when no credential exists (ADR-0012) |
| `publicPropertyResponseSchema` gains derived `onlinePaymentsAvailable: boolean` | `packages/shared` | n/a | Decision 4 (ADR-0039): the funnel disables checkout honestly instead of letting a guest hit the 409 |
| New env `CREDENTIAL_ENCRYPTION_KEY` (base64, 32 bytes) + `validateEnv` guard: refuse to boot a DEPLOYMENT (the #193 predicate) without it; `MIDTRANS_SERVER_KEY` leaves the production path (seed-only) | `apps/api` | n/a | No shared key to fall back to; a key-less deployment with stored credentials is bricked checkouts and must be loud |
| `docs/runbooks/credential-key.md`: generate, back up, rotate (`key_version`) | docs | n/a | ADR-0039's stated consequence: losing this key bricks every tenant's checkout - the runbook ships WITH the first credential, not after |

---

## 9. Out of scope

- **Per-Property deposit %.** It lives on the workbench, because it is a per-Property fact (page-spec
  §4.7 says so explicitly).
- **Per-Property time zone.** Same reasoning.
- **What Staff can actually see.** Enforced by RLS on two axes (ADR-0032); this page only assigns.
- **Accepting an invite.** `/invite/$token`.
- **Billing.** Names nothing that exists.
- **Deleting a credential** (= deliberately disabling online payments). Replace is the only verb at
  MVP; a tenant who wants out swaps in a revoked key or asks. Revisit on real demand.
- **Xendit.** The `provider` axis exists in the table and the URL, but only `midtrans` is accepted
  until a second gateway is actually built (ADR-0039's deferred sub-merchant path is further still).
- **The "signature failing since…" inbox item** (ADR-0039's last consequence). Follow-up, not this
  slice - failures are loud in the log meanwhile.
- **Per-property credentials.** ADR-0039 decision 1's wording notwithstanding, the credential is the
  TENANT's (one merchant account per business); the per-property resolution happens through the
  booking's tenant.

---

## 10. Open questions

- [ ] **Three Team mutations render no failure at all.** Revoke, change-access and remove each have an
  `onSuccess` and nothing else, so a 500 leaves the button re-enabled and the list unchanged - visually
  identical to a no-op. Removing a colleague is the most consequential action on the page. **Owner:**
  builder. **Blocks:** nothing; three inline lines.
- [ ] **The Team section has no error or loading branch for invites.** "No pending invites" and "the read
  failed" are the same rendering (D5). **Owner:** builder.
- [ ] **An Owner's session issues four reads here**, three of them owner-only. Fine at this size; worth
  noting as the app's highest blocking-read count (five with the Payments read). **Owner:** RacThug.
- [ ] *(REQ-PA-04 draft)* **What does the demo tenant show?** The seed encrypts the sandbox key from
  `MIDTRANS_SERVER_KEY` (if set) into Bali Breeze so `demo.md` keeps working; a keyless dev machine
  gets the "not configured" state - which is itself demoable (decision 4). Confirm that trade reads
  fine in the demo script. **Owner:** RacThug. **Blocks:** the seed change only.
