import { describe, expect, it } from "vitest";
import { createI18n } from "@/i18n/context";
import {
  describeBlockedNights,
  describeReason,
  describeRefusal,
} from "./availability-copy";

const en = createI18n("en");
const id = createI18n("id");
const zh = createI18n("zh");

describe("availability-copy (localized, #58)", () => {
  describe("describeReason", () => {
    it("names the minimum, pluralized, for min_stay - in each language", () => {
      expect(describeReason(en, "min_stay", 3)).toBe(
        "This room has a 3 nights minimum stay.",
      );
      expect(describeReason(en, "min_stay", 1)).toBe(
        "This room has a 1 night minimum stay.",
      );
      // ID/ZH do not inflect the noun; the sentence is localized too.
      expect(describeReason(id, "min_stay", 3)).toContain("3 malam");
      expect(describeReason(zh, "min_stay", 3)).toContain("3 晚");
    });

    it("explains overlap without leaking who booked it, localized", () => {
      expect(describeReason(en, "overlap", 2)).toMatch(/already booked/);
      expect(describeReason(id, "overlap", 2)).toBe(
        "Sebagian malam tersebut sudah dipesan.",
      );
      expect(describeReason(zh, "overlap", 2)).toBe("其中部分晚已被预订。");
    });
  });

  describe("describeBlockedNights", () => {
    it("shows a single occupied night as one date (no range dash)", () => {
      // [20, 21) = one night, the 20th; the 21st is a free checkout day.
      expect(
        describeBlockedNights(en, { from: "2026-08-20", to: "2026-08-21" }),
      ).not.toMatch(/ - /);
    });

    it("shows a run as first night - last night, excluding checkout", () => {
      // [12, 15) occupies 12,13,14; the label ends on the 14th, not the 15th.
      const label = describeBlockedNights(en, {
        from: "2026-08-12",
        to: "2026-08-15",
      });
      expect(label).toMatch(/12/);
      expect(label).toMatch(/14/);
      expect(label).not.toMatch(/15/);
    });

    it("formats the dates in the visitor's locale", () => {
      const range = { from: "2027-03-03", to: "2027-03-04" };
      // en-GB day-month-year; zh year-first with CJK markers - both name day 3.
      expect(describeBlockedNights(en, range)).toMatch(/3 Mar 2027/);
      expect(describeBlockedNights(zh, range)).toMatch(/2027/);
    });
  });

  describe("describeRefusal (checkout 409)", () => {
    it("localizes the just-taken copy for an overlap", () => {
      expect(describeRefusal(en, ["overlap"])).toMatch(/those dates were just taken/i);
      expect(describeRefusal(id, ["overlap"])).toContain("baru saja dipesan");
      expect(describeRefusal(zh, ["overlap"])).toContain("刚刚被预订");
    });

    it("prefers the dead-unit message over an overlap", () => {
      expect(describeRefusal(en, ["archived", "overlap"])).toBe(
        "This unit is no longer available for new bookings.",
      );
    });
  });
});
