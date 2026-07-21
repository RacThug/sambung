/**
 * `strictObject` - the constructor for an INBOUND request object (ADR-0031).
 *
 * The convention, applied uniformly across this package (api-spec §1):
 *
 * - **Request bodies and query params are strict.** An unknown key is a caller
 *   bug, and the alternative hides it: a partial PATCH schema cannot tell a
 *   MISSPELLED field from an OMITTED one, so `z.object`'s default (strip unknown
 *   keys) turns `PATCH /settings {galleryCapp: 60}` into a `200` that changed
 *   nothing - success and typo become indistinguishable. Strict makes the typo a
 *   `400` naming the offending key. This is "validate all external input at the
 *   boundary" (CLAUDE.md) taken to its conclusion.
 *
 * - **Responses are NOT strict** - they keep plain `z.object`. A response is
 *   parsed by the client, and a strict client would break the moment the server
 *   adds a field a cached SPA bundle predates. Leniency outbound is
 *   forward-compatibility; strictness inbound is boundary validation. Opposite
 *   rules for opposite directions, on purpose.
 *
 * - **The provider webhook is the one inbound exception**, and it lives in
 *   apps/api, not here: `MidtransGateway.verifyAndParse` plucks a handful of
 *   fields from a large provider payload, so strict would reject every real
 *   webhook. It has no shared schema and no validation pipe - out of scope by
 *   construction, not by omission.
 *
 * `strictObject` returns a `ZodObject`, so it composes with everything the
 * request schemas need - `.partial()` (strict is preserved, and an omitted field
 * stays omitted rather than snapping to its `.default()`), `.refine()` chains,
 * and use as a `discriminatedUnion` member - all verified to still reject unknown
 * keys. Use it wherever a body or query is defined; use plain `z.object` for a
 * response. A request schema that reaches for `z.object` stands out to a reviewer
 * and fails the enumeration test in `test/strict.test.ts`.
 */
import { z } from "zod";

export function strictObject<T extends z.ZodRawShape>(
  shape: T,
): z.ZodObject<T, "strict"> {
  return z.object(shape).strict();
}
