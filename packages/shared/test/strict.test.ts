import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as shared from "../src";
import { tenantDtoSchema } from "../src/auth";
import { strictObject } from "../src/strict";

/**
 * The drift guard for ADR-0031 / #150: every INBOUND request schema in this
 * package rejects unknown keys, so a misspelled field is a 400, not a 200 that
 * silently changed nothing.
 *
 * It DISCOVERS schemas from the barrel by naming convention rather than listing
 * them, so a new request schema built with `z.object` instead of `strictObject`
 * fails here without anyone registering it. Two honest limits on that claim:
 *
 * - Discovery is only as good as the NAME. `RequestSchema` / `QuerySchema` are
 *   the inbound suffixes; a schema ending in neither is invisible to it, so keep
 *   the convention. Note `BodySchema` is deliberately NOT one of them - in this
 *   package it names a RESPONSE body (`conflictBodySchema`, the 409 shape of
 *   ADR-0012), which must stay lenient.
 * - A discriminated union's members are module-private, so discovery reaches
 *   only the union. Probing one branch would leave the others unproven, so
 *   BRANCH_SEEDS routes a probe down every branch.
 *
 * Inbound schemas that live OUTSIDE this package are out of its reach: the one
 * today, `apiCreateBookingRequestSchema`, inherits strict by wrapping the shared
 * schema and is pinned by its own test in apps/api.
 */
const UNKNOWN_KEY = "__unknownKey__";

/**
 * Seeds that route a probe down every branch a schema can take. Only a
 * discriminated union needs them: an unseeded probe fails to route
 * (invalid_union_discriminator) before any strict member is reached.
 */
const BRANCH_SEEDS: Record<string, Array<Record<string, unknown>>> = {
  createOwnerBookingRequestSchema: [
    { source: "manual_block" },
    { source: "direct" },
  ],
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

  it("every branch seed names a schema that still exists", () => {
    // A rename would otherwise orphan the seed and quietly stop probing a branch.
    expect(requestSchemaNames).toEqual(
      expect.arrayContaining(Object.keys(BRANCH_SEEDS)),
    );
  });

  it.each(requestSchemaNames)(
    "%s rejects an unknown key on every branch",
    (name) => {
      const schema = (shared as Record<string, unknown>)[name] as z.ZodTypeAny;

      for (const seed of BRANCH_SEEDS[name] ?? [{}]) {
        const result = schema.safeParse({ ...seed, [UNKNOWN_KEY]: true });

        expect(result.success).toBe(false);
        // The object-level unrecognized_keys issue is present even alongside
        // missing required fields: zod accumulates every issue in one parse.
        const codes = result.success
          ? []
          : result.error.issues.map((issue) => issue.code);
        expect(codes).toContain("unrecognized_keys");
      }
    },
  );

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
