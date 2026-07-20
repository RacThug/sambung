import { describe, expect, it } from "vitest";
import { formatDate, formatGuests, formatNights } from "./format";

describe("i18n formatters", () => {
  describe("formatNights", () => {
    it("inflects the noun in English, not in ID/ZH", () => {
      expect(formatNights(1, "en")).toBe("1 night");
      expect(formatNights(3, "en")).toBe("3 nights");
      expect(formatNights(3, "id")).toBe("3 malam");
      expect(formatNights(1, "zh")).toBe("1 晚");
    });
  });

  describe("formatGuests", () => {
    it("inflects the noun in English, not in ID/ZH", () => {
      expect(formatGuests(1, "en")).toBe("1 guest");
      expect(formatGuests(2, "en")).toBe("2 guests");
      expect(formatGuests(2, "id")).toBe("2 tamu");
      expect(formatGuests(2, "zh")).toBe("2 位客人");
    });
  });

  describe("formatDate", () => {
    // The wire is always YYYY-MM-DD; display follows the locale (page-spec §2).
    it("renders the same calendar day per locale, never slipping a timezone", () => {
      // EN funnel dates are day-month-year (en-GB).
      expect(formatDate("2027-03-03", "en")).toMatch(/3 Mar 2027/);
      // ID: day-month-year in Indonesian.
      expect(formatDate("2027-03-03", "id")).toMatch(/2027/);
      expect(formatDate("2027-03-03", "id")).toMatch(/3/);
      // ZH: year-first with CJK markers.
      expect(formatDate("2027-03-03", "zh")).toMatch(/2027/);
      expect(formatDate("2027-03-03", "zh")).toContain("3");
    });
  });
});
