# ADR-0032: A staff scope is a second axis in RLS

- **Date**: 2026-07-22
- **Status**: Accepted
- **Issue**: #57 (boss fight #5 adjacent), closing the `user_property` follow-up deferred by #40
- **Builds on**: ADR-0003 (a Visitor is a principal - the union this reads), ADR-0026 (a statement is guarded where it is issued - the same instinct one layer down), the #74 fail-closed lesson
- **Migration**: `0015_staff_invites_rbac.sql`

## Context

FR-AUTH-2 asks for a staff member who sees **only** the Properties they are assigned - "in every list AND by direct id". By M5 that sentence covers roughly thirty authenticated routes reading six tables: `property`, `unit`, `booking`, `channel_connection`, `sync_conflict`, `payment`. The calendar, the reservations list, the CSV export, the booking detail, the channels panel, the sync-conflict inbox, the payments inbox, every by-id getter.

Three ways to enforce it:

**A. A `WHERE property_id IN (assigned)` in every repository.** Thirty routes, and one forgotten `WHERE` is a silent cross-property read. This is precisely the failure class invariant #2 and the RLS layer exist to make unrepresentable; choosing it here would be arguing that the tenant axis needed a database backstop but the property axis does not.

**B. A guard that resolves `:id` → property → checks assignment.** Covers by-id routes, does nothing for lists, so lists still need A. Two authorities for one rule, which is the drift ADR-0012 was written to stop.

**C. A second axis inside the policies that already run.**

## Decision

**The property scope is a second axis in row-level security, established in the same place and from the same principal as the tenant axis.**

`TenantDbService.run` already opens every tenant-scoped transaction and sets `app.tenant_id` from `TenantContext` - the single owner of the principal (#76). It now sets two more GUCs on the same statement, and the policies gain one term. Nothing else changes: no repository, service or controller filters by assigned property, and the specified "404 for unassigned" falls out of the `0 rows → NotFoundException` every getter already had.

### Two GUCs, not one

```
app.property_scope   'all' | 'assigned'
app.staff_user_id    the staff uuid, only when scope = 'assigned'
```

The tempting design is one GUC holding either `'all'` or the uuid, read as `guc = 'all' OR EXISTS (… = guc::uuid)`. **Postgres does not guarantee the evaluation order of `OR`**, so the planner is free to evaluate `'all'::uuid` and raise `22P02`. That is the exact trap #74 fixed on the tenant axis, in a new costume. Two GUCs - one text, one uuid - have no cast that can run on the wrong value.

### Fail-closed, on both axes

With both scope GUCs unset (or reset to `''` by a pooled connection - see migration `0002`), `property_scope` is not `'all'` and `staff_user_id` is NULL, so the `EXISTS` matches nothing and every row is filtered. **Zero rows, not everything.** A scope has to be *granted*; it is never merely *un-restricted*. Setting all three GUCs on every transaction - not just when a staff member asks - is what keeps a warm pooled connection from inheriting the previous principal's scope.

### One authority for the predicate

The rule lives in a single `stable` SQL function, `app_property_visible(uuid)`, rather than being copied into eight policies. `SECURITY INVOKER` by default and deliberately so: the lookup runs with the caller's rights, so `user_property`'s own policy applies to it, which is what confines a staff member to reading their own grants.

### `user_property` gains `tenant_id`, and that is load-bearing twice

It carries the composite FKs that make a cross-tenant assignment unrepresentable (#40's deferred follow-up, and AC #4). It also lets `user_property`'s own policy be a flat `tenant_id = <guc>` - which it **must** be, because `property`'s new policy reads `user_property`. Had `user_property`'s policy kept resolving its tenant *through* `property`, the two would reference each other and the planner would recurse. Denormalizing breaks the cycle.

### Two axes, two status codes

They answer different questions and must not be conflated:

| question | mechanism | answer |
|---|---|---|
| may this user see this Property? | RLS | **404** - within a tenant, an unassigned property is simply not there |
| may this role use this verb? | `@Roles('owner')` + `RolesGuard` (#67) | **403** - naming the role |

403 is not a breach of the 404-over-403 convention: that convention hides *existence* from another tenant, and a staff member already knows their own tenant has settings and a team. "You lack the role" is the honest, actionable answer (api-spec §1). The role guard runs **before** any lookup, so `POST /properties/:id/archive` returns 403 for every id a staff member names - assigned, unassigned, foreign or invented - and cannot be used as an existence oracle.

The verb line is a principle, not a list: **the owner decides the shape of the tenant, staff operate the properties they are assigned.** Create, delete, archive and unarchive a Property, tenant settings, and the team are the owner's; everything else - details, photos, units, channels, bookings, conflicts - is what being assigned a Property lets you do. `POST /properties` settles the rest by itself: a staff member who created a Property would have no `user_property` row for it, so it would vanish the instant it existed.

## Consequences

**`payment` and `payment_event` are deliberately untouched.** Neither has a `tenant_id`; both already resolve one through a subquery over `booking`, and a policy expression runs with the querying user's rights - so `booking`'s newly-tightened policy applies *inside* that subquery and the property term reaches payment rows without being restated. Restating it would be a second copy of the rule. Because "it follows from a rewriter subtlety" is not something to take on faith for a money table, the inheritance is **pinned by a test** (`rls.test.ts`) rather than by a comment.

**A Visitor gets `'all'`.** The property axis narrows a *user* below their Tenant; a Visitor is already confined to the single Tenant whose slug they opened (ADR-0003) and has no grants to be narrowed by, so `'assigned'` would silently blank the public funnel.

**The owner connection is out of scope.** `DbService` - the sweepers, the payment webhook, the iCal import - bypasses RLS entirely and has no principal. Those are system reconciliations (ADR-0009/0018/0025); there is no user whose sight to narrow.

**Cost: a function call per row.** `app_property_visible` is `stable`, and for an owner it short-circuits on a GUC comparison before touching a table. At this scale (a tenant has tens of properties, not millions) that is not measurable. The probe is the `user_property` primary key, so the lookup is an index-only scan.

**Revoking access is immediate for data, not for the token.** Removing an assignment takes effect on the next query, because RLS reads the table on every statement rather than trusting anything baked into the JWT. Removing the *user* leaves their access token cryptographically valid until it expires (≤15 min), but every scoped read then returns nothing and no refresh can mint another - the honest limit of a stateless token, and the reason the scope was never put in the token in the first place.
