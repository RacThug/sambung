# ADR-0033: An invite is a hashed, single-use grant

- **Date**: 2026-07-22
- **Status**: Accepted
- **Issue**: #57 (FR-AUTH-2, api-spec §3.6)
- **Builds on**: ADR-0012 (a 409 carries a code, not a sentence), ADR-0015 (`booking_not_payable` - the shape this refusal copies), ADR-0021 (the `Mailer` port), ADR-0032 (the scope an accepted invite grants)
- **Migration**: `0015_staff_invites_rbac.sql`

## Context

An owner invites a staff member by email; the invitee sets a password through a link and lands in a session scoped to the Properties the invite named. Nobody signs in to accept - they have no account yet, which is the whole point - so the token in the link **is** the credential, and every design question follows from that.

## Decision

**An invite is a row that stores a hash, grants a set of Properties through a join table, and is spent exactly once by a guarded UPDATE.**

### The token

32 bytes of CSPRNG output, base64url. Stored as **SHA-256**, deliberately not bcrypt: bcrypt exists to make *low-entropy* secrets expensive to guess, and there is nothing to slow down about 256 bits. What hashing buys is the other property - a database dump is a list of hashes, not a list of working invite links - and it buys it without making the accept path pay ~300 ms on a value looked up by equality.

The raw token appears in exactly one place: the email. The API never returns it, and `GET /auth/invites` deliberately omits it. Losing the email means revoking and re-inviting. That is a real, small usability cost, taken because **a token an API will hand back is a token every future bug can hand back**.

### The grant is a join table, not a `uuid[]`

`staff_invite_property` carries a composite FK to `property (id, tenant_id)`, so an invite granting another tenant's Property is unrepresentable - the same guarantee `user_property` gets, one step earlier in the lifecycle, where nobody is watching. It also means a Property deleted between invite and accept simply cascades out of the grant instead of exploding at accept time.

### Single-use is a guarded UPDATE, and it goes FIRST

Inside the accept transaction:

```sql
UPDATE staff_invite SET accepted_at = now()
 WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
```

...then create the user, then copy the grants. The order is the concurrency control: two simultaneous accepts contend on that row, the winner proceeds and the loser matches zero rows before it can create a second account. Checking first and updating last would be the read-then-write window boss fight #1 exists to teach. `expires_at > now()` is evaluated by the **database**, so one clock decides liveness and it is the clock that stamped the row.

bcrypt runs *before* the transaction opens. Holding a row lock across 300 ms of CPU is how a hot path becomes a queue, and it buys nothing: the UPDATE, not the read that preceded it, is what arbitrates.

### Refusals: 404 for unknown, 409 with a reason for spent

An **unknown** token is `404`. A **known but dead** one is `409 invite_not_acceptable { reason: expired | accepted | revoked }` - the exact shape of `booking_not_payable { status }` (ADR-0015). The split is the security property: only someone already holding a real invite is told why it will not work, so a guessed token confirms nothing. The three reasons are separate because each has a different next step - sign in instead, ask for a new link, talk to the owner - and the web composes that copy from the slug (ADR-0012).

A duplicate live invite is `409 invite_already_pending`, arbitrated by the `staff_invite_live_email_uniq` **partial** unique index (partial because accepted and revoked invites are history and must be allowed to pile up). The app pre-checks for the friendly answer and the index backstops the race, both throwing the same factory, so the loser cannot tell which layer refused (api-spec §5.3).

### Accept runs on the owner connection

Like register and login, and for the same reason rather than as a shortcut: there is no principal to scope by, and the row being created is the very thing that *would* grant the scope. What makes that safe is the ADR-0016 property - every statement is keyed by a 256-bit unguessable value or by an id already resolved from one. No caller-supplied tenant, no listing, no query wider than one invite.

### A failed email undoes the invite

Unlike the booking confirmation (best-effort - the booking is already real), the email **is** the delivery mechanism here: the invite is useless without it and the token is recoverable from nowhere else. So a send failure rolls the invite back and answers `503`. That is not tidiness - `staff_invite_live_email_uniq` would otherwise leave a pending-but-unreachable invite blocking every retry for that address, with nothing on screen to explain why.

## Consequences

**One email address, one account, across all of Sambung.** `app_user.email` is globally unique because login is `email + password` with no tenant in the request - two rows sharing an address would make "which account is this?" unanswerable. So the same person cannot be staff at two Tenants with one address; they get `409 email_taken` at accept, from the same constraint registration uses. Per-tenant emails would mean a tenant selector at login, which is a product change, not a schema tweak.

**Re-assignment is a whole-set write** (`PATCH /staff/:id { propertyIds }`), like the Gallery (ADR-0030): the array *is* the assignment set, so removing access is sending a shorter list rather than inventing an "unassign" verb. The minimum is 1 - an account that can see nothing is access that only looks like access, and `DELETE /staff/:id` is the verb for that.

**`DELETE /staff/:id` carries `role = 'staff'` in its WHERE.** That is what stops one owner deleting another through a staff route, and it means an owner's id arrives as a 404 (there is no staff member by that id) rather than a 403 that would confirm one exists. Removing *yourself* is a 403 with a reason, because you plainly exist and a 404 would be a lie you could disprove by reloading.

**The invite page is English only.** ADR-0024 gives three languages to the guest funnel, where a stranger decides to pay. This is an operator account page reached from an English email - offering a language picker there would be a promise the rest of that journey does not keep.
