import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { clearSession, setSession } from "../../lib/auth";
import {
  authResponse,
  json,
  renderAt,
  stubFetch,
  tenantSettingsResponse,
} from "../../test-utils";

beforeEach(() => {
  setSession(authResponse());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

describe("settings page (§4.7, #67)", () => {
  it("shows the tenant's current cap and its bounds", async () => {
    stubFetch({
      "GET /api/settings": () =>
        json(tenantSettingsResponse({ galleryCap: 12, galleryCeiling: 100 })),
    });
    renderAt("/app/settings");

    const input = await screen.findByLabelText("Photos per property");
    expect(input).toHaveValue(12);
    expect(input).toHaveAttribute("max", "100");
    expect(screen.getByText(/Between 1 and 100/)).toBeInTheDocument();
  });

  it("says out loud that lowering the cap deletes nothing", async () => {
    stubFetch({ "GET /api/settings": () => json(tenantSettingsResponse()) });
    renderAt("/app/settings");

    expect(
      await screen.findByText(/Lowering this never deletes photos/),
    ).toBeInTheDocument();
  });

  it("PATCHes the new cap and paints the server's answer", async () => {
    const sent: unknown[] = [];
    stubFetch({
      "GET /api/settings": () =>
        json(tenantSettingsResponse({ galleryCap: 30 })),
      "PATCH /api/settings": (init) => {
        const body = JSON.parse(String(init?.body)) as { galleryCap: number };
        sent.push(body);
        return json(tenantSettingsResponse({ galleryCap: body.galleryCap }));
      },
    });
    renderAt("/app/settings");

    const input = await screen.findByLabelText("Photos per property");
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(sent).toEqual([{ galleryCap: 60 }]));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(await screen.findByLabelText("Photos per property")).toHaveValue(60);
  });

  it("refuses a cap over the ceiling client-side, without a request", async () => {
    const calls = stubFetch({
      "GET /api/settings": () =>
        json(tenantSettingsResponse({ galleryCeiling: 100 })),
    });
    renderAt("/app/settings");

    const input = await screen.findByLabelText("Photos per property");
    fireEvent.change(input, { target: { value: "101" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The shared schema is the same one the API validates with, so the message
    // and the boundary agree by construction.
    await waitFor(() =>
      expect(screen.getByLabelText("Photos per property")).toBeInvalid(),
    );
    expect(calls.filter((c) => c.startsWith("PATCH"))).toHaveLength(0);
  });

  it("shows staff a read-only view - the write is the owner's", async () => {
    const staff = authResponse();
    setSession({ ...staff, user: { ...staff.user, role: "staff" } });
    stubFetch({
      "GET /api/settings": () =>
        json(tenantSettingsResponse({ galleryCap: 25 })),
    });
    renderAt("/app/settings");

    expect(
      await screen.findByText(/up to 25 photos\. Only an account owner/),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Photos per property"),
    ).not.toBeInTheDocument();
  });
});
