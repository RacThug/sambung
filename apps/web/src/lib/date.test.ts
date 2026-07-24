import { afterEach, describe, expect, it } from "vitest";
import { formatDate, formatInstant } from "./date";

/**
 * The pair that #188 is about: a CALENDAR DATE is the same day for everyone, a
 * MOMENT is not. Both are `string` on the wire, so nothing but these tests and
 * the naming keeps them apart.
 *
 * Every case pins a zone, because the defect only exists relative to one - a
 * suite that runs in UTC (or silently in whatever zone the machine sits in)
 * cannot tell the two functions apart at all. `formatInstant` builds its
 * formatter per call precisely so this works.
 *
 * Assertions match on the DAY NUMBER rather than a whole formatted string: the
 * locale is the reader's (page-spec §2), so "22 Jul 2026, 07.57" here is
 * "Jul 22, 2026, 7:57 AM" on an en-US machine, and pinning the punctuation would
 * make the suite pass or fail on where it runs.
 */

const withTz = (tz: string, fn: () => void): void => {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    process.env.TZ = before;
  }
};

// Late evening in UTC, next morning in every Indonesian zone. The seed writes
// the demo's sync conflict at exactly this kind of instant.
const LATE_UTC = "2026-07-21T23:57:00Z";

afterEach(() => {
  delete process.env.TZ;
});

describe("formatInstant", () => {
  it("shows the reader's calendar day, not the UTC one", () => {
    withTz("Asia/Makassar", () => {
      // 07:57 on the 22nd in WITA. The bug rendered "21".
      expect(formatInstant(LATE_UTC)).toMatch(/\b22\b/);
      expect(formatInstant(LATE_UTC)).not.toMatch(/\b21\b/);
    });
  });

  it("shows a different day to readers on either side of midnight", () => {
    let makassar = "";
    let losAngeles = "";
    withTz("Asia/Makassar", () => {
      makassar = formatInstant(LATE_UTC);
    });
    // Deliberately a zone BEHIND UTC. Europe/London is not one in July - it is
    // BST, UTC+1, so it is already the 22nd there and the case proves nothing.
    withTz("America/Los_Angeles", () => {
      losAngeles = formatInstant(LATE_UTC);
    });
    // Same instant, two readers, two calendar days - which is the whole reason
    // this cannot be formatted as a bare date.
    expect(makassar).toMatch(/\b22\b/);
    expect(losAngeles).toMatch(/\b21\b/);
    expect(makassar).not.toEqual(losAngeles);
  });

  it("shows the time, so the zone can never be silently dropped again", () => {
    withTz("Asia/Makassar", () => {
      // 07:57 - the separator is the locale's (":" or "."), the digits are not.
      expect(formatInstant(LATE_UTC)).toMatch(/07.57/);
    });
  });
});

describe("formatDate", () => {
  it("reads as the same calendar day in every zone", () => {
    const dates: string[] = [];
    for (const tz of ["Asia/Makassar", "Europe/London", "America/Los_Angeles"]) {
      withTz(tz, () => dates.push(formatDate("2026-07-22")));
    }
    // A stay's check-in is not an instant: 22 July is 22 July for the guest, the
    // owner, and the OTA - never the 21st because the reader is west of us.
    expect(new Set(dates).size).toBe(1);
    expect(dates[0]).toMatch(/\b22\b/);
  });
});
