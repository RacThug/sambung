import { describe, expect, it } from "vitest";
import { formatAge } from "./relative-time";

/**
 * A pure `(iso, now)` function, so every case states the instant it is asking
 * about. No fake timers: freezing global time to test a phrase would be a much
 * larger hammer than the thing being tested, and it hides the parameter that
 * makes this function testable in the first place.
 */
describe("formatAge", () => {
  const now = new Date("2026-08-18T12:00:00Z");
  const ago = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();

  it("says 'just now' under a minute", () => {
    expect(formatAge(ago(0), now)).toBe("just now");
    expect(formatAge(ago(0.5), now)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(formatAge(ago(1), now)).toBe("1 minute ago");
    expect(formatAge(ago(12), now)).toBe("12 minutes ago");
    expect(formatAge(ago(59), now)).toBe("59 minutes ago");
    expect(formatAge(ago(60), now)).toBe("1 hour ago");
    expect(formatAge(ago(200), now)).toBe("3 hours ago");
    expect(formatAge(ago(60 * 24), now)).toBe("1 day ago");
    expect(formatAge(ago(60 * 24 * 3), now)).toBe("3 days ago");
  });

  it("reads a timestamp slightly in the future as 'just now', not a negative age", () => {
    // The server stamped it; a browser clock two minutes behind would otherwise
    // render "-2 minutes ago", which looks like a bug in the product rather than
    // in the laptop.
    expect(formatAge(ago(-2), now)).toBe("just now");
  });
});
