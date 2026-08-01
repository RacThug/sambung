# Sambung - Per-page specs

One file per page, written **before** the page is built. A page spec is the design conversation held on
paper, where changing your mind costs a paragraph instead of a rewrite: it names the fields, the
endpoints, the states and the rules while all of those are still cheap to move.

This is the forward-looking half of the UX contract. The backward-looking half is
[`../page-spec.md`](../page-spec.md), which documents pages that already shipped and is now
`status: legacy` - **new work starts here**.

| Doc | Read it before… | Covers |
|-----|-----------------|--------|
| [`_template.md`](./_template.md) | …starting any new page spec | The format every page spec follows: frontmatter (`route`, `status`, `prd_section`, `adrs`, `verified`), purpose, entry/exit, the seven-column data-requirements table, requests, state deltas, interactions, business rules with the `leak` marker, schema implications, out of scope, open questions |
| [`_list-pattern.md`](./_list-pattern.md) | …specifying or building any dashboard list page | The behaviour every `/app/*` list already shares - loading, empty, error, 403/404, partial failure, pagination, filters + URL state, mutation feedback, skeletons - so a page spec writes only what **differs**. Ends with twelve divergences still awaiting a decision |

Migrated from `page-spec.md` at commit 6702881 - see
[`MIGRATION-REPORT.md`](./MIGRATION-REPORT.md) for what the migration found.

| Page | Route | Status | Verified | Spec |
|------|-------|--------|----------|------|
| Property page | `/p/$slug` | shipped | yes | [`p-slug.md`](./p-slug.md) |
| Checkout | `/p/$slug/book` | shipped | yes | [`p-slug-book.md`](./p-slug-book.md) |
| Confirmation | `/booking/$bookingId` | shipped | yes | [`booking-bookingId.md`](./booking-bookingId.md) |
| Sign in | `/login` | shipped | yes | [`login.md`](./login.md) |
| Sign up | `/register` | shipped | yes | [`register.md`](./register.md) |
| Accept an invite | `/invite/$token` | shipped | yes | [`invite-token.md`](./invite-token.md) |
| Unified calendar | `/app/calendar` | shipped | yes | [`app-calendar.md`](./app-calendar.md) |
| Reservations | `/app/reservations` | shipped | yes | [`app-reservations.md`](./app-reservations.md) |
| Booking detail | `/app/bookings/$bookingId` | shipped | yes | [`app-bookings-bookingId.md`](./app-bookings-bookingId.md) |
| Properties | `/app/properties` | shipped | yes | [`app-properties.md`](./app-properties.md) |
| Property workbench | `/app/properties/$propertyId` | shipped | yes | [`app-properties-propertyId.md`](./app-properties-propertyId.md) |
| Operations inbox | `/app/inbox` | shipped | yes | [`app-inbox.md`](./app-inbox.md) |
| Settings | `/app/settings` | shipped | yes | [`app-settings.md`](./app-settings.md) |

**Two routes have no spec**, because `page-spec.md` had nothing to migrate for them: `/` (page-spec §6
declares a landing page out of scope; one shipped anyway) and `/app`, the dashboard shell (page-spec §2
treats it as cross-cutting behaviour rather than a page). The shell's absence has a measurable cost -
`MIGRATION-REPORT.md` §6c.

## The three things this format is built around

1. **`Schema` is the machine-checkable key.** The data-requirements table cites the **export name** from
   `packages/shared`, not a prose description, because an export name is checked by `tsc` and prose is
   not. That single column is what makes a spec able to go stale *loudly*.
2. **`Source` records provenance.** Every row says whether it is `[spec]` (inherited from
   `page-spec.md`), `[code]` (read from the tree), or `[TBD]` (undecided). The audit that produced
   `_list-pattern.md` found the three disagree more often than expected; a table that mixes them without
   saying which is a document you cannot act on.
3. **`leak: true` counts the business rules living in the browser.** Not a prohibition - the codebase
   ships several deliberately, and `_list-pattern.md` §5.4 explains one of them - but an FE-computed
   domain rule exists in two places that can disagree, and the client's copy is the one no constraint
   backstops. Marking them makes the count visible before someone adds the fourth copy by accident.

## Conventions

- **File names mirror the route**, with `/` → `-` and no leading slash: `/app/reservations` →
  `app-reservations.md`, `/p/$slug` → `p-slug.md`. Files starting with `_` are shared documents, not
  pages, and sort to the top for that reason.
- **Frontmatter is the index.** `route`, `status`, `prd_section`, `adrs` and `verified` live at the top
  of every spec, so the table above can be read off the files rather than maintained beside them.
- **Cross-reference by section, never copy.** A page spec cites `_list-pattern.md` §3.5, `api-spec.md`
  §5.5, or `design-system.md` §4; it does not restate them. One source of truth per fact is the rule the
  whole `docs/` tree runs on ([`../README.md`](../README.md)).
- **Teaching-edition voice**, like [`../db-design.md`](../db-design.md) and
  [`../architecture.md`](../architecture.md): state the decision, then the *why*. The why is what tells
  the next reader when the decision stops applying.

## How a spec is used

1. **Write it** from [`_template.md`](./_template.md) at `status: draft`, `verified: false`, before any
   code.
2. **Agree it** with the owner. The data-requirements and business-rules tables are where disagreements
   surface, because both force one answer to "who computes this".
3. **Build against it** (`status: in-build`). Anything the build proves wrong is fixed *in the spec*, in
   the same PR - a spec that drifts is worse than none, which is the lesson
   [ADR-0036](../adr/0036-the-route-map-is-enforced-against-the-router.md) records about the old site
   map.
4. **Mark it `shipped`**, set `verified: true` only after re-reading every `[code]` row against the
   merged tree, and add the route to [`../sitemap.md`](../sitemap.md) - where a test fails if you forget.
