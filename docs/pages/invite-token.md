---
route: /invite/$token
status: shipped
prd_section: "FR-AUTH-2"
adrs: [ADR-0012, ADR-0024, ADR-0032, ADR-0033, ADR-0034]
verified: true
---

# Accept an invite - `/invite/$token`

> Migrated from [`../page-spec.md`](../page-spec.md) §3.4 (the `/invite/:token` paragraph). `[code]`
> rows read at commit **6702881** from `apps/web/src/features/auth/accept-invite-page.tsx`,
> `apps/web/src/lib/conflict.ts`, and `packages/shared/src/{staff, auth, conflict}.ts`.

---

## 1. Purpose

The one page reached from an email rather than by navigation: it shows an invitee who invited them and
to which Properties, then takes a password and turns the Invite into a **Staff Membership**.
*(page-spec §3.4, ADR-0033)*

---

## 2. Entry & exit

| | |
|---|---|
| **Arrives from** | The invite email only. The raw token exists nowhere else - no endpoint returns it (ADR-0033), so this URL cannot be reconstructed from the app. |
| **Exits to** | `/app` on success (accepting **is** signing in: the API sets the refresh cookie exactly as login does). `/login` from the "this invite can't be used" card. |
| **URL params** | `$token` - **the token is the credential**. Unknown → 404 with generic copy; known but spent → 409 with a specific reason. |
| **Query state** | None. |
| **Not in the URL** | The password, field errors, and the form error. |
| **Auth** | Public and deliberately un-guarded: no already-authed redirect, because someone signed in as one account may legitimately be opening an invite addressed to another. |

---

## 3. Data requirements

| Region | UI element | Field | Schema | Endpoint | Computed in | Source |
|---|---|---|---|---|---|---|
| Header | wordmark | - | none | - | FE | [code] |
| Preview | "Join `<tenant>`" heading | `tenantName` | `invitePreviewResponseSchema` | `GET /auth/invites/token/:token` | raw | [code] |
| Preview | the invited address | `email` | `invitePreviewResponseSchema` | `GET /auth/invites/token/:token` | raw | [code] |
| Preview | "you'll be able to manage" list | `propertyNames` | `invitePreviewResponseSchema` | `GET /auth/invites/token/:token` | raw | [code] |
| Preview | lead sentence, field label, button labels | `mode` | `inviteAcceptModeSchema` | `GET /auth/invites/token/:token` | BE discriminator → FE copy | [code] |
| Form | password input | `password` | `acceptInviteRequestSchema` | `POST /auth/invites/accept` | raw | [code] |
| Form | field error | - | `acceptInviteRequestSchema` | - | FE | [code] |
| Form | 409 refusal copy | `reason` | `inviteRefusalReasonSchema` | `POST /auth/invites/accept` | BE slug → FE prose | [code] |
| Form | 401 wrong-password copy | - | none | - | FE | [code] |
| Problem | "this invite can't be used" card | `code` | `conflictBodySchema` | `GET /auth/invites/token/:token` | BE slug → FE prose | [code] |
| (session) | access token, user, tenant, memberships | `accessToken`, `user`, `tenant`, `memberships` | `authResponseSchema` | `POST /auth/invites/accept` | BE | [code] |

`expiresAt` is on `invitePreviewResponseSchema` and is **not rendered here** - the expiry is shown to
the *owner* on the Team roster instead. Recorded rather than dropped.

**What is deliberately absent:** the invite id, the property ids, and the token hash. A page reached with
an unauthenticated token gets names to recognise, never identifiers to act on (`staff.ts`).

**The email is shown, never asked for.** It is whatever the invite says, so a holder cannot redirect a
seat to a different address.

---

## 4. Requests

| Endpoint | When called | Blocks render? | Mergeable? |
|---|---|---|---|
| `GET /auth/invites/token/:token` | on mount, `retry: false` | **yes** - nothing renders until it resolves | no - `["invite", token]` is unique to this link |
| `POST /auth/invites/accept` | on submit | mutation | n/a |

