---
route: /login
status: shipped
prd_section: "FR-AUTH-1"
adrs: [ADR-0024, ADR-0034]
verified: true
---

# Sign in - `/login`

> Migrated from [`../page-spec.md`](../page-spec.md) §3.4. `[code]` rows read at commit **6702881**
> from `apps/web/src/features/auth/{login-page.tsx, auth-search.ts}`, `apps/web/src/lib/auth.ts`,
> `apps/web/src/router.tsx`, and `packages/shared/src/auth.ts`.

---

## 1. Purpose

Where an **Owner** or **Staff** member starts a session, landing back wherever the auth guard bounced
them from. *(page-spec §3.4)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | The `/app/*` guard (`?next=<url>`), the second-401 logout path in `lib/api-client.ts`, the account menu's Log out, `/register`'s "sign in" link, and the invite page's "go to sign in". |
| **Exits to** | `?next` if present, else `/app` (which redirects to `/app/calendar`). `/register` via the footer link, carrying `?next` through. |
| **URL params** | None. |
| **Query state** | `authSearchSchema` - `?next`, the URL to return to. |
| **Not in the URL** | Email, password, and the submit error. |
| **Auth** | Public, with an inverted guard: `beforeLoad` calls `ensureSession()` and **redirects an already-authenticated visitor to `/app`**, so a live refresh cookie skips the form entirely. |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Header | wordmark, subtitle | - | none | - | FE | [code] |
| Form | email input | `email` | `loginRequestSchema` | `POST /auth/login` | raw | [code] |
| Form | password input | `password` | `loginRequestSchema` | `POST /auth/login` | raw | [code] |
| Form | per-field validation errors | - | `loginRequestSchema` | - | FE | [code] |
| Form | submit error line | - | none | - | FE | [code] |
| Form | submit button label | - | none | - | FE | [code] |
| Footer | "create account" link | `?next` | `authSearchSchema` | - | raw | [code] |
| (session) | access token → memory | `accessToken` | `authResponseSchema` | `POST /auth/login` | raw | [code] |
| (session) | active user + tenant | `user`, `tenant` | `userDtoSchema`, `tenantDtoSchema` | `POST /auth/login` | BE | [code] |
| (session) | workspace list | `memberships` | `membershipDtoSchema` | `POST /auth/login` | BE | [code] |

The last three are stored, not rendered: `setSession` keeps them in a module-level variable for the
shell's account menu and workspace switcher. `user.role` and `user.tenantId` describe the **active
membership**, not the person (ADR-0034), and the default seat is chosen server-side (owners first, then
oldest, tie-broken by tenant id), which is why they are `BE`.

The refresh token appears in no row: it is an httpOnly cookie the JS never sees (architecture §4.4).

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `POST /auth/refresh` | in `beforeLoad`, before the route renders | **yes** - via `ensureSession()`; the form does not paint until it settles | n/a - not a query |
| `POST /auth/login` | on submit | mutation | n/a |

One blocking request, and it is a guard rather than a data read.

---

## 5. States

Not governed by [`_list-pattern.md`](./_list-pattern.md) (auth surface, not a dashboard list).

| State | Behaviour |
|---|---|
| Form | Default. No skeleton: the guard resolves before the route renders. |
| Field errors | Rendered under each input from the shared schema, parsed client-side first. |
| Submitting | Button label swaps, disabled. |
| 401 | One line: "invalid credentials". **Never says which field was wrong** - no account-existence oracle (api-spec §3.2). |
| 403 | Its own line: the password was correct but the account holds no memberships (api-spec §3.2). Not an oracle - only a correct password reaches it - and the distinct copy is the whole point, so the person is not sent to reset a password that already works. |
| Other error | Generic line. |
| Already signed in | Never renders; `beforeLoad` throws a redirect to `/app`. |

A client-side parse failure calls `login.reset()` first, so a stale 401 cannot outlive corrected input.

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| Submit | `POST /auth/login` | button → "Signing in…" | `setSession(auth)` then navigate to `?next` or `/app` | 401 → "invalid credentials"; other → generic | no | yes - logging in twice yields another valid session |
| "Create account" | `<Link>` → `/register?next` | navigation | - | - | n/a | yes |

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| Wrong email and wrong password are indistinguishable | BE | - | - |
| The default workspace is owners-first, then oldest, tie-broken by tenant id | BE | `user.tenantId` | - |
| An account with zero memberships is refused with `403`, not `401` | BE | - | - |
| The access token lives in memory only, never `localStorage` | FE | `accessToken` | - |
| A live refresh cookie skips the form | FE | - | - |

The last two are FE and not leaks: both are browser-side session mechanics (architecture §4.4), not
domain rules the server could own.

---

## 8. Schema implications

**None.** `loginRequestSchema`, `authResponseSchema`, `userDtoSchema`, `tenantDtoSchema` and
`membershipDtoSchema` all exist.

---

## 9. Out of scope

- **Password reset.** Does not exist in v1 anywhere in the product, and its absence is load-bearing for
  the invite flow (ADR-0034's inert-account rule).
- **Workspace switching.** Post-login, in the dashboard shell (`POST /auth/session`).
- **The 401-retry loop.** `lib/api-client.ts`, applied to every authed request, not to this page.
- **i18n.** The page uses the funnel's catalog; the dashboard behind it stays English (ADR-0024).

---

## 10. Open questions

- [x] ~~**The `403` "no memberships" case has no copy.**~~ **Closed:** `auth.noWorkspace` added to all
  three catalogs, and the page branches on `403` separately from `401`.
