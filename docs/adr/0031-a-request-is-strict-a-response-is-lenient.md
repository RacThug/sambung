# A request is strict; a response is lenient

Every inbound request schema in `packages/shared` - the shape of a **body or a query param** - rejects unknown keys (`.strict()`, via one `strictObject` helper); response schemas keep plain `z.object` and tolerate them. Surfaced by the #67 / PR #149 review, decided once for the whole package rather than per-endpoint (#150).

## Context

No request schema was strict, so zod's default stripped unknown keys. A partial `PATCH` schema cannot tell a **misspelled** field from an **omitted** one, so `PATCH /settings {galleryCapp: 60}` returned **200 having changed nothing** - success and typo were indistinguishable. The same silent-success bug lives on query params: `?form=` instead of `?from=` falls back to a default and looks fine. This is the exact failure "validate all external input at the boundary" (CLAUDE.md) exists to prevent.

## Decision

- **Inbound is strict.** Bodies *and* query params reject unknown keys, so a typo is a `400` naming it. Applied uniformly through a single `strictObject(shape) = z.object(shape).strict()` helper, used at every request-schema construction site - a new request schema reaches for it and is strict by construction, and an enumeration test (`packages/shared/test/strict.test.ts`) auto-discovers `*RequestSchema` / `*QuerySchema` exports and fails any that isn't.
- **Outbound is lenient.** Responses keep plain `z.object`. A response is parsed by the client, and a strict client would break the moment the server adds a field a cached SPA bundle predates. Strictness inbound is boundary validation; leniency outbound is forward-compatibility - opposite rules for opposite directions, on purpose.
- **One inbound exception: the provider webhook.** `MidtransGateway.verifyAndParse` (in `apps/api`, not a shared schema, no validation pipe) plucks a handful of fields from a large provider payload; strict would `400` every real webhook. Out of scope by construction, and documented so nobody "fixes" it.

## Considered and rejected

- **Strict only on partial PATCH bodies** (where the ambiguity bites hardest) - leaves the same typo-swallowing on `POST` bodies and queries, and splits the convention by endpoint, the drift [ADR-0012](0012-a-409-carries-a-code-not-a-sentence.md) argues against.
- **Leave as-is, document the leniency** - keeps a bug that reads as success.
- **Strict responses too** - would make every additive server field a breaking change for older clients.

## Consequences

- Verified against zod 3.25 that `.strict()` composes with everything the request schemas need: `.partial()` preserves it (and still lets an omitted-but-defaulted field stay omitted - the `unit.ts` short-circuit), `.refine()` chains still reject unknown keys, and strict `discriminatedUnion` members reject them on the matched branch.
- The web is unaffected: all PATCH mutations build minimal, explicitly-keyed bodies (`parsed.data`), so no call site round-trips a response object back as a request. Were one to, it would now fail on read-only fields (`id`, `slug`, `createdAt`) - correctly.
- The unknown-key `400` carries zod's default `unrecognized_keys` message, which names the offending key; the issue `path` is the object root, not the key. Good enough - no custom error map.
