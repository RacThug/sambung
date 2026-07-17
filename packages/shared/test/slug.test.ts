import { describe, expect, it } from "vitest";
import { SLUG_PATTERN, slugCandidates, slugifyName } from "../src/slug";

describe("slugifyName", () => {
  it("kebab-cases an ordinary name", () => {
    expect(slugifyName("Seminyak Beach Villa")).toBe("seminyak-beach-villa");
  });

  it("strips accents rather than dropping the letters", () => {
    // NFKD + combining-mark strip, so the word survives instead of becoming
    // "caf-lumbung" (or vanishing entirely and hitting the fallback).
    expect(slugifyName("Café Lumbung")).toBe("cafe-lumbung");
  });

  it("collapses punctuation and trims the edges", () => {
    expect(slugifyName("  The Villa -- by the Sea!! ")).toBe(
      "the-villa-by-the-sea",
    );
  });

  it("keeps digits", () => {
    expect(slugifyName("Villa 21")).toBe("villa-21");
  });

  it("falls back to a token when nothing ASCII survives", () => {
    // 中文 is a first-class language (FR-I18N-1), so this is a real name, not a
    // pathological input. Naive slugify returns "" here - which would be a
    // broken URL and a NOT NULL violation.
    const slug = slugifyName("乌布丛林别墅");
    expect(slug).toMatch(/^property-[a-z0-9]{5}$/);
  });

  it("falls back when the name is only punctuation", () => {
    expect(slugifyName("!!! ---")).toMatch(/^property-[a-z0-9]{5}$/);
  });

  it("caps the length without leaving a trailing dash", () => {
    const slug = slugifyName("a".repeat(40) + " " + "b".repeat(40));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toMatch(SLUG_PATTERN);
  });

  it("always produces a slug the DB CHECK accepts", () => {
    // property_slug_format mirrors SLUG_PATTERN. Anything slugifyName can emit
    // must satisfy it, or a create 500s on our own constraint.
    const names = [
      "Seminyak Beach Villa",
      "Café Lumbung",
      "  --Villa--  ",
      "乌布丛林别墅",
      "Villa 21",
      "!!!",
      "A",
      "a".repeat(200),
      "Ubud   Jungle    Villa",
      "Père & Fils",
    ];
    for (const name of names) {
      expect(slugifyName(name)).toMatch(SLUG_PATTERN);
    }
  });
});

describe("slugCandidates", () => {
  it("offers the bare slug first", () => {
    const [first] = [...slugCandidates("Seminyak Beach Villa")];
    expect(first).toBe("seminyak-beach-villa");
  });

  it("suffixes every retry with a distinct random token", () => {
    const all = [...slugCandidates("Seminyak Beach Villa")];
    const retries = all.slice(1);
    expect(retries.length).toBeGreaterThan(0);
    for (const c of retries) {
      expect(c).toMatch(/^seminyak-beach-villa-[a-z0-9]{5}$/);
    }
    // Not sequential (-2, -3): finding the next number means reading the rows
    // RLS hides, and it would leak how many tenants share a name.
    expect(new Set(retries).size).toBe(retries.length);
  });

  it("is bounded, so a broken generator cannot spin forever", () => {
    expect([...slugCandidates("Villa")].length).toBe(5);
  });

  it("produces only DB-acceptable candidates", () => {
    for (const c of slugCandidates("乌布丛林别墅")) {
      expect(c).toMatch(SLUG_PATTERN);
    }
  });
});
