import { describe, expect, it } from "vitest";
import { COUNTRY_OPTIONS, DEFAULT_COUNTRY, toE164 } from "./phone";

describe("toE164", () => {
  it("resolves a bare Indonesian national number to E.164 (the fixed defect)", () => {
    // The exact input that previously produced an unresolvable wa.me/0812…
    expect(toE164("0812 3456 7890", "ID")).toBe("+6281234567890");
    expect(toE164("081234567890", "ID")).toBe("+6281234567890");
  });

  it("resolves a non-Indonesian national number under its own country", () => {
    expect(toE164("07911 123456", "GB")).toBe("+447911123456");
    expect(toE164("(415) 555-0132", "US")).toBe("+14155550132");
  });

  it("accepts an already-international number regardless of the selected country", () => {
    expect(toE164("+6281234567890", "GB")).toBe("+6281234567890");
  });

  it("returns null for an invalid number (client-side UX guard)", () => {
    expect(toE164("123", "ID")).toBeNull();
    expect(toE164("", "ID")).toBeNull();
    expect(toE164("not a phone", "ID")).toBeNull();
  });
});

describe("COUNTRY_OPTIONS", () => {
  it("includes Indonesia (the default) with its calling code", () => {
    const id = COUNTRY_OPTIONS.find((c) => c.code === DEFAULT_COUNTRY);
    expect(id).toBeTruthy();
    expect(id?.callingCode).toBe("62");
  });

  it("is a non-trivial, sorted list of countries", () => {
    expect(COUNTRY_OPTIONS.length).toBeGreaterThan(50);
    const names = COUNTRY_OPTIONS.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
