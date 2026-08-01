---
route: /register
status: shipped
prd_section: "FR-AUTH-1"
adrs: [ADR-0012, ADR-0024, ADR-0034]
verified: true
---

# Sign up - `/register`

> Migrated from [`../page-spec.md`](../page-spec.md) §3.4. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/auth/{register-page.tsx, auth-search.ts}`, `apps/web/src/lib/conflict.ts`,
> and `packages/shared/src/{auth, conflict}.ts`.

---

## 1. Purpose

Creates a **Tenant, its first Owner, and the Membership joining them** in one step, and signs the new
Owner straight in. *(page-spec §3.4, api-spec §3.1)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | `/login`'s "new to Sambung" link (carrying `?next`), and direct navigation. Not linked from the funnel: a Guest never registers. |
| **Exits to** | `?next` if present, else `/app`. `/login` via the footer link, carrying `?next`. |
| **URL params** | None. |
| **Query state** | `authSearchSchema` - `?next`. |
| **Not in the URL** | Business name, email, password, errors. |
| **Auth** | Public, with the same inverted guard as `/login`: an already-authenticated visitor is redirected to `/app`. |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Header | wordmark, subtitle | - | none | - | FE | [code] |
| Form | business name input | `tenantName` | `registerRequestSchema` | `POST /auth/register` | raw | [code] |
| Form | email input | `email` | `registerRequestSchema` | `POST /auth/register` | raw | [code] |
| Form | password input | `password` | `registerRequestSchema` | `POST /auth/register` | raw | [code] |
| Form | per-field validation errors | - | `registerRequestSchema` | - | FE | [code] |
| Form | "email already registered" on the email field | `code` | `conflictBodySchema` | `POST /auth/register` | BE slug → FE prose | [code] |
| Form | generic submit error | - | none | - | FE | [code] |
| Form | submit button label | - | none | - | FE | [code] |
| Footer | "sign in" link | `?next` | `authSearchSchema` | - | raw | [code] |
| (session) | access token → memory | `accessToken` | `authResponseSchema` | `POST /auth/register` | raw | [code] |
| (session) | active user + tenant | `user`, `tenant` | `userDtoSchema`, `tenantDtoSchema` | `POST /auth/register` | BE | [code] |
| (session) | workspace list | `memberships` | `membershipDtoSchema` | `POST /auth/register` | BE | [code] |

The 409 row is the pattern the whole app uses (ADR-0012): the server sends the slug `email_taken` and
the browser renders its own localized copy on the offending field. The page switches on the slug, not on
the bare status.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `POST /auth/refresh` | in `beforeLoad` | **yes** - via `ensureSession()` | n/a |
| `POST /auth/register` | on submit | mutation | n/a |

One blocking request, and it is the guard.

---

## 5. States

Not governed by [`_list-pattern.md`](./_list-pattern.md) (auth surface).

| State | Behaviour |
|---|---|
| Form | Default; no skeleton. |
| Field errors | Under each input, from the shared schema. |
| Submitting | Button label swaps, disabled. |
| 409 `email_taken` | On the **email field**, not in a banner - it is a fact about that input. |
| Other error | Generic line. |
| Already signed in | Never renders; redirected. |

A client-side parse failure calls `register.reset()` first, so a stale 409 cannot misdescribe a retyped
email.

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| Submit | `POST /auth/register` | button → "Creating account…" | `setSession(auth)` then navigate | 409 `email_taken` → email field; 400 → fields; other → generic | no | **no** - a second success would be a second Tenant; the global email unique makes the retry a 409 instead |
| "Sign in" | `<Link>` → `/login?next` | navigation | - | - | n/a | yes |

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| Tenant + Owner + Membership are created atomically | BE | - | - |
| `app_user.email` is globally unique, so an address that exists anywhere is refused | BE | `code` | - |
| The concurrent-signup race is arbitrated by the citext UNIQUE, not the pre-check | BE | `code` | - |
| Registration is refused for an existing address even when the caller owns it | BE | `code` | - |

No FE business rules, and no leaks: this page is a form over one endpoint.

The third row is the invariant #5 shape at the auth layer - the pre-check is UX, the constraint is
correctness, and both throw the same factory so the bodies are byte-identical (api-spec §3.1).

The fourth is a deliberate v1 limitation, not an oversight: an unauthenticated signup cannot know the
caller holds that address, so "create another workspace" would have to be an authenticated verb, and
`POST /tenants` does not exist (ADR-0034).

---

## 8. Schema implications

**None.** `registerRequestSchema`, `authResponseSchema` and `conflictBodySchema` all exist, and
`email_taken` is already a member of `conflictCodeSchema`.

---

## 9. Out of scope

- **Joining an existing Tenant.** That is an Invite (`/invite/$token`), not registration.
- **One person owning two Tenants.** Deliberately unbuilt (ADR-0034); register 409s.
- **Email verification.** Not in v1.

---

## 10. Open questions

None. Every value on this page traces to a schema and an endpoint, and no rule is computed in the
browser.
