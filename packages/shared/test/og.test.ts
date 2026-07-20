import { describe, expect, it } from "vitest";
import { buildPropertyOgTags } from "../src/og";

// Minimal builder: buildPropertyOgTags reads only these four fields, so the
// fixtures carry only those.
type OgInput = Parameters<typeof buildPropertyOgTags>[0];
const property = (over: Partial<OgInput> = {}): OgInput => ({
  name: "Seminyak Beach Villa",
  description: "Steps from the beach.",
  address: "Jl. Kayu Aya, Seminyak",
  photos: [{ url: "https://cdn.test/hero.jpg" }],
  ...over,
});

describe("buildPropertyOgTags", () => {
  it("titles the card with the name and a booking cue", () => {
    expect(buildPropertyOgTags(property()).title).toBe(
      "Seminyak Beach Villa - Book direct",
    );
  });

  it("uses the owner's description when they wrote one", () => {
    expect(buildPropertyOgTags(property()).description).toBe(
      "Steps from the beach.",
    );
  });

  it("falls back to the address when there is no description", () => {
    const tags = buildPropertyOgTags(
      property({ name: "Quiet Villa", description: null, address: "Jl. Test 1" }),
    );
    expect(tags.description).toBe("Book Quiet Villa directly - Jl. Test 1");
  });

  it("treats a blank/whitespace description as no description", () => {
    const tags = buildPropertyOgTags(
      property({ name: "Quiet Villa", description: "   ", address: "Jl. Test 1" }),
    );
    expect(tags.description).toBe("Book Quiet Villa directly - Jl. Test 1");
  });

  it("falls back to a bare cue when there is neither description nor address", () => {
    const tags = buildPropertyOgTags(
      property({ name: "Nameless", description: null, address: null }),
    );
    expect(tags.description).toBe("Book Nameless directly.");
  });

  it("uses the first photo as the image and asks for a large card", () => {
    const tags = buildPropertyOgTags(
      property({
        photos: [
          { url: "https://cdn.test/first.jpg" },
          { url: "https://cdn.test/second.jpg" },
        ],
      }),
    );
    expect(tags.image).toBe("https://cdn.test/first.jpg");
    expect(tags.twitterCard).toBe("summary_large_image");
  });

  it("asks for a small card and omits the image when there is no photo", () => {
    const tags = buildPropertyOgTags(property({ photos: [] }));
    expect(tags.image).toBeUndefined();
    expect(tags.twitterCard).toBe("summary");
  });
});
