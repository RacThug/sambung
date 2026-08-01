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

## 1. Purpose

The tenant-wide knobs: how many photos a Property's Gallery may hold, and who else may work on the
Tenant's Properties. *(page-spec §4.7)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | The sidebar, and the "gallery is full - raise the limit in Settings" hint on the Property workbench. |
| **Exits to** | Nowhere. Every action stays on the page. |
| **URL params** | None. |
| **Query state** | None. |
| **Not in the URL** | The cap input's in-progress value, which staff row is being edited, and the invite form. |
| **Auth** | Authed. **`GET /settings` is open to any signed-in member**; every write, and every Team read, is owner-only. Staff get a read-only sentence, and the owner-only reads are **never issued**, so a Staff session produces no stray 403s. |

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

`staffMemberDtoSchema.id` and `.createdAt`, `inviteDtoSchema.id` and `.createdAt` are on the wire;
`createdAt` on both is **not rendered**, and neither `id` is displayed (both are used as mutation
targets).

The **raw invite token appears in no row on purpose**: no endpoint returns it, so a lost email means
revoke and re-invite rather than re-reading it here (ADR-0033).

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /settings` | on mount, `staleTime` 5 min | card only | yes - `["settings"]`, shared with the photo gallery, which is why raising the cap unblocks "Add photos" without a reload |
| `GET /staff` | on mount, **owner only** | section only | yes - `["staff"]` |
| `GET /auth/invites` | on mount, **owner only** | section only | yes - `["invites"]` |
| `GET /properties` | on mount, **owner only** (the property picker) | section only | yes - `["properties"]`, usually already warm from the calendar |
| `PATCH /settings` · `POST /auth/invites` · `DELETE /auth/invites/:id` · `PATCH /staff/:id` · `DELETE /staff/:id` | per action | mutations | n/a |

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

One leak, and a mild one: the "at least one property" rule is enforced by `assignedPropertyIdsSchema`'s
`min(1)` and mirrored by a disabled button plus an explanatory line ("pick at least one property, or
remove them instead"). The client copy is what makes the refusal legible; the schema is what makes it
true.

The fourth row is FE and not a leak: hiding a control is a courtesy, and `@Roles('owner')` answers 403
regardless.

---

## 8. Schema implications

**None.** `tenantSettingsResponseSchema`, `updateTenantSettingsRequestSchema`, `galleryCapSchema`,
`createInviteRequestSchema`, `inviteDtoSchema`, `listInvitesResponseSchema`, `staffMemberDtoSchema`,
`listStaffResponseSchema`, `updateStaffRequestSchema`, `assignedPropertyIdsSchema` and
`assignedPropertySchema` all exist.

---

## 9. Out of scope

- **Per-Property deposit %.** It lives on the workbench, because it is a per-Property fact (page-spec
  §4.7 says so explicitly).
- **Per-Property time zone.** Same reasoning.
- **What Staff can actually see.** Enforced by RLS on two axes (ADR-0032); this page only assigns.
- **Accepting an invite.** `/invite/$token`.
- **Billing.** Names nothing that exists.

---

## 10. Open questions

- [ ] **Three Team mutations render no failure at all.** Revoke, change-access and remove each have an
  `onSuccess` and nothing else, so a 500 leaves the button re-enabled and the list unchanged - visually
  identical to a no-op. Removing a colleague is the most consequential action on the page. **Owner:**
  builder. **Blocks:** nothing; three inline lines.
- [ ] **The Team section has no error or loading branch for invites.** "No pending invites" and "the read
  failed" are the same rendering (D5). **Owner:** builder.
- [ ] **An Owner's session issues four reads here**, three of them owner-only. Fine at this size; worth
  noting as the app's highest blocking-read count. **Owner:** RacThug.
