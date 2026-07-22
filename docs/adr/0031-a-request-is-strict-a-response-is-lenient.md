# A request is strict; a response is lenient

Every inbound request schema in `packages/shared` - the shape of a **body or a query param** - rejects unknown keys (`.strict()`, via one `strictObject` helper); response schemas keep plain `z.object` and tolerate them. Surfaced by the #67 / PR #149 review, decided once for the whole package rather than per-endpoint (#150).

## Context

No request schema was strict, so zod's default stripped unknown keys. A partial `PATCH` schema cannot tell a **misspelled** field from an **omitted** one, so `PATCH /settings {galleryCapp: 60}` returned **200 having changed nothing** - success and typo were indistinguishable. The same silent-success bug lives on query params: `?form=` instead of `?from=` falls back to a default and looks fine. This is the exact failure "validate all external input at the boundary" (CLAUDE.md) exists to prevent.

## Decision

- **Inbound is strict.** Bodies *and* query params reject unknown keys, so a typo is a `400` naming it. Applied uniformly through a single `strictObject(shape) = z.object(shape).strict()` helper, used at every request-schema construction site, so a new request schema reaches for it and is strict by construction. An enumeration test (`packages/shared/test/strict.test.ts`) discovers `*RequestSchema` / `*QuerySchema` exports from the barrel and fails any that isn't - with two limits worth stating plainly, because an overstated guard is worse than a modest one:
  - It discovers by **name**, which is what makes that naming convention load-bearing. `*BodySchema` is deliberately not a discovered suffix: here it names a *response* body (`conflictBodySchema`, ADR-0012), which must stay lenient.
  - A discriminated union's members are module-private, so discovery reaches only the union; the test seeds a probe down **every** branch, since covering one would leave the others unproven.
- **Outbound is lenient.** Responses keep plain `z.object`. A response is parsed by the client, and a strict client would break the moment the server adds a field a cached SPA bundle predates. Strictness inbound is boundary validation; leniency outbound is forward-compatibility - opposite rules for opposite directions, on purpose.
- **What sits outside, by construction rather than omission.** `MidtransGateway.verifyAndParse` plucks a handful of fields from a large provider payload, so strict would `400` every real webhook; the iCal feed is read by a hand-rolled parser, not a zod object. Both live in `apps/api` with no shared schema and no validation pipe. Documented so nobody "fixes" them.
- **A route that takes no body says so** (added by #152; this was the ADR's one open gap). The verb-subresources - `archive`, `unarchive`, `cancel`, `dismiss`, `handle`, `pay`, `sync`, plus `auth/refresh` and `auth/logout` - declared no body at all, so Nest never read one and a stray key was silently ignored: the same indistinguishable-from-success failure, on the routes that had no schema to fix. They now carry `@NoBody()`, a marker that applies a guard validating the body against the shared `noBodyRequestSchema` (`strictObject({})`), so the refusal is byte-identical to every other unknown-key `400`. **Widened past #152's table to DELETE routes too**: `DELETE /properties/:id {"force":true}` is the same caller bug, and `force`/`cascade` is a plausible guess given the delete guard of [ADR-0002](0002-deleting-inventory-never-destroys-the-ledger.md).
- **One inbound schema lives outside the package**: `apiCreateBookingRequestSchema` (`apps/api`, #124's per-country phone gate) inherits strict by wrapping the shared schema. That is a derivation, not a declaration, so it is pinned by its own test beside it.

## Considered and rejected

- **Strict only on partial PATCH bodies** (where the ambiguity bites hardest) - leaves the same typo-swallowing on `POST` bodies and queries, and splits the convention by endpoint, the drift [ADR-0012](0012-a-409-carries-a-code-not-a-sentence.md) argues against.
- **Leave as-is, document the leniency** - keeps a bug that reads as success.
- **Strict responses too** - would make every additive server field a breaking change for older clients.
- For the no-body routes (#152), **an `@Body(new ZodValidationPipe(noBodyRequestSchema))` parameter** - the shape the issue assumed. It adds sixteen arguments that exist only for a side effect. A marker decorator with the behaviour behind it is the shape used twice already (`@Roles` + `RolesGuard`, `@ThrottleSensitive` + `skipIf`), and it stacks with them at the route.
- **A global guard that auto-detects "has no `@Body`"** - it cannot rot, but it must reflect Nest's `ROUTE_ARGS_METADATA` in production code, and a detection that broke could fail *open* silently. Splitting it the other way is strictly safer: production code has zero framework-internals coupling, and the reflection lives in the enumeration test, where a break is loud. The rot that a per-route marker invites is what that test exists to catch.
- **Only the routes that plausibly attract a body** (`cancel`, `handle`, `dismiss`) - cheapest, and reintroduces the split-by-endpoint convention this ADR and [ADR-0012](0012-a-409-carries-a-code-not-a-sentence.md) both argue against. A per-route judgement call is what makes a convention rot.

## Consequences

- Verified against zod 3.25 that `.strict()` composes with everything the request schemas need: `.partial()` preserves it (and still lets an omitted-but-defaulted field stay omitted - the `unit.ts` short-circuit), `.refine()` chains still reject unknown keys, and strict `discriminatedUnion` members reject them on the matched branch.
- The web is unaffected: all PATCH mutations build minimal, explicitly-keyed bodies (`parsed.data`), so no call site round-trips a response object back as a request. Were one to, it would now fail on read-only fields (`id`, `slug`, `createdAt`) - correctly.
- The unknown-key `400` carries zod's default `unrecognized_keys` message, which names the offending key; the issue `path` is the object root, not the key. Good enough - no custom error map.
- `@NoBody()`'s guard reads `req.body`, so a body sent with a **non-JSON content type** is never parsed and stays invisible. Nothing here reads a raw body, so such a request is ignored just as completely either way - stated rather than glossed.
- On an authenticated route the controller-level `JwtAuthGuard` still runs first, so an anonymous caller gets `401`, never a hint about body validity from a `400`.
