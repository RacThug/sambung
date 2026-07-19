import { describe, expect, it } from "vitest";
import {
  blockedMatchers,
  dateToIso,
  initialMonth,
  isoToDate,
  monthWindow,
  pastDisabled,
  rangeFromSearch,
  sameStay,
  stayFromRange,
} from "./availability-model";

describe("availability-model", () => {
  describe("iso <-> local Date", () => {
    it("round-trips a date through local midnight", () => {
      const d = isoToDate("2026-08-15");
      expect(d.getFullYear()).toBe(2026);
      expect(d.getMonth()).toBe(7); // August, 0-based
      expect(d.getDate()).toBe(15);
      expect(dateToIso(d)).toBe("2026-08-15");
    });

    it("reads local fields, never a UTC slice that could slip a day", () => {
      // Built local; whatever the runner's TZ, the day component is what we set.
      expect(dateToIso(new Date(2026, 0, 1))).toBe("2026-01-01");
      expect(dateToIso(new Date(2026, 11, 31))).toBe("2026-12-31");
    });
  });

  describe("monthWindow", () => {
    it("covers the whole month, half-open [1st, 1st-of-next)", () => {
      expect(monthWindow(new Date(2026, 7, 15))).toEqual({
        from: "2026-08-01",
        to: "2026-09-01",
      });
    });

    it("rolls the year over in December", () => {
      expect(monthWindow(new Date(2026, 11, 3))).toEqual({
        from: "2026-12-01",
        to: "2027-01-01",
      });
    });
  });

  describe("blockedMatchers", () => {
    it("maps half-open [from,to) to an inclusive [from, to-1] range", () => {
      // A booking check-in 12th, check-out 15th occupies nights 12,13,14.
      const [m] = blockedMatchers([{ from: "2026-08-12", to: "2026-08-15" }]);
      expect(dateToIso(m.from!)).toBe("2026-08-12");
      expect(dateToIso(m.to!)).toBe("2026-08-14"); // 15th (checkout) is free
    });

    it("collapses a one-night block to a single day", () => {
      const [m] = blockedMatchers([{ from: "2026-08-20", to: "2026-08-21" }]);
      expect(dateToIso(m.from!)).toBe("2026-08-20");
      expect(dateToIso(m.to!)).toBe("2026-08-20");
    });

    it("maps every range", () => {
      expect(
        blockedMatchers([
          { from: "2026-08-01", to: "2026-08-03" },
          { from: "2026-08-10", to: "2026-08-11" },
        ]),
      ).toHaveLength(2);
    });
  });

  describe("pastDisabled", () => {
    it("disables everything strictly before today; today stays open", () => {
      const { before } = pastDisabled("2026-08-15");
      expect(dateToIso(before)).toBe("2026-08-15");
    });
  });

  describe("initialMonth", () => {
    it("opens on the selection's month when it is in the future", () => {
      expect(dateToIso(initialMonth("2026-12-24", "2026-08-15"))).toBe(
        "2026-12-24",
      );
    });

    it("falls back to today for no selection or a past link", () => {
      expect(dateToIso(initialMonth(undefined, "2026-08-15"))).toBe(
        "2026-08-15",
      );
      expect(dateToIso(initialMonth("2020-01-01", "2026-08-15"))).toBe(
        "2026-08-15",
      );
    });
  });

  describe("rangeFromSearch", () => {
    it("is undefined with no check-in", () => {
      expect(rangeFromSearch(undefined, undefined)).toBeUndefined();
    });

    it("renders a half-made selection (check-in only)", () => {
      const r = rangeFromSearch("2026-09-10", undefined);
      expect(dateToIso(r!.from!)).toBe("2026-09-10");
      expect(r!.to).toBeUndefined();
    });

    it("renders a complete range", () => {
      const r = rangeFromSearch("2026-09-10", "2026-09-13");
      expect(dateToIso(r!.from!)).toBe("2026-09-10");
      expect(dateToIso(r!.to!)).toBe("2026-09-13");
    });
  });

  describe("stayFromRange", () => {
    it("returns null for empty, half-made, or same-day selections", () => {
      expect(stayFromRange(undefined)).toBeNull();
      expect(
        stayFromRange({ from: isoToDate("2026-09-10"), to: undefined }),
      ).toBeNull();
      expect(
        stayFromRange({
          from: isoToDate("2026-09-10"),
          to: isoToDate("2026-09-10"),
        }),
      ).toBeNull(); // 0 nights
    });

    it("maps a real range straight to a half-open stay", () => {
      expect(
        stayFromRange({
          from: isoToDate("2026-09-10"),
          to: isoToDate("2026-09-13"),
        }),
      ).toEqual({ from: "2026-09-10", to: "2026-09-13" }); // 3 nights
    });
  });

  describe("sameStay", () => {
    it("compares by value, treating null as a state", () => {
      const a = { from: "2026-09-10", to: "2026-09-13" };
      expect(sameStay(a, { ...a })).toBe(true);
      expect(sameStay(a, { from: "2026-09-10", to: "2026-09-14" })).toBe(false);
      expect(sameStay(null, null)).toBe(true);
      expect(sameStay(a, null)).toBe(false);
    });
  });
});
