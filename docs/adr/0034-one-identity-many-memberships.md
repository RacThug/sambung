# ADR-0034: One identity, many memberships

- **Date**: 2026-07-22
- **Status**: Accepted
- **Issue**: #154 (filed by the independent review of #57)
- **Builds on**: ADR-0032 (the property axis in RLS - the scope this now reads from a membership), ADR-0033 (the invite whose refusal this removes), the #74 fail-closed lesson
- **Migration**: `0016_membership.sql`

## Context

`app_user` answered two questions with one row: *who is signing in?* and *who are they here?* The
first needs a globally unique email, because login is `email + password` and carries no tenant -
two rows sharing an address would make "which account is this?" unanswerable. The second is a
per-tenant fact. Fusing them turned the first requirement into a limit on the **person**: one
address, one Tenant, permanently.

#57 could only make that fail legibly. `POST /auth/invites` checked globally and refused with
`409 email_taken` before creating or emailing anything, which is honest but is still a wall: a
property manager working for two villa owners - squarely Sambung's market - cannot be invited by
the second one.

## Decision

**`app_user` becomes identity. `membership (app_user_id, tenant_id, role)` becomes belonging.**

Owner and Staff stop being kinds of person and become **what a membership is**. The same account
can own one Tenant and be staff at another, and `role` moves to the row that can say which.

### The composite FKs move, and get stronger

`user_property (app_user_id, tenant_id)` and `staff_invite (created_by, tenant_id)` pointed at
`app_user (id, tenant_id)`. They now point at `membership (app_user_id, tenant_id)`.

That is not bookkeeping. `app_user (id, tenant_id)` asserted "this user's one tenant is this one";
`membership (app_user_id, tenant_id)` asserts "this user is a **member** of this tenant" - which is
the sentence both FKs were always trying to enforce, and it is the one that survives a second seat.
Ending a membership now cascades its Assignments away with it, which is what makes
`DELETE /staff/:id` a single statement.

### RLS: the tenant term moves to where the tenant lives

`app_user`'s policy was `tenant_id = <guc>` on a column that no longer exists. It becomes an
`EXISTS` over `membership`. Nothing else about either RLS axis changes - the property term
(ADR-0032) is untouched, and every other policy is untouched.

`membership`'s own policy is **flat** - its own columns and the GUCs, nothing else - for exactly
the reason `user_property`'s had to be: `app_user`'s policy reads `membership`, so a membership
policy that read `app_user` back would make the planner recurse. Carrying `tenant_id` on the table
is what breaks the cycle, and there is nothing else to resolve it through.

Both fail closed, like every policy since `0002`: unset or pool-reset (`''`) GUCs match nothing.

### Login stays one request; switching is a verb

Login authenticates the identity, mints a session for a **default** membership - owners first, then
oldest - and returns `memberships[]`. No two-step login, because a half-authenticated "now choose a
tenant" state is a new kind of credential to get wrong, and landing in the wrong tenant for a
moment exposes nothing the caller is not entitled to. The switcher is one click away.

The default order lives in one query and is stored nowhere. A `last_tenant_id` column would be a
write on every login to save one click, and the click is the switcher.

`POST /auth/session { tenantId }` re-issues both tokens for another membership **the caller already
holds**. A tenant they do not hold is a `404`, never a `403`: "no" and "there is no such tenant"
must be one answer, or the endpoint enumerates the tenants of Sambung one uuid at a time.

The **refresh token gains `tenantId`**, so a refresh lands back in the membership the session was
in rather than the default one. Optional in the payload, so tokens minted before this migration
keep working - a deploy should not sign everyone out. A `tenantId` that no longer names a
membership falls back to the default rather than failing: losing one seat should not end a session
another seat still justifies.

### Accepting an invite: two shapes, one endpoint

The invite-time refusal narrows from "this address has an account **anywhere**" to "this address is
already on **your** team". Accept then forks on what actually exists:

