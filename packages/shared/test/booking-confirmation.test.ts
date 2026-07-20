import { describe, expect, it } from "vitest";
import {
  bookingConfirmationResponseSchema,
  buildWaMeLink,
  normalizeWaPhone,
} from "../src/booking-confirmation";

describe("normalizeWaPhone", () => {
  it("strips the + and separators from an international number", () => {
    expect(normalizeWaPhone("+62 812 3456 7890")).toBe("6281234567890");
    expect(normalizeWaPhone("+1 (415) 555-0100")).toBe("14155550100");
  });

  it("strips a leading 00 international access code", () => {
    expect(normalizeWaPhone("0062 812 3456 7890")).toBe("6281234567890");
  });

  it("returns '' for a missing or implausible number", () => {
    expect(normalizeWaPhone(null)).toBe("");
    expect(normalizeWaPhone(undefined)).toBe("");
    expect(normalizeWaPhone("123")).toBe(""); // too few digits
    expect(normalizeWaPhone("not a phone")).toBe("");
  });
});

describe("buildWaMeLink", () => {
  const base = {
    phone: "+62 812 3456 7890",
    guestName: "Made A.",
    propertyName: "Seminyak Beach Villa",
    unitName: "Garden Room 1",
    checkIn: "2027-03-10",
    checkOut: "2027-03-14",
  };

  it("builds a wa.me link to the guest's number with a prefilled message", () => {
    const link = buildWaMeLink(base);
    expect(link).not.toBeNull();
    const url = new URL(link!);
    expect(url.host).toBe("wa.me");
    expect(url.pathname).toBe("/6281234567890");
    const text = url.searchParams.get("text") ?? "";
    expect(text).toContain("Seminyak Beach Villa - Garden Room 1");
    expect(text).toContain("2027-03-10");
    expect(text).toContain("2027-03-14");
    expect(text).toContain("Made A.");
  });

  it("omits the guest name gracefully", () => {
    const link = buildWaMeLink({ ...base, guestName: null });
    const text = new URL(link!).searchParams.get("text") ?? "";
    expect(text).toContain("Here's your booking:");
  });

  it("returns null when there is no usable phone", () => {
    expect(buildWaMeLink({ ...base, phone: null })).toBeNull();
    expect(buildWaMeLink({ ...base, phone: "12" })).toBeNull();
  });
});

describe("bookingConfirmationResponseSchema", () => {
  const valid = {
    status: "confirmed",
    checkIn: "2027-03-10",
    checkOut: "2027-03-14",
    propertyName: "Seminyak Beach Villa",
    unitName: "Garden Room 1",
    totalPriceIdr: 4_000_000,
    amountPaidIdr: 1_200_000,
    waLink: "https://wa.me/6281234567890?text=hi",
  };

  it("accepts a well-formed confirmed payload", () => {
    expect(bookingConfirmationResponseSchema.parse(valid)).toMatchObject({
      status: "confirmed",
      amountPaidIdr: 1_200_000,
    });
  });

  it("accepts a null price and null waLink", () => {
    expect(() =>
      bookingConfirmationResponseSchema.parse({
        ...valid,
        totalPriceIdr: null,
        waLink: null,
      }),
    ).not.toThrow();
  });

  it("rejects a float amount (money is integer rupiah)", () => {
    expect(() =>
      bookingConfirmationResponseSchema.parse({
        ...valid,
        amountPaidIdr: 1_200_000.5,
      }),
    ).toThrow();
  });
});
