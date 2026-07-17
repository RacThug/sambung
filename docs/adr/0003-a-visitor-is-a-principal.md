# ADR-0003: A Visitor is a principal, scoped by the slug they opened

- **Date**: 2026-07-17
- **Status**: Accepted
- **Issues**: #77 (the decision), #46 (the caller that paid for it)
- **Supersedes**: the `runAsTenant` sketch in #77

## Context

`GET /public/properties/:slug` is the first unauthenticated endpoint in the API.
Every tenant-scoped query in the codebase reaches the database through
`TenantDbService.run`, which reads the tenant from `TenantContext` and **throws
when there is no principal** (ADR of #76). A guest has no token, so nothing mints
a principal, so there is no tenant, so `run` throws. The public funnel had no way
in - deliberately: #74 and #76 made the gap loud rather than letting it fail two
different ways depending on which connection the pool handed you.

And it cannot simply be handed a tenant. The funnel's entry point is a
chicken-and-egg: **the lookup is cross-tenant**. You cannot scope by tenant
before finding the property, because the property is what tells you the tenant.

M2 adds two more of these (`/public/units/:id/availability`, `POST
/public/bookings`), and M3 a third. Whatever we choose here, they inherit.

## Decision

**Resolve, then scope - by minting a principal for the Visitor.**

1. `PublicScope.enterFromSlug(slug)` runs ONE statement on the owner connection:
   `select tenant_id from property where slug = $1`. Unknown slug → 404.
2. It seeds `TenantContext` with `{ kind: 'visitor', tenantId }`.
3. Everything after that line is an ordinary tenant-scoped read: same `run`, same
   RLS, same `WHERE tenant_id`, same repository as an Owner's request.

`Principal` becomes a discriminated union - `UserPrincipal | VisitorPrincipal` -
so `principal.role` does not compile until the Visitor case is handled.

A **Visitor** is now a domain term (CONTEXT.md): someone reading a public page,
who has not booked. They become a **Guest** by booking. That conversion is what
the whole funnel exists to cause, so the two ends of it get different words.

## Why

**Why a principal rather than `runAsTenant(tenantId, fn)`** (which #77 drafted).
That method would put a tenant id back on a parameter list - on the very class
that enforces boss fight #5 - one issue after #76 removed it for being "a second
path for an id the implementation already reached". Any authenticated caller
could then name any tenant, and RLS would obligingly scope to the victim. The
blast radii are not comparable: with `runAsTenant`, a mistake means *any tenant*;
with a resolved Visitor, a mistake is confined to the tenant whose URL the guest
already typed. Minting a principal also means **nothing downstream changes** -
`run` and every repository keep reading the tenant ambiently, exactly as they do
for an Owner. The only new thing is where the mint comes from: a token, or a slug.

> **This argument was incomplete as first written; review caught it.**
> `PublicScope` is globally injectable, so `enterFromSlug(slug)` lets any caller
> name any *slug* - and slugs are public, so that resolves to any tenant. What
> the shape confines is the **value**, not **who may re-mint the principal**. The
> missing half now exists: `TenantContext.set` throws when a principal is already
> minted, so a guarded route cannot silently swap its Owner for a Visitor
> mid-request. `TenantDbService.run` would *not* have caught that - it compares
> principals only *inside* an already-open transaction; outside one it simply
> opens a new transaction under the new tenant. One request, one principal,
> enforced rather than assumed. The claim above holds only because of it.

**Why the union rather than a synthetic userId + role.** A Visitor with a
plausible-looking `role` is a lie the type system would help us tell. The union
makes a Visitor drifting into a role check a compile error rather than a
judgement call at review time. Unrepresentable beats unlikely.

**Why one unscoped statement is acceptable.** It reads a single column, keyed by
a value that exists to be public, and returns nothing renderable. When `property`
grows a payout account or a phone number, this step cannot leak it - it does not
select it. Everything a Visitor actually sees comes back under RLS. And M2's
`POST /public/bookings` inherits the same shape: resolve unit → tenant → insert
under RLS, so the exclusion constraint and the policies are both in force on the
write that matters most.

## Alternatives rejected

- **A public repository on the owner connection** (#77 option 2). Every public
  query guarded by app code alone - what invariant #2 exists to prevent, applied
  to the one surface with no authentication in front of it.
- **A public-read RLS predicate** (#77 option 3). `using (tenant_id = ... OR
  <public>)` applies to *every* query on the app role, including the dashboard's.
  RLS would stop being "even a forgotten WHERE returns nothing" and become "a
  forgotten WHERE returns every publishable property in the system" - it trades
  away exactly the property architecture §3.3 point 4 sells. Scoping the `OR`
  needs `TO <role>`, at which point it is the next option.
- **A dedicated `sambung_public` role** (#77 option 4). The most principled
  answer, and the one to take if this were real multi-tenant SaaS: no unscoped
  statement at all. Rejected for now on moving parts - a third role, grants,
  policies, pool, and env var, plus every future public endpoint having to pick
  the right pool. **This is the upgrade path** if the unscoped surface ever grows
  past resolution-by-key.
- **A `PublicScopeGuard`**, for symmetry with `JwtAuthGuard`. But "which tenant
  owns this slug" is a lookup and "unknown slug" is a 404 - a domain answer, not
  "you may not proceed". It would need route-param configuration, and M2's `POST
  /public/bookings` carries its unit id in a body nothing has validated at guard
  time. Revisit when three real callers exist to learn the shape from - the same
  reasoning #77 applied to `runAsTenant`.

## Consequences

- `PublicScope` is the **only** class permitted to query across tenants for an
  unauthenticated request. Keep its surface tiny; it is what a reviewer greps for.
- **One request mints one principal.** `TenantContext.set` throws on a second
  mint, which is what stops `enterFromSlug` from being a re-scoping backdoor on a
  guarded route. Anything that wants to act for two tenants wants two requests.
- Public endpoints must call `enterFromSlug` (or its M2 siblings) before touching
  anything tenant-scoped. Forgetting fails loudly - `run` throws, 500 - rather
  than silently returning zero rows.
- Two connections per public request (owner for the resolve, app role for the
  read). Acceptable at this scale; revisit if the funnel gets hot.
- Work that genuinely crosses tenants - the M2 hold sweeper - still belongs on
  `DbService`, not here. This is not a general-purpose backdoor.
