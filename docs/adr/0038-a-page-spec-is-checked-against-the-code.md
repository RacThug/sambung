# ADR-0038: A page spec is checked against the code; its judgements are not

- **Date**: 2026-08-01
- **Status**: Accepted
- **Companion**: [`scripts/docs-doctor.mjs`](../../scripts/docs-doctor.mjs) ·
  [`docs/pages/_template.md`](../pages/_template.md) ·
  [`docs/pages/_schema-allowlist.md`](../pages/_schema-allowlist.md)
- **Builds on**: [ADR-0036](0036-the-route-map-is-enforced-against-the-router.md)

## Context

`docs/pages/` now holds thirteen per-page specs migrated out of `page-spec.md`. Between them they name
**248 data rows**, each citing a schema export, an endpoint, and where a value is computed. That is a
large surface of claims about code, and every one of them can rot: a schema gets renamed, a route param
changes from `:id` to `:propertyId`, an endpoint is deleted, a page is built and the spec is not
updated.

ADR-0036 recorded the same problem one layer up and its answer: the old site map in `page-spec.md §1`
drifted *precisely because nothing enforced it*, so the replacement is enforced against
`router.routesById` and Nest's `DiscoveryService` by tests. `page-spec.md §5` had even promised "if a
future endpoint lands without a row here, one of the two specs is lying - fix in the same PR", and that
promise was broken nine times over before anyone noticed.

Page specs are that promise again, with more surface. Writing them down without a guard would repeat the
mistake at three times the size, and the migration report already shows the failure mode arriving: five
places where `page-spec.md` and the code disagreed, none of which anything had flagged.

## Decision

**`pnpm docs:doctor` checks every page spec against the code, and the pre-push hook runs it.** Six
checks, each failing with the `file:line` of the offending table row, grouped by page.

1. **Every Schema-column value resolves to a real export.** Unknown name → failure.
2. **Every frontmatter `route` is a route the router serves.**
3. **Every Endpoint-column value is an endpoint a controller serves.**
4. **Page specs and the sitemap agree in both directions** - no route without a spec, no spec without a
   route.
5. **Every `*Schema` export of `packages/shared` is cited by a page spec**, or listed in
   `_schema-allowlist.md` with a reason.
6. **`Source: [TBD]` is allowed only while `status: draft`.** Agreeing a spec means the unknowns became
   questions, not rows.

Four decisions inside that shape it:

**Checks 2 and 3 read `docs/sitemap.md`, they do not re-derive routes.** The two marker-delimited tables
there are already pinned to the real router and the real controllers by the ADR-0036 guards. Deriving
routes a third time would create a third copy of the route list - the exact drift ADR-0036 exists to
kill - and would need a bundler for the TSX route tree plus a booted Nest app, inside a script that has
to run in a git hook. So the mechanism is **reused**, and the dependency is stated in the script: these
two checks are only as strong as the guards in `pnpm test`.

**The Schema column resolves against two namespaces**, `packages/shared` and the SPA's
`*-search.ts` route-search schemas. URL state is validated by a real zod schema that simply is not on
the wire, because it is the page's contract with the URL bar rather than with the API. A name in neither
namespace still fails, so "fail on unknown export names" holds; only the definition of *known* is one
namespace wider than `packages/shared` alone.

**Check 5 is scoped to `*Schema` exports.** Every schema has a `z.infer` type twin that is also an
export, and requiring both would raise 58 failures for a naming convention rather than a gap
(`MIGRATION-REPORT.md` §6a). The limit is real: a non-`*Schema` export like `buildPropertyOgTags` is not
covered by this check.

**The allowlist is a ledger, not a suppression list.** Each entry carries a reason, an entry with no
reason fails, and an entry that a page spec later covers fails as **stale**. It cannot quietly outlive
what it was written for, and three of its fourteen entries are recorded as known gaps rather than as
"fine".

## Why

**A guard belongs where the claim is machine-checkable, and nowhere else.** The `Schema` column exists in
the template precisely because an export name is checked by `tsc` while prose describing "the property's
name" is not. Having gone to the trouble of making the claim checkable, not checking it would be the
whole point missed.

**It found six defects on its first run**, before it was trusted: a Schema cell that had absorbed the
words "seeded from", and five endpoint cells naming `/properties/:id/units` when the route is
`/properties/:propertyId/units`. Both are the class of error a careful reader misses and a string
comparison cannot.

**Zero dependencies, plain Node ESM at the repo root**, matching `apps/web/scripts/check-bundle.mjs`
rather than the `apps/api/scripts/*.ts` doctors. Those need the api workspace's env and `tsx`; this
reads four plain-text trees and must run in a hook from the repo root. `.mts` was the issue's
suggestion and was declined for one reason: the root has no TypeScript runner, and adding `tsx` to run
one probe is a dependency bought for nothing.

**It goes in the pre-push hook, and there is no CI to add it to.** GitHub Actions is disabled by
decision (invariant #8; the hook's own comment calls itself "our free replacement for cloud CI"), so
the hook **is** the gate. Writing a `.github/workflows/*.yml` that nothing executes would be committed
config that is never run - the exact category ADR-0035 was written about, and a worse outcome than
having none, because it would read as coverage. If Actions is ever enabled, the line is
`pnpm docs:doctor`.

## Consequences

**What this guarantees.** Every schema name, route and endpoint in a page spec exists. No route hides
without a spec and no spec describes a route that does not exist. No shared schema silently loses its
last documented consumer. A spec that has been agreed carries no undecided rows.

**What this does NOT guarantee, and cannot.**

- **It cannot tell you a business rule belongs in the backend.** `leak: true` marks a rule computed in
  the browser; whether that rule *should* live there is a design judgement about where truth belongs,
  and no string comparison reaches it. The 30 leaks in `MIGRATION-REPORT.md` §3 are an inventory for a
  human, not a queue for a script. The probe prints this in its own failure output, so nobody reads a
  green run as more than it is.
- **It cannot check `Computed in`.** Whether a value is `BE`, `FE` or `raw` is a fact about two
  codebases that the probe does not read.
- **It cannot check `Source` provenance.** `[code]` asserts someone re-read the tree; the probe checks
  only that the tag is one of the three, and that `[TBD]` has not outlived `draft`.
- **It cannot check `verified: true`.** That field is a human's claim about a commit, and it is exactly
  the kind of claim that decays silently. It is a promise, not a measurement.
- **It cannot check that a spec DESCRIBES its page.** Every name can exist and every row can still be
  wrong about what the page does. The five spec-vs-code disagreements the migration found were caught by
  reading, not by parsing, and the next five will be too.
- **Checks 2 and 3 inherit the sitemap guards' strength.** Skip `pnpm test` and `sitemap.md` is a
  hand-written list again.

**Self-verified red first.** Six seeded faults, one per check, each caught with a non-zero exit and the
right `file:line`, before the green run was believed. The route check usefully produced *two* findings
from one fault - the renamed route is unknown to the router, and the route it abandoned is now an
orphan - which is the bidirectional behaviour check 4 is for.

**Cost.** A page spec is now something that can fail a push. That is the intent: the alternative is a
directory of confident, decaying documents, which is what `page-spec.md §1` became.
