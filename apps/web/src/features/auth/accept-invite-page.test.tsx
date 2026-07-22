import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { clearSession, getAccessToken } from "../../lib/auth";
import { authResponse, json, renderAt, stubFetch } from "../../test-utils";

const TOKEN = "aVeryLongRandomInviteToken_0123456789";
const PREVIEW_URL = `GET /api/auth/invites/token/${TOKEN}`;

const preview = {
  email: "chef@villa.dev",
  tenantName: "Bali Breeze Villas",
  propertyNames: ["Seminyak Beach Villa", "Ubud Cottage"],
  expiresAt: "2026-07-29T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

describe("accept invite page (§3.4, #57)", () => {
  it("shows who invited you and what you'll manage, then takes a password", async () => {
    const sent: unknown[] = [];
    stubFetch({
      [PREVIEW_URL]: () => json(preview),
      "POST /api/auth/invites/accept": (init) => {
        sent.push(JSON.parse(String(init?.body)));
        return json(
          authResponse({ user: { role: "staff", email: "chef@villa.dev" } }),
        );
      },
    });
    renderAt(`/invite/${TOKEN}`);

    expect(
      await screen.findByRole("heading", { name: "Join Bali Breeze Villas" }),
    ).toBeInTheDocument();
    expect(screen.getByText("chef@villa.dev")).toBeInTheDocument();
    expect(screen.getByText("Seminyak Beach Villa")).toBeInTheDocument();
    expect(screen.getByText("Ubud Cottage")).toBeInTheDocument();
    // The email is SHOWN, never asked for - the seat belongs to the address the
    // owner invited, and a holder must not be able to redirect it.
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "supersecret1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(sent).toEqual([{ token: TOKEN, password: "supersecret1" }]),
    );
    // Accepting IS signing in: the session is live without a trip through /login.
    await waitFor(() => expect(getAccessToken()).toBe("test-token"));
  });

  it("does not send a too-short password - the boundary is the shared schema", async () => {
    const calls = stubFetch({ [PREVIEW_URL]: () => json(preview) });
    renderAt(`/invite/${TOKEN}`);

    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText(/at least 8 character/i),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.includes("accept"))).toBe(false);
  });

  it("explains a spent invite with its reason, and offers sign-in", async () => {
    stubFetch({
      [PREVIEW_URL]: () =>
        json(
          {
            statusCode: 409,
            error: "Conflict",
            code: "invite_not_acceptable",
            reason: "accepted",
            message: "This invite can no longer be used",
          },
          409,
        ),
    });
    renderAt(`/invite/${TOKEN}`);

    // "Already used" gets a DIFFERENT next step from expired/revoked - which is
    // why the API sends a reason rather than one sentence (ADR-0012).
    expect(
      await screen.findByText(/already been used. Sign in with your email/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("falls back to generic copy for an unknown token (404, no oracle)", async () => {
    stubFetch({
      [PREVIEW_URL]: () =>
        json({ statusCode: 404, error: "Not Found", message: "Invite not found" }, 404),
    });
    renderAt(`/invite/${TOKEN}`);

    // A 404 must NOT reveal whether an invite ever existed, so the copy says
    // nothing about expiry or use - just "check your link".
    expect(
      await screen.findByText(/isn't valid\. Check the link in your email/),
    ).toBeInTheDocument();
  });

  it("shows no language switcher - it is an operator page, like the dashboard", async () => {
    stubFetch({ [PREVIEW_URL]: () => json(preview) });
    renderAt(`/invite/${TOKEN}`);

    await screen.findByRole("heading", { name: "Join Bali Breeze Villas" });
    expect(
      screen.queryByRole("button", { name: /bahasa|english|中文/i }),
    ).not.toBeInTheDocument();
  });
});
