import { describe, expect, it } from "vitest";
import type { ConflictBody } from "@sambung/shared";
import { ApiError } from "./api-client";
import { conflictOf, describeConflict } from "./conflict";

// The web's half of the 409 contract (#82): parse the slug, render our OWN copy.
// A fresh object literal would trip TS's excess-property check against
// ErrorEnvelope, so bodies are built as variables (structurally wider is fine).
const err = (status: number, body: Record<string, unknown>): ApiError =>
  new ApiError(status, body);

describe("conflictOf", () => {
  it("returns the typed body for a recognized 409", () => {
    const body = {
      statusCode: 409,
      error: "Conflict",
      message: "Unit has 14 booking(s)",
      code: "unit_has_bookings",
      count: 14,
    };
    expect(conflictOf(err(409, body))).toEqual({
      code: "unit_has_bookings",
      count: 14,
    });
  });

  it("returns null for a non-409, a non-ApiError, and an unrecognized body", () => {
    expect(conflictOf(err(400, { message: "Validation failed" }))).toBeNull();
    expect(conflictOf(new Error("boom"))).toBeNull();
    expect(conflictOf(err(409, { message: "no code here" }))).toBeNull();
  });
});

describe("describeConflict", () => {
  it("composes the delete-guard count from data, and pluralizes", () => {
    expect(
      describeConflict({ code: "unit_has_bookings", count: 1 }),
    ).toContain("1 booking -");
    expect(
      describeConflict({ code: "property_has_bookings", count: 3 }),
    ).toContain("3 bookings -");
  });

  it("picks the most decisive refusal reason", () => {
    // A dead unit wins over an overlap - it sends the guest elsewhere.
    expect(
      describeConflict({
        code: "dates_unavailable",
        reasons: ["overlap", "unavailable"],
      }),
    ).toMatch(/no longer available/i);
    expect(
      describeConflict({ code: "dates_unavailable", reasons: ["overlap"] }),
    ).toMatch(/just taken/i);
  });

  it("distinguishes the terminal booking states", () => {
    expect(
      describeConflict({ code: "booking_not_cancellable", status: "cancelled" }),
    ).toMatch(/already cancelled/i);
    expect(
      describeConflict({ code: "booking_not_cancellable", status: "expired" }),
    ).toMatch(/expired/i);
  });

  it("has copy for every code in the union (no server prose)", () => {
    // If a new slug lands in @sambung/shared without copy here, describeConflict
    // fails to compile (assertNever) - this just exercises the existing set.
    const bodies: ConflictBody[] = [
      { code: "email_taken" },
      { code: "unit_name_taken" },
      { code: "property_has_bookings", count: 2 },
      { code: "unit_has_bookings", count: 2 },
      { code: "dates_unavailable", reasons: ["min_stay"] },
      { code: "booking_not_cancellable", status: "cancelled" },
    ];
    for (const body of bodies) {
      expect(describeConflict(body).length).toBeGreaterThan(0);
    }
  });
});
