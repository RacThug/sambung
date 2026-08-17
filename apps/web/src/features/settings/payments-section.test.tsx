import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { PaymentCredentialStatusResponse } from "@sambung/shared";
import { clearSession, setSession } from "../../lib/auth";
import {
  authResponse,
  json,
  renderAt,
  stubFetch,
  type FetchStubs,
} from "../../test-utils";

const credentialStatus = (
  overrides: Partial<PaymentCredentialStatusResponse> = {},
): PaymentCredentialStatusResponse => ({
  provider: "midtrans",
  environment: "sandbox",
  configuredAt: "2026-08-17T03:00:00.000Z",
  lastVerifyStatus: "ok",
  lastVerifyAt: "2026-08-17T03:00:01.000Z",
  ...overrides,
});

/** The settings page fetches settings + (owner-only) staff, invites, properties,
 * and payment credentials. */
function stubSettingsPage(
  extra: FetchStubs = {},
  credentials: PaymentCredentialStatusResponse[] = [],
) {
  return stubFetch({
    "GET /api/settings": () => json({ galleryCap: 30, galleryCeiling: 100 }),
    "GET /api/staff": () => json({ staff: [] }),
    "GET /api/auth/invites": () => json({ invites: [] }),
    "GET /api/properties": () => json([]),
    "GET /api/settings/payment-credentials": () => json(credentials),
    ...extra,
  });
}

beforeEach(() => {
  setSession(authResponse());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

describe("payments section (REQ-PA-04, /app/settings)", () => {
  it("shows the honest not-configured state and saves a key via PUT", async () => {
    let putBody: unknown;
    stubSettingsPage({
      "PUT /api/settings/payment-credentials/midtrans": (init) => {
        putBody = JSON.parse(String(init?.body));
        return json(credentialStatus());
      },
    });
    renderAt("/app/settings");

    expect(
      await screen.findByText(/no key saved yet - online checkout is off/i),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Server key"), {
      target: { value: "SB-Mid-server-abc123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toEqual({
      serverKey: "SB-Mid-server-abc123",
      environment: "sandbox",
    });
    // Write-only hygiene: the pasted key does not linger in the input. (The
    // label stays "Server key" here because the stubbed refetch still returns
    // an empty list - `configured` follows the LIST, not the mutation.)
    await waitFor(() =>
      expect(screen.getByLabelText("Server key")).toHaveValue(""),
    );
  });

  it("renders a configured credential's status - and never any key material", async () => {
    stubSettingsPage({}, [
      credentialStatus({ environment: "production", lastVerifyStatus: "ok" }),
    ]);
    renderAt("/app/settings");

    expect(await screen.findByText(/midtrans · production/i)).toBeInTheDocument();
    expect(screen.getByText(/key checked/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Replace key" }),
    ).toBeInTheDocument();
  });

  it("a failed save-time verification is loud, not hidden", async () => {
    stubSettingsPage({}, [credentialStatus({ lastVerifyStatus: "failed" })]);
    renderAt("/app/settings");

    expect(await screen.findByText("key check failed")).toBeInTheDocument();
    expect(
      screen.getByText(/didn’t verify against Midtrans/i),
    ).toBeInTheDocument();
  });

  it("staff see no Payments section at all, and its read is never issued", async () => {
    setSession(authResponse({ user: { role: "staff" } }));
    const calls = stubSettingsPage();
    renderAt("/app/settings");

    // The page rendered (the cap sentence is the staff view of Photos)...
    expect(
      await screen.findByText(/only an account owner can change this/i),
    ).toBeInTheDocument();
    // ...but Payments is absent in both senses: no heading, no request.
    expect(screen.queryByText("Payments")).not.toBeInTheDocument();
    expect(calls).not.toContain("GET /api/settings/payment-credentials");
  });
});
