import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  json,
  publicPropertyResponse,
  renderAt,
  stubFetch,
} from "../../test-utils";

/**
 * Checkout resilience when the lazily-loaded phone chunk fails to fetch (#125
 * review). libphonenumber-js lives in its own chunk pulled at the phone step
 * (ADR-0023); a network blip mid-funnel makes that `import()` reject. A throwing
 * module mock reproduces exactly that - any import of `./phone` rejects - so we
 * can assert the checkout degrades to a Retry affordance instead of stranding the
 * guest on a disabled "Loading…" select with an unhandled rejection at submit.
 *
 * This mock is file-scoped, so it lives apart from checkout-page.test.tsx (whose
 * happy-path cases need the real phone kit).
 */
vi.mock("./phone", () => {
  throw new Error("Failed to fetch dynamically imported module: phone.ts");
});

const UNIT_ID = "bbbbbbbb-0000-0000-0000-000000000001";

const availableQuote = {
  available: true,
  nights: 3,
  totalPriceIdr: 3_600_000,
  minStay: 1,
  reasons: [],
  blockedRanges: [],
};

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign: vi.fn(), href: "http://localhost/", origin: "http://localhost" },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("checkout page - phone chunk load failure", () => {
  it("shows a Retry affordance and keeps submit safe when the phone chunk fails to load", async () => {
    const calls = stubFetch({
      "GET /api/public/properties/villa": () =>
        json(publicPropertyResponse({ slug: "villa" })),
      [`GET /api/public/units/${UNIT_ID}/availability`]: () =>
        json(availableQuote),
    });

    renderAt(`/p/villa/book?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);
    // The page still renders its stay + price; only the phone kit failed.
    await screen.findByText("Rp 3.600.000");

    // The failed load surfaces as a retry, not a permanent "Loading…".
    expect(
      await screen.findByText(/couldn't load the country list/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

    // Submitting must not throw an unhandled rejection or send a create request
    // (there is no valid phone kit to assemble E.164 with).
    fireEvent.change(screen.getByLabelText(/full name/i), {
      target: { value: "Made A." },
    });
    fireEvent.change(screen.getByLabelText(/whatsapp number/i), {
      target: { value: "0812 3456 7890" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /continue to payment/i }),
    );

    // Let the async submit settle; the retry affordance stays and no POST fires.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /retry/i }),
      ).toBeInTheDocument(),
    );
    expect(calls).not.toContain("POST /api/public/bookings");
  });
});
