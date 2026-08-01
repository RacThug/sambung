---
route: /app
status: shipped
prd_section: "FR-AUTH-1 · FR-AUTH-2"
adrs: [ADR-0007, ADR-0027, ADR-0022, ADR-0032, ADR-0034, ADR-0037]
verified: true
---

# Dashboard shell - `/app`

> Written to close the gap `MIGRATION-REPORT.md` §1 recorded: `page-spec.md` §2 treats the shell as
> cross-cutting behaviour rather than a page, so four shipped surfaces and one endpoint were documented
> nowhere. `[code]` rows read at commit **6702881** from
> `apps/web/src/features/dashboard/{app-shell, sidebar, account-menu, workspace-switcher}.tsx`,
> `use-inbox-count.ts`, `apps/web/src/lib/{auth, use-session, api-client, role}.ts`,
> `apps/web/src/components/page-header.tsx`, `apps/web/src/router.tsx`, and
> `packages/shared/src/auth.ts`.
>
> Not a page in the usual sense: it renders no content of its own and its index redirects away. It is
> specified because it owns the **session**, and everything under it inherits that.

---

## 1. Purpose

The frame every `/app/*` page renders inside: it proves there is a session, says whose it is, and gives
an **Owner** or **Staff** member one place to navigate, switch Workspace, and sign out.

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | `/login` and `/register` on success, `/invite/$token` on accept, and any bookmarked `/app/*` URL. |
| **Exits to** | `/app/calendar` (the index redirect), any sidebar destination, and `/login` on sign-out or a dead session. |
| **URL params** | None. |
| **Query state** | None of its own. Each child page owns its own search params. |
| **Not in the URL** | The mobile drawer's open state, the account menu's open state, and the switcher's in-flight state. |
| **Auth** | **This is the guard.** `beforeLoad` calls `ensureSession()`; no token in memory triggers one silent `POST /auth/refresh`, and failure throws a redirect to `/login?next=<current-url>`. |

The guard runs **before** the route renders, so no `/app/*` page ever paints for an unauthenticated
visitor. A second, independent path exists for a session that dies mid-visit: `lib/api-client.ts`
retries any 401 once after a silent refresh, and a second 401 clears the session and hard-navigates to
`/login?next=`.

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Guard | session restore | `accessToken` | `authResponseSchema` | `POST /auth/refresh` | raw | [code] |
| Sidebar | wordmark → `/app/calendar` | - | none | - | FE | [code] |
| Sidebar | workspace name (single membership) | `tenant.name` | `tenantDtoSchema` | `POST /auth/refresh` | raw | [code] |
| Sidebar | workspace `<select>` (2+ memberships) | `memberships[].tenantName` | `membershipDtoSchema` | `POST /auth/refresh` | raw | [code] |
| Sidebar | which workspace is selected | `tenant.id` | `tenantDtoSchema` | `POST /auth/refresh` | raw | [code] |
| Sidebar | "couldn't switch" alert | - | none | - | FE | [code] |
| Sidebar | nav groups (Operate / Manage) | - | none | - | FE | [code] |
| Sidebar | active-link highlight | - | none | - | FE | [code] |
| Sidebar | Inbox count badge | - | none | `GET /sync-conflicts`, `GET /payments/lapsed` | FE | [code] |
| Top bar | mobile nav trigger | - | none | - | FE | [code] |
| Top bar | page title + primary action slot | - | none | - | FE | [code] |
| Account | avatar initial | `user.email` | `userDtoSchema` | `POST /auth/refresh` | FE | [code] |
| Account | email | `user.email` | `userDtoSchema` | `POST /auth/refresh` | raw | [code] |
| Account | role | `user.role` | `userRoleSchema` | `POST /auth/refresh` | raw | [code] |
| Account | "Log out" | - | none | `POST /auth/logout` | FE | [code] |
| Content | full-bleed vs capped width | - | none | - | FE | [code] |
| (switch) | new session | `accessToken`, `user`, `tenant`, `memberships` | `switchTenantRequestSchema`, `authResponseSchema` | `POST /auth/session` | BE | [code] |

`user.role` and `user.tenantId` describe the **active membership**, not the person (ADR-0034): the same
account can be an Owner here and Staff elsewhere, so both change when the Workspace switches.

The refresh token appears in no row: it is an httpOnly cookie the JS never sees (architecture §4.4).

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `POST /auth/refresh` | in `beforeLoad`, and again on any 401 from any authed request | **yes** - the whole subtree waits | n/a - not a query, and deliberately a raw `fetch` so the api client's own 401 handler cannot recurse into it |
| `GET /sync-conflicts` | on mount of **every** `/app/*` page (the badge) | no | yes - `["sync-conflicts"]`, the same entry `/app/inbox` reads |
| `GET /payments/lapsed` | same | no | yes - `["lapsed-payments"]`, same |
| `POST /auth/session` | workspace switch | mutation | n/a |
| `POST /auth/logout` | account menu | mutation | n/a |