One blocking request.

---

## 5. States

Not governed by [`_list-pattern.md`](./_list-pattern.md) (auth surface).

| State | Behaviour |
|---|---|
| Loading | `h-40` pulse block. |
| Problem | One card covering **both** failure kinds, with different copy: a 409 renders the specific reason (expired / already used / withdrawn), anything else - including the 404 for an unknown token - renders generic copy. That asymmetry is the design: only a real holder learns why, so a guessed token confirms nothing. |
| Form (`mode: create`) | "Choose a password to set up your account", `autocomplete="new-password"`, submit reads "Create account". |
| Form (`mode: signin`) | "You already have a Sambung account - enter its password to add this workspace", `autocomplete="current-password"`, submit reads "Join workspace". |
| Submitting | Button label swaps, disabled. |
| Wrong password (`signin`) | 401 line: "that password doesn't match your Sambung account". **The invite is not spent** by this. |
| 409 on submit | The invite went stale between preview and accept; the reason renders as a form error. |

The four `mode` differences live in one object rather than four ternaries, so a fifth has one place to
go.

---

## 6. Interactions

| Trigger | Action | Feedback | Success | Failure | Optimistic? | Idempotent? |
|---|---|---|---|---|---|---|
| Submit | `POST /auth/invites/accept` | button → "Setting up…" / "Joining…" | `setSession(auth)` then navigate to `/app` | 409 → reason copy; 401 → wrong-password copy; 400 → field | no | **no, by design** - the invite is single-use, and a second accept is a `409 invite_not_acceptable {reason: "accepted"}` |
| "Go to sign in" | `<Link>` → `/login` | navigation | - | - | n/a | yes |

The single-use guarantee is a guarded UPDATE that runs **first** in the accept transaction, so two
racing accepts contend on that row and exactly one wins (ADR-0033). The button's disabled state is
cosmetic next to that.

---

## 7. Business rules

| Rule | Computed in | Field | Leak |
|---|---|---|---|
| `create` vs `signin` - whether this address already has an account | BE | `mode` | - |
| In `signin` mode the password is **verified**, not set | BE | - | - |
| A wrong password does not spend the invite | BE | - | - |
| An unknown token is a 404; a spent one is a 409 naming the reason | BE | `reason` | - |
| Accepting starts a session (sets the refresh cookie) | BE | `accessToken` | - |
| An invite is single-use and expires on its own | BE | - | - |
| Each refusal reason gets its own next step | FE | `reason` | - |

No leaks. Every domain decision is the server's; the browser only chooses words. The last row is FE
because the copy is the client's under ADR-0012, and it is exhaustive over `inviteRefusalReasonSchema`
so an un-worded reason is a compile error.

---

## 8. Schema implications

**None.** `invitePreviewResponseSchema`, `inviteAcceptModeSchema`, `acceptInviteRequestSchema`,
`inviteRefusalReasonSchema` and `authResponseSchema` all exist, and both `invite_not_acceptable` and
`invite_already_pending` are members of `conflictCodeSchema`.

---

## 9. Out of scope

- **Creating or revoking invites.** The owner's Team section on `/app/settings`.
- **What Staff can then see.** Enforced by RLS on both axes (ADR-0032), not by this page.
- **i18n.** English only, and excluded from the language switcher - it is an operator account page, like
  the dashboard, and the invite email is English too (ADR-0024).

---

## 10. Open questions

- [ ] **`expiresAt` is fetched and never shown.** The invitee cannot see how long their link is good
  for; only the inviting owner can, on the roster. Deliberate, or a gap? **Owner:** RacThug.
- [ ] **page-spec §3.4 predates the `mode` fork.** Its paragraph describes the page as "takes a
  password → staff session" with no mention of the create-vs-signin split that #154 added. This spec
  records the code. **Owner:** RacThug. **Blocks:** nothing; page-spec is legacy.
