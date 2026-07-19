import { describe, expect, it } from "vitest";
import {
  conflictBodySchema,
  conflictCodeSchema,
  parseConflictBody,
} from "../src/conflict";

// The wire contract for 409s (#82). These lock the slug set and the per-code
// detail so a rename or a dropped field is a red test on both sides of the wire.
describe("conflictCodeSchema", () => {
  it("is the exact closed set of 409 slugs", () => {
    expect([...conflictCodeSchema.options].sort()).toEqual([
      "booking_not_cancellable",
      "dates_unavailable",
      "email_taken",
      "property_has_bookings",
      "unit_has_bookings",
      "unit_name_taken",
    ]);
  });
});

describe("conflictBodySchema", () => {
  it("accepts a slug-only body", () => {
    expect(conflictBodySchema.parse({ code: "email_taken" })).toEqual({
      code: "email_taken",
    });
  });

  it("keeps the delete guard's count as structured data", () => {
    expect(
      conflictBodySchema.parse({ code: "unit_has_bookings", count: 14 }),
    ).toEqual({ code: "unit_has_bookings", count: 14 });
  });

  it("strips the API envelope's framing fields, keeping only the domain body", () => {
    // What the wire actually carries: Nest's statusCode/error/message plus ours.
    // The schema models the DOMAIN body, so the framing is dropped on parse.
    expect(
      conflictBodySchema.parse({
        statusCode: 409,
        error: "Conflict",
        message: "Property has 2 bookings",
        code: "property_has_bookings",
        count: 2,
      }),
    ).toEqual({ code: "property_has_bookings", count: 2 });
  });

  it("carries refusal reasons for a blocked stay", () => {
    expect(
      conflictBodySchema.parse({
        code: "dates_unavailable",
        reasons: ["overlap", "min_stay"],
      }),
    ).toEqual({ code: "dates_unavailable", reasons: ["overlap", "min_stay"] });
  });

  it("carries the terminal status for a non-cancellable booking", () => {
    expect(
      conflictBodySchema.parse({
        code: "booking_not_cancellable",
        status: "expired",
      }),
    ).toEqual({ code: "booking_not_cancellable", status: "expired" });
  });

  it("rejects a count-bearing code with the count missing", () => {
    expect(
      conflictBodySchema.safeParse({ code: "property_has_bookings" }).success,
    ).toBe(false);
  });

  it("rejects an unknown code and non-conflict shapes", () => {
    expect(conflictBodySchema.safeParse({ code: "made_up" }).success).toBe(
      false,
    );
    expect(conflictBodySchema.safeParse({ reasons: ["overlap"] }).success).toBe(
      false,
    );
  });
});

describe("parseConflictBody", () => {
  it("returns the typed body for a recognized conflict", () => {
    expect(parseConflictBody({ code: "email_taken" })).toEqual({
      code: "email_taken",
    });
  });

  it("returns null for anything it doesn't recognize", () => {
    expect(parseConflictBody({ message: "Validation failed" })).toBeNull();
    expect(parseConflictBody(undefined)).toBeNull();
    expect(parseConflictBody("nope")).toBeNull();
  });
});