**One blocking request.** The two badge reads are the price of a count that cannot disagree with the
page it counts (`_list-pattern.md` §6.5): the badge calls the inbox sections' own hooks rather than
fetching again, so each list is one cache entry shared by the nav and the page.

---

## 5. States

Follows [`_list-pattern.md`](./_list-pattern.md). Deltas:

- **No loading state of its own.** The guard resolves before the route renders, so the shell either
  exists or the visitor is at `/login`.
- **The badge is best-effort**: an error or a cold cache reads as `0`, and it renders nothing at zero. A
  nav badge must never block navigation, so it has no error branch by design.
- **The switcher renders as plain text when the account holds one membership** - a control that never has
  a second option is chrome pretending to be a feature.
- **A failed switch says so** (`role="alert"`). Without it the `<select>` springs back to the current
  tenant on its own, because it is controlled by the session, and the honest reading of a silent
  spring-back is "this app is broken" rather than "that failed, try again".
- **Content width is decided once, here**, from a `WIDE_ROUTES` set: full-bleed for the calendar and
  reservations, capped at ~1024px for everything else. No page sets its own width (ADR-0037).

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| Switch workspace | `POST /auth/session {tenantId}` | select disables | `setSession(auth)` then **`queryClient.resetQueries()`** | inline "couldn't switch" alert | no | yes - it re-issues for a seat already held |
| "Log out" | `POST /auth/logout` | - | `clearSession()`, navigate to `/login` | **swallowed** - the local session is cleared regardless | no | yes |
| Open mobile nav | Radix `Dialog` drawer | drawer slides in | - | n/a | n/a | yes |
| Navigate | route change | drawer auto-closes | - | n/a | n/a | yes |
| Open account menu | disclosure toggle | panel opens; Escape closes and **returns focus to the trigger** | - | n/a | n/a | yes |

**`resetQueries`, not `invalidateQueries`, is the load-bearing detail of the switch.** An invalidated
query keeps *rendering* its stale data while it refetches, which would show one Tenant's calendar under
another Tenant's name for a frame. Reset drops the data, so every page falls to its loading state and
refetches under the new seat.

Logout swallows its own failure on purpose: the server call is a courtesy (it clears the cookie), and a
user who pressed "Log out" must end up logged out of this browser whatever the network did.

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| No session → one silent refresh → else `/login?next=` | FE | `accessToken` | - |
| A second 401 ends the session | FE | - | - |
| The access token lives in memory only | FE | `accessToken` | - |
| The default Workspace is owners-first, then oldest, tie-broken by tenant id | BE | `tenant.id` | - |
| A Tenant the caller holds no membership at is a `404`, never a `403` | BE | - | - |
| Switching re-issues the refresh cookie for the new seat | BE | - | - |
| The switcher appears only at 2+ memberships | FE | `memberships` | - |
| The Inbox count is open conflicts **plus** lapsed payments | FE | - | `leak: true` |
| Which routes are full-bleed | FE | - | - |

**One leak**, and it is the same one `app-inbox.md` records: nothing on the server answers "how many
things need me", so the client defines the inbox by summing two lists. Add a third queue and this is
where it will be forgotten.

The session rules are FE and deliberately not leaks: token lifetime, retry-once and where-to-redirect are
browser-side session mechanics (architecture §4.4), not domain rules a server could own.

---

## 8. Schema implications

**None.** `authResponseSchema`, `userDtoSchema`, `tenantDtoSchema`, `membershipDtoSchema`,
`userRoleSchema` and `switchTenantRequestSchema` all exist.

Writing this spec is what removed `switchTenantRequestSchema` from
[`_schema-allowlist.md`](./_schema-allowlist.md): it was unreferenced only because the page that posts it
had no spec.

---

## 9. Out of scope

- **Every child page.** The shell renders an `<Outlet>` and owns none of their data.
- **The page title and primary action.** Each page portals its own in through `<PageHeader>`; the shell
  only provides the slot.
- **Role gating.** The shell is identical for Owner and Staff; owner-only affordances are hidden by the
  pages that own them (`lib/role.ts`).
- **`GET /auth/me`.** It exists and nothing calls it - the SPA restores through `refresh`, which already
  returns the same shape. See `_schema-allowlist.md`.

---

## 10. Open questions

- [ ] **The Inbox count is defined only in the client.** Same question as `app-inbox.md` §10; recorded in
  both places because the badge and the page would each need changing. **Owner:** builder.
- [ ] **Both badge reads fire on every `/app/*` navigation.** Correct for freshness, and it is two extra
  requests per page load. **Owner:** RacThug.
- [ ] **The top bar's page title and primary action were deferred by ADR-0037** and shipped as a portal
  slot instead. Pages still render their own `<h1>` when no slot exists. Is the slot the final shape?
  **Owner:** RacThug.
