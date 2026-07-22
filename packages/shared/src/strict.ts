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
 * - **Inbound parsing that does NOT live here is out of this convention's
 *   reach**, and deliberately so. `MidtransGateway.verifyAndParse` plucks a
 *   handful of fields from a large provider payload, so strict would reject
 *   every real webhook; the iCal feed is read by a hand-rolled parser, not a
 *   zod object. Both live in apps/api with no shared schema and no validation
 *   pipe.
 *
 * - **A route that takes no body says so, with a schema like any other**
 *   (`noBodyRequestSchema`, below). The verb-subresources - archive, cancel,
 *   dismiss, handle, pay, sync, refresh, logout - used to declare nothing at
 *   all, which meant a stray key was silently ignored: the same
 *   indistinguishable-from-success failure this whole convention exists to
 *   remove, on the routes that had no schema to fix (#152).
 *
 * - **A public query schema must declare `lang`.** api-spec §1 documents
 *   `?lang=en|id|zh` as legal on public endpoints, so a strict query schema that
 *   omits it would turn a documented-legal param into a 400
 *   (`availabilityQuerySchema` declares it).
 *
 * `strictObject` returns a `ZodObject`, so it composes with everything the
 * request schemas need - `.partial()` (strict is preserved, and an omitted field
 * stays omitted rather than snapping to its `.default()`), `.refine()` chains,
 * and use as a `discriminatedUnion` member - all verified to still reject unknown
 * keys. Use it wherever a body or query is defined; use plain `z.object` for a
 * response. A request schema that reaches for `z.object` fails the enumeration
 * test in `test/strict.test.ts` - provided it follows the `*RequestSchema` /
 * `*QuerySchema` naming that test discovers by, which is what makes the naming
 * convention load-bearing rather than cosmetic.
 *
 * Not exported from the package barrel: this is a schema-authoring tool for this
 * package, not part of the FE-BE contract.
 */
import { z } from "zod";

export function strictObject<T extends z.ZodRawShape>(
  shape: T,
): z.ZodObject<T, "strict"> {
  return z.object(shape).strict();
}

/**
 * The body of a request that takes no arguments (#152) - the verb-subresource
 * POSTs (`archive`, `unarchive`, `cancel`, `dismiss`, `handle`, `pay`, `sync`)
 * plus `auth/refresh` and `auth/logout`. "This endpoint reads nothing" is a
 * contract fact, so it is declared here rather than assumed by omission.
 *
 * Accepts an absent body (Express parses that to `{}`) and rejects every key,
 * so `POST /bookings/:id/cancel {"refund":"full"}` is a 400 naming `refund`
 * instead of a 200 that cheerfully ignored it. Enforced by `@NoBody()` in
 * apps/api, and - being a `*RequestSchema` - proven strict by the enumeration
 * test in `test/strict.test.ts` like every other inbound schema.
 *
 * Exported from the barrel (unlike `strictObject` itself) because the API
 * validates against it.
 */
export const noBodyRequestSchema = strictObject({});
