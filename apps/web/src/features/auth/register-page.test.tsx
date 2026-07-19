import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { RegisterRequest } from "@sambung/shared";
import { clearSession } from "../../lib/auth";
import {
  authResponse,
  json,
  propertyResponse as property,
  renderAt,
  stubFetch,
} from "../../test-utils";

// Exact labels: FormField keeps the error out of the <label> (a sibling <p>
// wired by aria-describedby), so a rendered error no longer mutates the input's
// accessible name and "Email" keeps matching even after a submit fails (#71).
function fillForm(overrides: Partial<RegisterRequest> = {}) {
  fireEvent.change(screen.getByLabelText("Business name"), {
    target: { value: overrides.tenantName ?? "Bali Villas Co" },
  });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: overrides.email ?? "owner@test.dev" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: overrides.password ?? "s3cret-pass" },
  });
}

beforeEach(() => {
  clearSession();
  stubFetch({});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("register page (§3.4)", () => {
  it("renders the signup form at /register", async () => {
    renderAt("/register");
    expect(
      await screen.findByText("Create your owner account"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Business name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("signs up, starts the session, and lands in the dashboard", async () => {
    const calls = stubFetch({
      "POST /api/auth/register": (init) => {
        // The API receives exactly the shared-schema shape, no extras.
        expect(JSON.parse(String(init?.body))).toEqual({
          tenantName: "Bali Villas Co",
          email: "owner@test.dev",
          password: "s3cret-pass",
        });
        return json(authResponse(), 201);
      },
      "GET /api/properties": () => json([]),
    });
    const router = renderAt("/register");

    await screen.findByText("Create your owner account");
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    // No second login step: the signup response IS the session. The dashboard
    // home is the unified calendar now (#49).
    expect(await screen.findByText("Test Tenant")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/app/calendar");
    expect(calls.filter((c) => c === "POST /api/auth/register")).toHaveLength(1);
  });

  it("honors ?next after signup, same as /login", async () => {
    const row = property({});
    stubFetch({
      "POST /api/auth/register": () => json(authResponse(), 201),
      [`GET /api/properties/${row.id}`]: () => json(row),
    });
    const router = renderAt(`/register?next=/app/properties/${row.id}`);

    await screen.findByText("Create your owner account");
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Details")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/app/properties/${row.id}`);
  });

  it("maps client-side validation errors to their fields without calling the API", async () => {
    const calls = stubFetch({});
    renderAt("/register");

    await screen.findByText("Create your owner account");
    fillForm({ tenantName: "x", email: "not-an-email", password: "short" });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    // One message per field, in schema order: name min(2), email format,
    // password min(8). (registerRequestSchema)
    expect(
      await screen.findByText(/at least 2 character/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/invalid email/i)).toBeInTheDocument();
    expect(screen.getByText(/at least 8 character/i)).toBeInTheDocument();
    expect(calls).not.toContain("POST /api/auth/register");
  });

  it("renders a duplicate-email 409 on the email field", async () => {
    stubFetch({
      "POST /api/auth/register": () =>
        json(
          {
            statusCode: 409,
            message: "Email already registered",
            error: "Conflict",
          },
          409,
        ),
    });
    const router = renderAt("/register");

    await screen.findByText("Create your owner account");
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    const error = await screen.findByText("Email already registered");
    const emailInput = screen.getByLabelText("Email");
    // On the email field, not a generic banner - and wired as a *description*,
    // never folded into the accessible name (#71). The input stays reachable by
    // its exact label, is marked invalid, and points at this error.
    expect(emailInput).toHaveAttribute("type", "email");
    expect(emailInput).toHaveAttribute("aria-invalid", "true");
    expect(emailInput).toHaveAccessibleName("Email");
    expect(emailInput).toHaveAccessibleDescription("Email already registered");
    expect(emailInput.getAttribute("aria-describedby")).toBe(error.id);
    expect(router.state.location.pathname).toBe("/register");
  });

  it("clears a stale 409 when a resubmit fails client-side validation", async () => {
    stubFetch({
      "POST /api/auth/register": () =>
        json(
          {
            statusCode: 409,
            message: "Email already registered",
            error: "Conflict",
          },
          409,
        ),
    });
    renderAt("/register");

    await screen.findByText("Create your owner account");
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText("Email already registered");

    // The user retypes the email but gets it wrong; the old 409 no longer
    // describes what's in the field and must give way to the zod message.
    fillForm({ email: "not-an-email" });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText(/invalid email/i)).toBeInTheDocument();
    expect(
      screen.queryByText("Email already registered"),
    ).not.toBeInTheDocument();
  });

  it("shows a generic retry message for other server errors", async () => {
    stubFetch({
      "POST /api/auth/register": () =>
        json({ statusCode: 500, message: "Internal server error" }, 500),
    });
    renderAt("/register");

    await screen.findByText("Create your owner account");
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText("Something went wrong - please try again"),
    ).toBeInTheDocument();
  });

  it("cross-links with /login, carrying ?next both ways", async () => {
    const router = renderAt("/register?next=/app/properties");

    await screen.findByText("Create your owner account");
    fireEvent.click(screen.getByRole("link", { name: "Sign in" }));

    await screen.findByText("Sign in to your dashboard");
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ next: "/app/properties" });

    fireEvent.click(screen.getByRole("link", { name: "Create an account" }));

    await screen.findByText("Create your owner account");
    expect(router.state.location.pathname).toBe("/register");
    expect(router.state.location.search).toEqual({ next: "/app/properties" });
  });
});
