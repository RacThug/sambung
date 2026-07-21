import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as shared from "../src";
import { strictObject, tenantDtoSchema } from "../src";

/**
 * The drift guard for ADR-0031 / #150: every INBOUND request schema in this
 * package rejects unknown keys, so a misspelled field is a 400, not a 200 that
 * silently changed nothing.
 *
 * It DISCOVERS the schemas by naming convention (`*RequestSchema` / `*QuerySchema`)
 * rather than listing them, so a new request schema that reaches for `z.object`
 * instead of `strictObject` fails here without anyone remembering to register it -
 * this is what makes the convention uniform rather than per-endpoint.
 */
const UNKNOWN_KEY = "__unknownKey__";

// The only shared request schema that is a discriminated union: an unknown-key
// probe must carry a discriminator, or it fails to route before the strict
// member is ever reached (invalid_union_discriminator instead of the
// unrecognized_keys we are proving). Every other request schema routes on {}.
const DISCRIMINATOR_SEED: Record<string, Record<string, unknown>> = {
  createOwnerBookingRequestSchema: { source: "manual_block" },
};

const requestSchemaNames = Object.keys(shared)
  .filter((name) => /(?:RequestSchema|QuerySchema)$/.test(name))
  .sort();

describe("strict request schemas (ADR-0031)", () => {
  it("discovers every request/query schema (a new one must land here too)", () => {
    // 12 bodies + 3 queries at the time of writing; the floor guards against the
    // filter silently matching nothing after a refactor.
    expect(requestSchemaNames.length).toBeGreaterThanOrEqual(15);
  });

  it.each(requestSchemaNames)("%s rejects an unknown key", (name) => {
    const schema = (shared as Record<string, unknown>)[name] as z.ZodTypeAny;
    const seed = DISCRIMINATOR_SEED[name] ?? {};

    const result = schema.safeParse({ ...seed, [UNKNOWN_KEY]: true });

    expect(result.success).toBe(false);
    // The object-level unrecognized_keys issue is present even alongside missing
    // required fields: zod accumulates all issues during the object parse.
    const codes = result.success
      ? []
      : result.error.issues.map((issue) => issue.code);
    expect(codes).toContain("unrecognized_keys");
  });

  it("a response schema stays LENIENT - strips unknown keys, never rejects", () => {
    // The asymmetry is the point (ADR-0031): a strict response would break an
    // old cached SPA bundle the moment the server adds a field. tenantDtoSchema
    // is a plain z.object, so an extra key is dropped, not a 400.
    const result = tenantDtoSchema.safeParse({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Villa Sambung",
      extraServerField: "added in a later deploy",
    });

    expect(result.success).toBe(true);
    expect(result.success && "extraServerField" in result.data).toBe(false);
  });

  it("strictObject composes with partial() - unknown rejected, omit still allowed", () => {
    const schema = strictObject({ a: z.number().default(2) }).partial();

    // The omit-and-default short-circuit PATCH bodies rely on survives strict.
    expect(schema.parse({})).toEqual({});
    expect(schema.safeParse({ bad: 1 }).success).toBe(false);
  });
});
