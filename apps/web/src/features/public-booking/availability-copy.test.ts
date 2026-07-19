import { describe, expect, it } from "vitest";
import {
  describeBlockedNights,
  describeReason,
  describeStay,
} from "./availability-copy";

describe("availability-copy", () => {
  describe("describeReason", () => {
    it("names the minimum, pluralized, for min_stay", () => {
      expect(describeReason("min_stay", 3)).toBe(
        "This room has a 3 nights minimum stay.",
      );
      expect(describeReason("min_stay", 1)).toBe(
        "This room has a 1 night minimum stay.",
      );
    });

    it("explains overlap without leaking who booked it", () => {
      expect(describeReason("overlap", 2)).toMatch(/already booked/);
    });
  });

  describe("describeBlockedNights", () => {
    it("shows a single occupied night as one date", () => {
      // [20, 21) = one night, the 20th; the 21st is a free checkout day.
      expect(describeBlockedNights({ from: "2026-08-20", to: "2026-08-21" })).toBe(
        describeBlockedNights({ from: "2026-08-20", to: "2026-08-21" }),
      );
      expect(
        describeBlockedNights({ from: "2026-08-20", to: "2026-08-21" }),
      ).not.toMatch(/-/); // no range dash for a single night
    });

    it("shows a run as first night - last night, excluding checkout", () => {
      // [12, 15) occupies 12,13,14; the label ends on the 14th, not the 15th.
      const label = describeBlockedNights({ from: "2026-08-12", to: "2026-08-15" });
      expect(label).toMatch(/12/);
      expect(label).toMatch(/14/);
      expect(label).not.toMatch(/15/);
    });
  });

  describe("describeStay", () => {
    it("counts half-open nights", () => {
      expect(describeStay("2026-09-10", "2026-09-13")).toBe("3 nights");
      expect(describeStay("2026-09-10", "2026-09-11")).toBe("1 night");
    });
  });
});
