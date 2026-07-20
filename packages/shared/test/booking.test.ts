import { describe, expect, it } from "vitest";
import { createBookingRequestSchema, e164PhoneSchema } from "../src/booking";

/**
 * The guest funnel's phone is strict E.164 (#54) - the server's correctness
 * boundary that made `wa.me` links resolvable on every country. A bare national
 * number is the ambiguous input that broke the link, and must be rejected here.
 */
describe("e164PhoneSchema", () => {
  it("accepts a valid E.164 number (any country)", () => {
    expect(e164PhoneSchema.parse("+6281234567890")).toBe("+6281234567890"); // ID
    expect(e164PhoneSchema.parse("+447911123456")).toBe("+447911123456"); // GB
    expect(e164PhoneSchema.parse("+14155550100")).toBe("+14155550100"); // US
  });

  it("rejects a bare national number (the ambiguous input that broke wa.me)", () => {
    expect(() => e164PhoneSchema.parse("081234567890")).toThrow();
    expect(() => e164PhoneSchema.parse("07911123456")).toThrow();
  });

  it("rejects spaces / punctuation (not canonical E.164)", () => {
    expect(() => e164PhoneSchema.parse("+62 812 3456 7890")).toThrow();
    expect(() => e164PhoneSchema.parse("+1 (415) 555-0100")).toThrow();
  });

  it("rejects a leading-zero country code and out-of-range lengths", () => {
    expect(() => e164PhoneSchema.parse("+0123456789")).toThrow();
    expect(() => e164PhoneSchema.parse("+123")).toThrow(); // too short
    expect(() => e164PhoneSchema.parse("+1234567890123456")).toThrow(); // >15
  });
});

describe("createBookingRequestSchema guestPhone (#54)", () => {
  const base = {
    unitId: "bbbbbbbb-0000-0000-0000-000000000001",
    checkIn: "2027-03-10",
    checkOut: "2027-03-14",
    guestName: "Made A.",
    guestCount: 2,
  };

  it("requires an E.164 guestPhone", () => {
    expect(
      createBookingRequestSchema.parse({ ...base, guestPhone: "+6281234567890" })
        .guestPhone,
    ).toBe("+6281234567890");
  });

  it("rejects a bare national guestPhone", () => {
    expect(() =>
      createBookingRequestSchema.parse({ ...base, guestPhone: "081234567890" }),
    ).toThrow();
  });
});
