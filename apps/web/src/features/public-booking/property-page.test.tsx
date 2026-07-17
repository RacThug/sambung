import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { json, publicPropertyResponse, renderAt, stubFetch } from "../../test-utils";

beforeEach(() => stubFetch({}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = (slug: string, body: unknown, status = 200) =>
  stubFetch({
    [`GET /api/public/properties/${slug}`]: () => json(body, status),
  });

// The public property page (page-spec §3.1, FR-PROP-1/3, #46).
describe("property page", () => {
  it("renders the villa: gallery, name, address, description, rooms", async () => {
    at(
      "seminyak-beach-villa",
      publicPropertyResponse({
        name: "Seminyak Beach Villa",
        address: "Jl. Kayu Aya, Seminyak",
        description: "Two-bedroom villa steps from the beach.",
        photos: [{ url: "https://cdn.test/hero.jpg" }],
        units: [{ name: "Whole Villa", basePriceIdr: 3_500_000, maxGuests: 4 }],
      }),
    );
    renderAt("/p/seminyak-beach-villa");

    expect(
      await screen.findByRole("heading", { name: "Seminyak Beach Villa" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Jl. Kayu Aya, Seminyak")).toBeInTheDocument();
    expect(
      screen.getByText("Two-bedroom villa steps from the beach."),
    ).toBeInTheDocument();
    expect(screen.getByText("Whole Villa")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /main photo/ })).toHaveAttribute(
      "src",
      "https://cdn.test/hero.jpg",
    );
  });

  it("formats price in rupiah, the Indonesian way (page-spec §2)", async () => {
    at(
      "villa",
      publicPropertyResponse({
        units: [{ name: "Whole Villa", basePriceIdr: 3_500_000 }],
      }),
    );
    renderAt("/p/villa");
    // Dots, not commas - and never a float.
    expect(await screen.findByText("Rp 3.500.000")).toBeInTheDocument();
    expect(screen.getByText("/ night")).toBeInTheDocument();
  });

  it("shows the Verified badge only when the licence is on file (FR-PROP-3)", async () => {
    at("villa", publicPropertyResponse({ verified: true }));
    renderAt("/p/villa");
    expect(await screen.findByText(/Verified/)).toBeInTheDocument();
  });

  it("hides the badge when the property is not verified", async () => {
    at("villa", publicPropertyResponse({ verified: false, name: "Plain" }));
    renderAt("/p/villa");
    await screen.findByRole("heading", { name: "Plain" });
    expect(screen.queryByText(/Verified/)).not.toBeInTheDocument();
  });

  it("404s an unknown slug with a page that explains itself", async () => {
    at("nope", { statusCode: 404, message: "Property not found" }, 404);
    renderAt("/p/nope");
    expect(
      await screen.findByRole("heading", { name: /doesn’t exist/ }),
    ).toBeInTheDocument();
  });

  /**
   * ADR-0004: publishable never gates the page, so a villa with no photos and
   * no priced unit is a state a real guest can land on. It must look
   * deliberate, not broken.
   */
  it("renders a bare property without a gallery rather than a broken frame", async () => {
    at(
      "bare",
      publicPropertyResponse({ name: "Bare Villa", photos: [], units: [] }),
    );
    renderAt("/p/bare");
    await screen.findByRole("heading", { name: "Bare Villa" });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/No rooms are listed yet/)).toBeInTheDocument();
  });

  it("says 'price on request' for a placeholder unit, never 'Rp 0'", async () => {
    // A zero price is storable on purpose (api-spec §4.6) - it's a placeholder,
    // not an offer. Quoting it would read as free.
    at(
      "villa",
      publicPropertyResponse({
        units: [{ name: "Unpriced Room", basePriceIdr: 0 }],
      }),
    );
    renderAt("/p/villa");
    expect(await screen.findByText("Price on request")).toBeInTheDocument();
    expect(screen.queryByText("Rp 0")).not.toBeInTheDocument();
  });

  it("sets per-property title and OG tags (SEO tier 1, architecture §6)", async () => {
    at(
      "seminyak-beach-villa",
      publicPropertyResponse({
        name: "Seminyak Beach Villa",
        description: "Steps from the beach.",
        photos: [{ url: "https://cdn.test/hero.jpg" }],
      }),
    );
    renderAt("/p/seminyak-beach-villa");
    await screen.findByRole("heading", { name: "Seminyak Beach Villa" });

    // React 19 hoists these into <head> itself - no react-helmet.
    expect(document.title).toBe("Seminyak Beach Villa - Book direct");
    const og = (p: string) =>
      document.head
        .querySelector(`meta[property="og:${p}"]`)
        ?.getAttribute("content");
    expect(og("title")).toBe("Seminyak Beach Villa - Book direct");
    expect(og("description")).toBe("Steps from the beach.");
    expect(og("image")).toBe("https://cdn.test/hero.jpg");
  });

  it("falls back to the address when the owner wrote no description", async () => {
    at(
      "villa",
      publicPropertyResponse({
        name: "Quiet Villa",
        description: null,
        address: "Jl. Test 1",
      }),
    );
    renderAt("/p/villa");
    await screen.findByRole("heading", { name: "Quiet Villa" });
    expect(
      document.head
        .querySelector('meta[name="description"]')
        ?.getAttribute("content"),
    ).toBe("Book Quiet Villa directly - Jl. Test 1");
  });

  it("asks for a small card when there is no photo to show", async () => {
    // summary_large_image with no image renders an empty frame in the preview.
    at("villa", publicPropertyResponse({ photos: [], name: "No Photo Villa" }));
    renderAt("/p/villa");
    await screen.findByRole("heading", { name: "No Photo Villa" });
    expect(
      document.head
        .querySelector('meta[name="twitter:card"]')
        ?.getAttribute("content"),
    ).toBe("summary");
  });
});
