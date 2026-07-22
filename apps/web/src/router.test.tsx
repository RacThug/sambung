import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { propertySearchSchema } from "./features/public-booking/property-search";
import { authSearchSchema } from "./features/auth/auth-search";
import { clearSession, setSession } from "./lib/auth";
import {
  authResponse,
  json,
  publicPropertyResponse,
  renderAt,
  stubFetch,
} from "./test-utils";

beforeEach(() => {
  clearSession();
  stubFetch({});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("route tree", () => {
  it("renders the home page at /", async () => {
    renderAt("/");
    // The wordmark is the lowercase brand lockup (design-system.md §1).
    expect(await screen.findByText("sambung")).toBeInTheDocument();
  });

  it("renders the property page at /p/$slug from the slug in the URL", async () => {
    stubFetch({
      "GET /api/public/properties/villa-sunset": () =>
        json(publicPropertyResponse({ name: "Villa Sunset" })),
    });
    renderAt("/p/villa-sunset?from=2026-08-01&to=2026-08-05");
    expect(
      await screen.findByRole("heading", { name: "Villa Sunset" }),
    ).toBeInTheDocument();
  });

  it("drops malformed date params instead of crashing the funnel", async () => {
    // .catch(undefined) in the search schema: a deep link with a typo'd date
    // must still open the villa, not an error page.
    stubFetch({
      "GET /api/public/properties/villa-sunset": () =>
        json(publicPropertyResponse({ name: "Villa Sunset" })),
    });
    renderAt("/p/villa-sunset?from=not-a-date&to=2026-08-05");
    expect(
      await screen.findByRole("heading", { name: "Villa Sunset" }),
    ).toBeInTheDocument();
  });

  it("renders the login page at /login", async () => {
    renderAt("/login");
    expect(
      await screen.findByText("Sign in to your dashboard"),
    ).toBeInTheDocument();
  });

  it("renders the register page at /register", async () => {
    renderAt("/register");
    expect(
      await screen.findByText("Create your owner account"),
    ).toBeInTheDocument();
  });

  it("renders the accept-invite page at /invite/$token, unauthenticated", async () => {
    // Public on purpose (#57): the invitee has no account yet, so the token in
    // the path IS the credential. No session, no redirect to /login.
    stubFetch({
      "GET /api/auth/invites/token/abc123": () =>
        json({
          email: "chef@villa.dev",
          tenantName: "Bali Breeze Villas",
          propertyNames: ["Seminyak Beach Villa"],
          expiresAt: "2026-07-29T00:00:00.000Z",
        }),
    });
    renderAt("/invite/abc123");
    expect(
      await screen.findByRole("heading", { name: "Join Bali Breeze Villas" }),
    ).toBeInTheDocument();
  });
});

describe("auth guard (/app/*)", () => {
  it("bounces to /login with ?next when no session can be restored", async () => {
    // The guard's one silent refresh fails → redirect. (page-spec §2)
    stubFetch({
      "POST /api/auth/refresh": () => json({ statusCode: 401 }, 401),
    });
    const router = renderAt("/app/properties");
    expect(
      await screen.findByText("Sign in to your dashboard"),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ next: "/app/properties" });
  });

  it("restores the session via refresh and renders the dashboard shell", async () => {
    stubFetch({
      "POST /api/auth/refresh": () => json(authResponse()),
      "GET /api/properties": () => json([]),
    });
    renderAt("/app/properties");
    expect(await screen.findByText("Test Tenant")).toBeInTheDocument();
    expect(
      await screen.findByText("Add your first property"),
    ).toBeInTheDocument();
  });

  it("redirects /app to the calendar (the dashboard home)", async () => {
    setSession(authResponse());
    stubFetch({ "GET /api/properties": () => json([]) });
    const router = renderAt("/app");
    // The calendar toolbar renders regardless of the body's data state.
    await screen.findByText("Today");
    expect(router.state.location.pathname).toBe("/app/calendar");
  });

  it("redirects an already-authed visitor away from /login", async () => {
    setSession(authResponse());
    stubFetch({ "GET /api/properties": () => json([]) });
    const router = renderAt("/login");
    await screen.findByText("Test Tenant");
    expect(router.state.location.pathname).toBe("/app/calendar");
  });

  it("skips the login form when the refresh cookie still holds a session", async () => {
    // No token in memory (fresh reload), but /auth/refresh succeeds.
    stubFetch({
      "POST /api/auth/refresh": () => json(authResponse()),
      "GET /api/properties": () => json([]),
    });
    const router = renderAt("/login");
    await screen.findByText("Test Tenant");
    expect(router.state.location.pathname).toBe("/app/calendar");
  });

  it("redirects an already-authed visitor away from /register", async () => {
    setSession(authResponse());
    stubFetch({ "GET /api/properties": () => json([]) });
    const router = renderAt("/register");
    await screen.findByText("Test Tenant");
    expect(router.state.location.pathname).toBe("/app/calendar");
  });

  it("skips the register form when the refresh cookie still holds a session", async () => {
    stubFetch({
      "POST /api/auth/refresh": () => json(authResponse()),
      "GET /api/properties": () => json([]),
    });
    const router = renderAt("/register");
    await screen.findByText("Test Tenant");
    expect(router.state.location.pathname).toBe("/app/calendar");
  });
});

describe("propertySearchSchema", () => {
  it("passes through valid ISO dates", () => {
    expect(
      propertySearchSchema.parse({ from: "2026-08-01", to: "2026-08-05" }),
    ).toEqual({ from: "2026-08-01", to: "2026-08-05" });
  });

  it("degrades malformed values to undefined instead of throwing", () => {
    expect(
      propertySearchSchema.parse({ from: "01/08/2026", to: 42 }),
    ).toEqual({ from: undefined, to: undefined });
  });

  it("accepts missing params", () => {
    expect(propertySearchSchema.parse({})).toEqual({});
  });
});

describe("authSearchSchema", () => {
  it("keeps same-app paths", () => {
    expect(authSearchSchema.parse({ next: "/app/properties" })).toEqual({
      next: "/app/properties",
    });
  });

  it("drops absolute URLs and protocol-relative paths (open redirect)", () => {
    expect(authSearchSchema.parse({ next: "https://evil.example" })).toEqual(
      {},
    );
    expect(authSearchSchema.parse({ next: "//evil.example" })).toEqual({});
  });
});
