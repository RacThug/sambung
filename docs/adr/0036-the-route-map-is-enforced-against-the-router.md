# ADR-0036: The route map is enforced against the router, not maintained by discipline

- **Date**: 2026-07-23
- **Status**: Accepted
- **Issue**: [#158](https://github.com/RacThug/sambung/issues/158)
- **Related**: [ADR-0035](0035-the-edge-is-verified-by-running-it.md) and
  [ADR-0029](0029-a-cutover-is-verified-by-a-probe.md) (the same "committed and reviewed is
  not the same as verified" spine), [#152](https://github.com/RacThug/sambung/issues/152)
  (the Nest route-enumeration reflection this reuses)

## Context

The surface has grown to ~15 SPA pages and ~55 API endpoints across M0-M5. `page-spec.md §1`
carried a hand-drawn "site map" of it - and by the time anyone needed it, that map had
**drifted from the real router in three places**: `/` was documented as a redirect to `/login`
but is the M0 scaffold health page; `/app/channels` was listed as a real page but does not
exist (channel health moved onto the Property workbench, the conflict inbox became
`/app/inbox`); and `/app/inbox` itself was absent. `api-spec.md §2`'s numbered index had
drifted the same way, missing M5 routes.

The telling part: `page-spec.md §5` already wrote the promise -*"if a future endpoint lands
without a row here... one of the two specs is lying - fix in the same PR"*- and it was
violated anyway. **An unenforced discipline is the exact mechanism that produced the drift.**
So the deliverable could not be another hand-maintained map; that is the thing that just failed.

## Decision

**A single code-verified index, `docs/sitemap.md`, checked against the router by a test.**

1. **Guard, not discipline.** Two tests enumerate the *real* routes and fail if the doc omits
   or invents one, with the exact diff:
   - **FE** (`apps/web/src/sitemap.guard.test.ts`, vitest): `router.routesById`.
   - **API** (`apps/api/src/sitemap.guard.spec.ts`, jest): Nest's `DiscoveryService` over
     every controller - the same `PATH_METADATA`/`METHOD_METADATA` reflection `no-body.spec.ts`
     (#152) walks, extended from mutating routes to all HTTP verbs.

   The doc lists routes in each table's first column between machine markers
   (`<!-- fe-routes:… -->`, `<!-- api-routes:… -->`); the guard parses those and compares sets.
2. **Enumerate from the framework's own registration - no allowlist.** The route tree and the
   Nest module graph *are* the single source; the guard reads them, never a curated list of
   controllers or paths (that list would be a second thing to forget - the drift in a new
   costume). The one deliberate exclusion is TanStack's synthetic `__root__` layout node, which
   is not a navigable URL.
3. **Guard the machine-checkable half; hand-write the prose.** "What routes exist" is 100%
   enforceable; "what each is *for*" is a human sentence. So the guard covers existence and the
   purpose column stays prose - rather than a full generator, which would be a heavier hybrid
   (it still can't write the purpose) and would couple a generated file to Nest's decorator
   internals in *production* tooling.
4. **An index that links, never copies.** `sitemap.md` points into `page-spec.md`/`api-spec.md`
   for per-page and per-endpoint detail (single source of truth per fact, `docs/README.md`).
   `page-spec §1`'s stale map becomes a pointer, `§4.6` is corrected, and `api-spec §2` gains a
   note naming `sitemap.md` as authoritative on *what exists*.
5. **Each layer in its own vocabulary.** FE routes are compared as `$param` (TanStack), API
   routes as `:param` (Nest), without the `/api` global prefix (which lives on the adapter, not
   the metadata) - so each guard compares like with like.

## Consequences

- The map cannot silently go stale. Add a route and forget the row - or delete a route and
  leave the row - and `pnpm test` (which the pre-push hook and the web build already invoke)
  goes red with the precise `{ missing, invented }` diff.
- Building it against the code **surfaced the drift on arrival**: `/app/channels` (documented,
  non-existent), `/` (mis-documented), `/app/inbox` (undocumented), and two endpoints with no
  FE consumer - `POST /channels/:id/sync` ("Sync now" unbuilt) and `GET /auth/me` (the SPA
  restores via `refresh`). The traceability table names them rather than letting them look wired.
- The API guard boots the Nest app (so it needs Postgres, like the rest of the api suite). That
  is the price of an allowlist-free walk: seeing *every* controller means asking the module
  graph, which means instantiating it.
- Proven **red first**: breaking one FE row and one API row made each guard report exactly the
  offending route before the doc was restored.

## Alternatives considered

- **Full code-generation of the table.** Rejected: the purpose column is prose a generator
  can't write, so it would be a hybrid that still needs hand-editing, *and* it would parse Nest
  decorators in shipped tooling - the brittle coupling #152 deliberately confined to a test.
- **Upgrade `page-spec §1` in place, no new file.** Rejected: the API routes and the FE↔API
  traceability have no natural home in a doc whose theme is *pages*, and a reader looking for
  "the sitemap" would not find it buried mid-spec. A dedicated front door reads better and the
  README links it.
- **Keep it a discipline** (the `§5` "fix it in the same PR" note). Rejected on the evidence:
  that promise existed and drifted anyway.
- **Reflect over an allowlist of controller classes** instead of `DiscoveryService`. Rejected:
  a new controller left off the list is a false green - the very drift this ADR removes.
