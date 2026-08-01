import { describe, expect, it } from "vitest";
import {
  bookingConfirmationResponseSchema,
  buildWaMeLink,
  normalizeWaPhone,
} from "../src/booking-confirmation";

describe("normalizeWaPhone", () => {
  it("strips the + from a canonical E.164 number, for any country", () => {
    expect(normalizeWaPhone("+6281234567890")).toBe("6281234567890"); // ID
    expect(normalizeWaPhone("+447911123456")).toBe("447911123456"); // GB
    expect(normalizeWaPhone("+14155550100")).toBe("14155550100"); // US
  });

  it("omits a bare national number - no country code, ambiguous (#123 review)", () => {
    // The lenient owner-walk-in case: without a leading '+' this must NOT become
    // wa.me/0812..., it must yield "" so the caller omits the button.
    expect(normalizeWaPhone("0812 3456 7890")).toBe("");
    expect(normalizeWaPhone("081234567890")).toBe("");
  });

  it("rejects anything that isn't canonical E.164", () => {
    expect(normalizeWaPhone("+62 812 3456 7890")).toBe(""); // separators
    expect(normalizeWaPhone("+0123456789")).toBe(""); // leading-zero country code
    expect(normalizeWaPhone("123")).toBe(""); // no +, too short
    expect(normalizeWaPhone("not a phone")).toBe("");
    expect(normalizeWaPhone(null)).toBe("");
    expect(normalizeWaPhone(undefined)).toBe("");
  });
});

describe("buildWaMeLink", () => {
  const base = {
    phone: "+6281234567890",
    guestName: "Made A.",
    propertyName: "Seminyak Beach Villa",
    unitName: "Garden Room 1",
    checkIn: "2027-03-10",
    checkOut: "2027-03-14",
  };

  it("builds a wa.me link to the guest's E.164 number with a prefilled message", () => {
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

  it("addresses a non-Indonesian country correctly", () => {
    const link = buildWaMeLink({ ...base, phone: "+447911123456" });
    expect(new URL(link!).pathname).toBe("/447911123456");
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

  it("returns null for a lenient bare national number - omit, never a broken link (#123 review)", () => {
    // A walk-in row read through the confirmation endpoint: no country code, so no
    // link at all rather than the broken wa.me/0812...
    expect(buildWaMeLink({ ...base, phone: "0812 3456 7890" })).toBeNull();
    expect(buildWaMeLink({ ...base, phone: "081234567890" })).toBeNull();
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
    balanceIdr: 2_800_000,
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
        balanceIdr: null,
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
