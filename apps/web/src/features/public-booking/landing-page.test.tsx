import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderAt } from "../../test-utils";

afterEach(cleanup);

/**
 * The landing page replaces the M0 scaffold at `/` (#60 follow-up). It calls no
 * API, so this renders the real route tree and asserts the hero + that an owner
 * is routed to auth and a reviewer to a live demo. EN is the default locale.
 */
describe("LandingPage", () => {
  it("renders the hero and routes to auth + a live demo", async () => {
    renderAt("/");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: /commission-free direct bookings/i,
      }),
    ).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /log in/i })).toHaveAttribute(
      "href",
      "/login",
    );

    // "Get started" appears in the nav and the hero; both must reach /register.
    const getStarted = screen.getAllByRole("link", { name: /get started/i });
    expect(getStarted.length).toBeGreaterThanOrEqual(1);
    for (const link of getStarted) {
      expect(link).toHaveAttribute("href", "/register");
    }

    expect(
      screen.getByRole("link", { name: /view a live demo/i }),
    ).toHaveAttribute("href", "/p/seminyak-beach-villa");
  });

  it("shows the five hard parts", async () => {
    renderAt("/");

    expect(
      await screen.findByRole("heading", {
        level: 3,
        name: /no double-booking, ever/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: /multi-tenant isolation/i }),
    ).toBeInTheDocument();
  });
});
