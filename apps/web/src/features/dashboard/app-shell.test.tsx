import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { clearSession, setSession } from "../../lib/auth";
import {
  authResponse,
  json,
  propertyResponse,
  renderAt,
  stubFetch,
} from "../../test-utils";

/**
 * The dashboard shell (ADR-0037): sidebar + top bar + width-by-route + mobile
 * drawer. Rendered via the real route tree with a session in memory, so the
 * `/app` guard passes without a refresh round-trip.
 *
 * Stubbing `/sync-conflicts` + `/payments/lapsed` covers the badge for any page,
 * since the shell reads those two queries everywhere (use-inbox-count).
 */
beforeEach(() => {
  clearSession();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearSession();
});

describe("AppShell", () => {
  it("renders grouped nav, the account menu, and the inbox badge", async () => {
    setSession(authResponse({ user: { email: "owner@balibreeze.test" } }));
    stubFetch({
      "GET /api/properties": () => json([]),
      // Only the length matters for the badge, and we render /app/properties, so
      // these rows are never displayed - two conflicts + one lapsed payment = 3.
      "GET /api/sync-conflicts": () => json([{}, {}]),
      "GET /api/payments/lapsed": () => json([{}]),
    });
    renderAt("/app/properties");

    // Grouped nav.
    expect(await screen.findByText("Operate")).toBeInTheDocument();
    expect(screen.getByText("Manage")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /calendar/i })).toHaveAttribute(
      "href",
      "/app/calendar",
    );
    expect(screen.getByRole("link", { name: /reservations/i })).toHaveAttribute(
      "href",
      "/app/reservations",
    );
    expect(screen.getByRole("link", { name: /properties/i })).toHaveAttribute(
      "href",
      "/app/properties",
    );
    expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute(
      "href",
      "/app/settings",
    );

    // Inbox badge = 2 + 1.
    expect(
      await screen.findByLabelText("3 items need attention"),
    ).toBeInTheDocument();

    // Account menu surfaces the signed-in email + a log out action.
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.getByText("owner@balibreeze.test")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /log out/i }),
    ).toBeInTheDocument();
  });

  it("opens the mobile navigation drawer", async () => {
    setSession(authResponse());
    stubFetch({
      "GET /api/properties": () => json([]),
      "GET /api/sync-conflicts": () => json([]),
      "GET /api/payments/lapsed": () => json([]),
    });
    renderAt("/app/properties");
    await screen.findByText("Operate");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open navigation/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Navigation")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: /calendar/i }),
    ).toBeInTheDocument();
  });

  it("closes the mobile drawer when a nav link is tapped", async () => {
    setSession(authResponse());
    stubFetch({
      "GET /api/properties": () => json([]),
      "GET /api/units": () => json([]),
      "GET /api/bookings": () => json([]),
      "GET /api/sync-conflicts": () => json([]),
      "GET /api/payments/lapsed": () => json([]),
    });
    renderAt("/app/properties");
    await screen.findByText("Operate");

    fireEvent.click(screen.getByRole("button", { name: /open navigation/i }));
    const dialog = await screen.findByRole("dialog");

    // Tapping a nav link navigates; the route change must close the drawer.
    fireEvent.click(within(dialog).getByRole("link", { name: /reservations/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps Properties active on the property workbench (child route)", async () => {
    setSession(authResponse());
    // The property fetch 404s to "Property not found"; the nav active state is
    // computed from the path, not the page data, so no property stub is needed.
    stubFetch({
      "GET /api/sync-conflicts": () => json([]),
      "GET /api/payments/lapsed": () => json([]),
    });
    renderAt("/app/properties/11111111-1111-1111-1111-111111111111");
    await screen.findByText("Operate");

    const link = screen.getByRole("link", { name: /^properties$/i });
    expect(link.className).toContain("bg-accent");
  });

  it("portals a page's title + primary action into the top bar", async () => {
    setSession(authResponse());
    stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/sync-conflicts": () => json([]),
      "GET /api/payments/lapsed": () => json([]),
    });
    renderAt("/app/properties");

    const heading = await screen.findByRole("heading", { name: "Properties" });
    // Awaited, not synchronous: the header now portals in on the FIRST commit,
    // before the properties read lands (divergence D1 - the page used to withhold
    // its own header while loading, so this assertion used to pass by accident).
    expect(
      await screen.findByRole("button", { name: "New property" }),
    ).toBeInTheDocument();
    // It lives in the top bar (portaled), not inside the page content.
    expect(document.querySelector("main")?.contains(heading)).toBe(false);
  });

  it("caps a form page's width", async () => {
    setSession(authResponse());
    stubFetch({
      "GET /api/properties": () => json([]),
      "GET /api/sync-conflicts": () => json([]),
      "GET /api/payments/lapsed": () => json([]),
    });
    renderAt("/app/properties");
    await screen.findByText("Operate");

    const wrapper = document.querySelector("main > div");
    expect(wrapper?.className).toContain("max-w-5xl");
  });

  it("gives a data page full width", async () => {
    setSession(authResponse());
    stubFetch({
      "GET /api/properties": () => json([]),
      "GET /api/units": () => json([]),
      "GET /api/bookings": () => json([]),
      "GET /api/sync-conflicts": () => json([]),
      "GET /api/payments/lapsed": () => json([]),
    });
    renderAt("/app/calendar");
    await screen.findByText("Operate");

    const wrapper = document.querySelector("main > div");
    expect(wrapper?.className).not.toContain("max-w-5xl");
    expect(wrapper?.className).toContain("w-full");
  });
});