| the address | `password` means | outcome |
|---|---|---|
| has no account | **set** it (register's rules) | identity + membership created |
| has an account | **prove** you hold it | membership added to that account |

The preview returns `mode: 'create' | 'signin'` so the page knows which to ask for - telling a
returning user to "choose a password" and then refusing the one they choose is precisely the
confusion this removes.

A wrong password there is a `401` and **does not spend the invite**: the token exists in one email
and nowhere else, so a typo must not burn it. The split is the security property: the invite token
proves control of the **mailbox**, the password proves control of the **account**, and attaching a
seat to someone's existing login requires both. Otherwise anyone who could read one email could
attach that account to a tenant of their choosing.

## Consequences

**`DELETE /staff/:id` removes a seat, not a human.** One owner must not be able to delete a login
another owner's team depends on. The account survives with its assignments cascaded off the
membership.

**An account with no memberships gets a `403` at login, not a `401`.** It is reachable only *after*
a correct password, so it is no existence oracle - and answering "invalid credentials" to someone
whose credentials were valid sends them to reset a password that works. The account is inert until
someone invites it again.

**Register still refuses an existing address with `409 email_taken`.** The model now permits one
person to own two tenants, but `register` is unauthenticated: it cannot know the caller is that
account holder, and attaching a workspace to someone else's login on the strength of a typed
address is not a thing to do. "Create another workspace" is an authenticated verb, and it does not
exist yet - deliberately out of scope, since #154 is about *staff* at two owners.

**Revocation is still bounded by the token's life, and ADR-0032's wording needs one correction.**
Removing a membership takes effect on the next query for data - RLS reads `membership` on every
statement, so a stale token naming the lost tenant reads zero rows - but the access token stays
cryptographically valid until it expires (≤15 min). Unchanged, and the same reason the scope was
never put in the token.

ADR-0032 added "and no refresh can mint another", which was true when removing someone deleted
their `app_user` row. It no longer is: an account with a **second** seat refreshes successfully into
that other seat. That is the correct outcome - the other owner never agreed to the removal - but the
sentence is superseded, and the guarantee is now the narrower and more accurate one: **no refresh
can mint a token for a tenant the account no longer holds a membership at.** `POST /auth/session`
answers `404` for it, and an account left with no seats at all cannot refresh into anything.

**`GET /auth/me` 401s on a stale seat while `refresh` falls back, and that is a composition
rather than a disagreement.** `me` must describe the token it was handed - reporting a tenant the
token does not authorise would be a lie the caller's next request disproves. `refresh` is being
asked for a *new* token, so it may mint one for a seat that still exists. Together they are the
intended flow: 401, refresh, retry. Only that order is safe; the reverse (a `me` that quietly
re-pointed itself) would leave the caller acting in one tenant while holding a token for another.

**An account with no seats is claimable by an invite, and that is load-bearing rather than lax.**
Because removal now spares the account, a person removed and later re-invited would otherwise be
asked for a password they may not remember - and Sambung has no password reset, so the owner could
never fix it: `create` mode unreachable, the address globally taken, the invite permanently
unacceptable. So an **inert** account (zero memberships - it cannot even sign in) is claimed by
whoever holds the invite token, exactly as if the row had not been there. It grants nothing the
invite did not already grant. A **live** account is never claimable, and the inert/live question is
re-decided inside the accept transaction under a row lock: if the account gained a seat since the
preview, the transaction rolls back - so the invite is not spent - and the holder is asked for the
password after all.

**"Workspace" enters the vocabulary, narrowly.** `CONTEXT.md` lists it under Tenant's *Avoid*; the
switcher needs a word a villa owner recognises, so the entry is amended rather than contradicted -
Workspace is what a Tenant looks like from inside a session, UI copy only, never the API or schema.
The one exception is the `404` message on `POST /auth/session`, which is a sentence shown to a
person.

**The switcher resets the query cache, it does not invalidate it.** An invalidated query keeps
rendering its stale data while it refetches - one tenant's reservations under another tenant's
name, for as long as the request takes. That is the single failure the control must not have.
