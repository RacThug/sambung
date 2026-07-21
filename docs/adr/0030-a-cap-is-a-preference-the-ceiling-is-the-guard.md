# ADR-0030: A cap is a preference, the ceiling is the guard

- **Date**: 2026-07-21
- **Status**: Accepted
- **Issue**: #67 (deferred from #39)
- **Builds on**: ADR-0002 (deleting inventory never destroys the ledger - the same "a setting must not silently destroy data" instinct, one domain over), ADR-0017 (the orphaned-photo sweep, which is what actually bounds bytes)

## Context

#39 shipped one hard number for everyone: `MAX_PHOTOS_PER_PROPERTY = 30` in `packages/shared`, enforced by the shared zod schema on `PATCH /properties/:id/photos`. It was justified in that issue as an **abuse guard** - "an unbounded client-controlled array is a resource vector" - and making it tenant-tunable was deferred with a caution: if tenants can raise their own cap, it guards nothing.

That caution rests on a premise worth checking before building on it, and the premise is wrong.

The constant never bounded storage. Property count is unbounded, so a tenant could always park a thousand galleries of thirty - 150 GB - without touching the cap. What 30 actually bounds is **one request body** and **one gallery grid**. The guards that bound bytes are `MAX_PHOTO_SIZE_BYTES` (5 MB, signed into the presigned PUT) and the orphan sweeper (ADR-0017), neither of which a tenant can move.

So the question this ADR answers is not "may a tenant weaken a security control?" It is "where does a per-request sanity bound belong, once one number no longer fits every villa?"

## Decision

**The cap is the tenant's preference; the ceiling is the system's guard; and the cap is enforced where a gallery grows, not where it is stored.**

Four parts.

**1. `tenant.gallery_cap smallint not null default 30`** (migration `0014`), `CHECK between 1 and 100`. A column on `tenant`, not a settings table and not jsonb: one knob does not earn a table, a column inherits the row's existing `tenant_isolation` RLS policy for free (no policy migration), and a `CHECK` mirroring a zod bound is the house grain already set by `property.deposit_pct` and `property.time_zone`.

**2. `MAX_PHOTOS_PER_PROPERTY` becomes `PHOTO_GALLERY_CEILING = 100`**, joined by `DEFAULT_GALLERY_CAP = 30`. The rename is the point: the constant stops being *the cap* and becomes *the highest a cap may be*. Leaving the old name would put a lie in the one file both sides import. The shared schema bounds the array by the **ceiling**, because a static schema cannot know which tenant is asking; the **cap** is enforced in the service, which can.

**3. The rule is "never grow past the cap", not "never exceed it".** The photo write is a whole-set `PATCH` - the array *is* the gallery - so `keys.length > cap` alone would trap an over-cap gallery: lower the cap to 30 with 40 photos live, and every subsequent edit, including deleting one, arrives as more than 30 keys and is refused. The check compares against the gallery it is growing *from*:

```ts
if (dto.keys.length > cap && dto.keys.length > existing.photos.length) throw …
```

Reorders (equal length) and every shrink pass unconditionally. Lowering the cap therefore blocks **growth** and nothing else.

The check is on **count**, deliberately, and that has a consequence worth naming rather than discovering: over the cap, a same-length **swap** (drop one key, add one) passes. The owner of a 40-photo gallery under a cap of 30 can still replace a bad cover photo; what they cannot do is reach 41. Refusing swaps would freeze an over-cap gallery rather than merely close it to growth - the same trap in a smaller room - and would buy nothing, since count is what the cap bounds and bytes are the sweeper's job (ADR-0017). The SPA never offers it (it disables "Add photos" at `length >= cap`), so this is an API-level nuance, pinned by a test so it stays a decision.

**4. `GET /settings` (any signed-in user) and `PATCH /settings` (`@Roles('owner')`).** The read is open because the property workbench needs the cap to know when a gallery is full; only the write is the owner's.

## Why

**Why not just raise the constant?** That is the right answer right up to the first villa that wants 60 photos and the next that wants 12 - and it makes the number a deploy rather than a decision. A tenant-chosen number under a fixed ceiling costs one column and gives the answer to both.

**Why not a per-property cap?** `deposit_pct` and `time_zone` are genuine per-property facts: a villa in Papua really is on a different clock. "How many photos may a gallery hold" is not - no owner sets it differently per villa. Putting it on `property` would have avoided building a settings surface, which is a reason to build the wrong thing.

**Why a 403 for staff rather than the 404-over-403 convention?** Hiding a resource defends against an **existence oracle** - the reason a cross-tenant read 404s. There is nothing to hide here: staff know their own tenant has settings. "You lack the role" is the honest, actionable answer.

**Why a 400 and not an ADR-0012 conflict code?** ADR-0012's closed set is for **state** conflicts - the room is taken, the booking is not cancellable. Exceeding a declared limit is the same category as `size > MAX_PHOTO_SIZE_BYTES`: a request that was never going to be accepted, not a race with the world. The sibling photo failures on this very endpoint are already 400s, and adding a conflict code would split one endpoint's refusals across two conventions - the drift ADR-0012 exists to prevent.

**Why build `@Roles` here at all?** `app_user.role` has existed since M0 and the token has always carried it, but nothing read it: registration mints an `owner` and no path creates a `staff` user, so every caller has been an owner in practice. #57 (staff invites + property-scoped RBAC) is where that stops being true. Writing this AC's gate as a one-off `if` would guarantee a second authorization path for #57 to reconcile; writing it as one decorator and one guard, applied to one route, gives #57 a seam to extend. Property-scoped permissions are deliberately **not** modelled here - answering half of #57 early is exactly how the two paths would diverge.

**Why does the guard read `TenantContext` and not `req.user`?** Per #76, one module owns the tenant principal. A guard is precisely where two sources of "who is asking" would get to disagree. `Principal` is a union, so the Visitor case must be handled explicitly - and it is refused, never read as "role undefined, therefore allowed".

## Consequences

- Raising the ceiling above 100 is a migration, on purpose - like `property_time_zone_known`. It is a product decision about how much of a free-tier bucket one property may fill, not a config tweak.
- A gallery can legitimately sit above its tenant's cap. The property workbench must therefore keep every non-growing action enabled at all times; it says "Gallery is full (N photos)" and links to Settings rather than disabling the grid.
- The SPA now fetches `/settings` on the property workbench. Until it resolves, "Add photos" is disabled: a beat of latency beats guessing a number that could block a legal upload or invite a 400.
- Nothing about existing tenants changes. The column defaults to 30, which is exactly what the constant was.
