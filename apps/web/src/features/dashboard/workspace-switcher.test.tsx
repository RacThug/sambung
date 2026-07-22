import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { clearSession, getSession, setSession } from "../../lib/auth";
import { authResponse, json, renderAt, stubFetch } from "../../test-utils";

const OTHER_TENANT = "44444444-4444-4444-4444-444444444444";

/** The session of someone seated at two villa owners (#154). */
function twoSeats() {
  return authResponse({
    user: { role: "staff" },
    memberships: [
      {
        tenantId: "22222222-2222-2222-2222-222222222222",
        tenantName: "Test Tenant",
        role: "staff",
      },
      { tenantId: OTHER_TENANT, tenantName: "Ubud Retreats", role: "staff" },
    ],
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

describe("workspace switcher (#154)", () => {
  it("stays a plain label for the ordinary one-seat account", async () => {
    stubFetch({ "GET /api/properties": () => json([]) });
    setSession(authResponse());
    renderAt("/app/properties");

    // A control whose menu can only ever hold one option is chrome pretending to
    // be a feature, so there is no <select> at all.
    expect(await screen.findByText("Test Tenant")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("switches tenant, and the next read is scoped to the new one", async () => {
    const propertyCalls: string[] = [];
    let switched = false;
    stubFetch({
      "GET /api/properties": () => {
        propertyCalls.push(switched ? "after" : "before");
        return json(
          switched
            ? [{ id: "p-ubud", name: "Ubud Jungle Villa" }]
            : [{ id: "p-seminyak", name: "Seminyak Beach Villa" }],
        );
      },
      "POST /api/auth/session": (init) => {
        const body = JSON.parse(String(init?.body)) as { tenantId: string };
        switched = true;
        const next = twoSeats();
        return json({
          ...next,
          accessToken: "switched-token",
          user: { ...next.user, tenantId: body.tenantId },
          tenant: { id: body.tenantId, name: "Ubud Retreats" },
        });
      },
    });
    setSession(twoSeats());
    renderAt("/app/properties");

    expect(await screen.findByText("Seminyak Beach Villa")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: OTHER_TENANT },
    });

    // The session really moved - a later request carries the new token, and RLS
    // on the server does the rest (ADR-0032).
    await waitFor(() =>
      expect(getSession()?.tenant.id).toBe(OTHER_TENANT),
    );
    // ...and the cache was cleared rather than left to render the old tenant's
    // rows under the new tenant's name, so the list is fetched again.
    await waitFor(() =>
      expect(screen.getByText("Ubud Jungle Villa")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Seminyak Beach Villa")).not.toBeInTheDocument();
    expect(propertyCalls).toEqual(["before", "after"]);
  });
});
