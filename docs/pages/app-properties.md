---
route: /app/properties
status: shipped
prd_section: "FR-PROP-1"
adrs: [ADR-0002, ADR-0005, ADR-0006, ADR-0012, ADR-0032]
verified: true
---

# Properties - `/app/properties`

> Migrated from [`../page-spec.md`](../page-spec.md) §4.4. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/properties/{properties-page.tsx, verified-badge.tsx}`,
> `apps/web/src/lib/role.ts`, and `packages/shared/src/{property, unit}.ts`.

---

## 1. Purpose

Inventory home: an **Owner** sees every Property and adds one; **Staff** see the ones they are assigned.
*(page-spec §4.4)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | The sidebar, and every calendar empty-state CTA. |
| **Exits to** | `/app/properties/$propertyId` - by clicking a card, and automatically after a successful create. |
| **URL params** | None. |
| **Query state** | None. The list is small and whole; there is nothing to filter. |
| **Not in the URL** | The create dialog's open state and its name field. |
| **Auth** | Authed. The list is narrowed by RLS for Staff - **nothing on this page filters** (ADR-0032). Creating is owner-only. |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Header | page title | - | none | - | FE | [code] |
| Header | "New property" button | - | none | - | FE | [code] |
| Card | property name | `name` | `propertyResponseSchema` | `GET /properties` | raw | [code] |
| Card | Verified badge | `verified` | `propertyResponseSchema` | `GET /properties` | BE | [code] |
| Card | "Archived" pill | `archivedAt` | `propertyResponseSchema` | `GET /properties` | FE | [code] |
| Card | address | `address` | `propertyResponseSchema` | `GET /properties` | raw | [code] |
| Card | status line: archived / ready / incomplete | `archivedAt`, `publishable` | `propertyResponseSchema` | `GET /properties` | FE (precedence) over BE (`publishable`) | [code] |
| Empty | owner copy + CTA | - | none | - | FE | [code] |
| Empty | staff copy | - | none | - | FE | [code] |
| Dialog | name input | `name` | `createPropertyRequestSchema` | `POST /properties` | raw | [code] |
| Dialog | field error | - | `createPropertyRequestSchema` | - | FE | [code] |
| (nav) | new property's id | `id` | `propertyResponseSchema` | `POST /properties` | raw | [code] |

`propertyResponseSchema` carries eleven more fields this page never renders - `slug`, `tenantId`,
`latitude`, `longitude`, `description`, `licenseNo`, `depositPct`, `timeZone`, `photos`, `createdAt` -
all of which belong to the workbench. The list reads the same endpoint and uses a sixth of it.

`publishable` is `BE` (derived in `apps/api` via shared `isPublishable`), but **which of the three status
lines shows** is FE: archived wins over publishable.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /properties` | on mount | **yes, whole page** - the early return replaces the header too | yes - `["properties"]`, shared with the calendar, reservations and the Team section |
| `POST /properties` | dialog submit | mutation | n/a |

One blocking read.

---

## 5. States

Follows [`_list-pattern.md`](./_list-pattern.md), with three deltas that are all divergences the pattern
already records:

- **Loading is a line of text, not a skeleton, and it replaces the `<PageHeader>`** - the early return
  fires before the header renders, so the title and primary action vanish and pop back in. This is D1.
- **The loading gate is `isLoading`, not `!data`** - so a failed read falls through. This is D2.
- **There is no error branch.** A failed `GET /properties` renders the *empty state*, telling an Owner to
  add their first property when the truth is that the list could not be loaded. This is D5, and this page
  is its clearest instance.
- **Empty forks on role**, which the pattern's §2.1 uses as its sharpest example: an empty list means
  "get started" to an Owner and "nobody has assigned you anything" to Staff, and offering Staff a create
  button the server would 403 is worse than useless.

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| "New property" (header or empty state) | opens the dialog | dialog | - | n/a | n/a | yes |
| Dialog submit | `POST /properties` | button → "Creating…" | invalidate `["properties"]`, then navigate to the new workbench | 400 → field error; other → **nothing rendered** | no | **no** - a second submit creates a second Property; nothing prevents it but the disabled button |
| Cancel | closes the dialog | - | - | - | n/a | yes |
| Click a card | `<Link>` → the workbench | navigation | - | n/a | n/a | yes |

The create dialog is hand-rolled (a fixed-position div with `role="dialog"`), not the shadcn `Dialog` the
booking cancel uses. Another instance of `_list-pattern.md` D10.

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| Only an Owner may create a Property | BE (`@Roles`) + FE (hiding) | - | - |
| Staff see only assigned Properties | BE (RLS) | - | - |
| Verified = a licence is on file | BE | `verified` | - |
| Publishable = at least one photo and one priced, active Unit | BE | `publishable` | - |
| Archived beats publishable in the status line | FE | `archivedAt`, `publishable` | `leak: true` |
| Archived = `archivedAt` is set | FE | `archivedAt` | `leak: true` |
| An empty list means something different to Staff | FE | - | - |

Two leaks, both small: the precedence rule encodes ADR-0006's "a retired Property is offline regardless
of how complete it is", and the archived test is shared `isArchived` applied client-side.

The first row is FE **and** BE and is not a leak: the server refuses with 403 either way, and the client
only declines to offer a dead end (`lib/role.ts` says exactly this).

---

## 8. Schema implications

**None.** `propertyResponseSchema`, `createPropertyRequestSchema` and `isArchived` all exist.

---

## 9. Out of scope

- **Editing anything.** The workbench (page-spec §4.5); the dialog takes only a name, because that is all
  it needs to get there.
- **Deleting or archiving.** Owner-only verbs on the workbench.
- **The public page.** `/p/$slug`, reachable from the workbench's copy-link control.

---

## 10. Open questions

- [ ] **A failed read is indistinguishable from an empty tenant.** The highest-severity instance of D5,
  because the copy actively misleads: an Owner whose network blipped is told to add their first property.
  **Owner:** RacThug. **Blocks:** nothing; it is an error branch.
- [ ] **A create error renders nothing** unless it maps to a field. A 500 leaves "Creating…" and a silent
  no-op. **Owner:** builder.
- [ ] **Create is not idempotent.** A double submit makes two Properties, and unlike a Unit there is no
  unique constraint on the name to catch it. **Owner:** builder.
