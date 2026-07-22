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
  staffAuthResponse,
  stubFetch,
  tenantSettingsResponse,
} from "../../test-utils";

const VILLA = propertyResponse({
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  name: "Seminyak Beach Villa",
});
const COTTAGE = propertyResponse({
  id: "aaaaaaaa-0000-0000-0000-000000000002",
  name: "Ubud Cottage",
  slug: "ubud-cottage",
});

const baseStubs = {
  "GET /api/settings": () => json(tenantSettingsResponse()),
  "GET /api/properties": () => json([VILLA, COTTAGE]),
  "GET /api/staff": () => json({ staff: [] }),
  "GET /api/auth/invites": () => json({ invites: [] }),
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearSession();
});

describe("team settings (§4.7, #57)", () => {
  describe("as an owner", () => {
    beforeEach(() => setSession(authResponse()));

    it("invites a staff member scoped to chosen properties", async () => {
      const sent: unknown[] = [];
      stubFetch({
        ...baseStubs,
        "POST /api/auth/invites": (init) => {
          sent.push(JSON.parse(String(init?.body)));
          return json(
            {
              id: "dddddddd-0000-0000-0000-000000000001",
              email: "chef@villa.dev",
              expiresAt: "2026-07-29T00:00:00.000Z",
              createdAt: "2026-07-22T00:00:00.000Z",
              properties: [{ id: VILLA.id, name: VILLA.name }],
            },
            201,
          );
        },
      });
      renderAt("/app/settings");

      fireEvent.change(await screen.findByLabelText("Email address"), {
        target: { value: "chef@villa.dev" },
      });
      fireEvent.click(await screen.findByLabelText("Seminyak Beach Villa"));
      fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

      // Exactly the property that was ticked - not every property the owner has.
      await waitFor(() =>
        expect(sent).toEqual([
          { email: "chef@villa.dev", propertyIds: [VILLA.id] },
        ]),
      );
      expect(
        await screen.findByText(/Invite emailed to chef@villa.dev/),
      ).toBeInTheDocument();
    });

    it("renders our own copy for a duplicate invite, not the server's sentence", async () => {
      // ADR-0012: the API sends a code, the web owns the words.
      stubFetch({
        ...baseStubs,
        "POST /api/auth/invites": () =>
          json(
            {
              statusCode: 409,
              error: "Conflict",
              code: "invite_already_pending",
              message: "An invite for this email is already pending",
            },
            409,
          ),
      });
      renderAt("/app/settings");

      fireEvent.change(await screen.findByLabelText("Email address"), {
        target: { value: "chef@villa.dev" },
      });
      fireEvent.click(await screen.findByLabelText("Ubud Cottage"));
      fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

      expect(
        await screen.findByText("An invite for this email is already pending"),
      ).toBeInTheDocument();
    });

    it("lists staff with their assignments and re-assigns them as a whole set", async () => {
      const sent: unknown[] = [];
      stubFetch({
        ...baseStubs,
        "GET /api/staff": () =>
          json({
            staff: [
              {
                id: "33333333-3333-3333-3333-333333333333",
                email: "chef@villa.dev",
                createdAt: "2026-07-01T00:00:00.000Z",
                properties: [{ id: VILLA.id, name: VILLA.name }],
              },
            ],
          }),
        "PATCH /api/staff/33333333-3333-3333-3333-333333333333": (init) => {
          sent.push(JSON.parse(String(init?.body)));
          return json({
            id: "33333333-3333-3333-3333-333333333333",
            email: "chef@villa.dev",
            createdAt: "2026-07-01T00:00:00.000Z",
            properties: [{ id: COTTAGE.id, name: COTTAGE.name }],
          });
        },
      });
      renderAt("/app/settings");

      expect(await screen.findByText("chef@villa.dev")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Change access" }));
      // Scoped to the staff row's own fieldset: the invite form above has
      // checkboxes with the SAME property names, and an unscoped query would
      // silently tick the wrong one (which is also why that fieldset has a
      // legend).
      const row = within(
        await screen.findByRole("group", {
          name: "Properties chef@villa.dev can manage",
        }),
      );
      // Untick the old, tick the new: the request carries the RESULTING set, so
      // this is also how access is taken away - there is no "unassign" verb.
      fireEvent.click(row.getByLabelText("Seminyak Beach Villa"));
      fireEvent.click(row.getByLabelText("Ubud Cottage"));
      fireEvent.click(screen.getByRole("button", { name: "Save access" }));

      await waitFor(() =>
        expect(sent).toEqual([{ propertyIds: [COTTAGE.id] }]),
      );
    });

    it("refuses to save an empty assignment set, and says what to do instead", async () => {
      // The API rejects it too (min 1). Surfacing it here means the owner is told
      // "remove them" rather than watching a 400 they can't act on.
      const calls = stubFetch({
        ...baseStubs,
        "GET /api/staff": () =>
          json({
            staff: [
              {
                id: "33333333-3333-3333-3333-333333333333",
                email: "chef@villa.dev",
                createdAt: "2026-07-01T00:00:00.000Z",
                properties: [{ id: VILLA.id, name: VILLA.name }],
              },
            ],
          }),
      });
      renderAt("/app/settings");

      fireEvent.click(await screen.findByRole("button", { name: "Change access" }));
      const row = within(
        await screen.findByRole("group", {
          name: "Properties chef@villa.dev can manage",
        }),
      );
      fireEvent.click(row.getByLabelText("Seminyak Beach Villa"));

      expect(
        screen.getByText(/Pick at least one property, or remove them instead/),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save access" })).toBeDisabled();
      expect(calls.some((c) => c.startsWith("PATCH"))).toBe(false);
    });

    it("asks before removing a staff account", async () => {
      const confirm = vi.fn().mockReturnValue(false);
      vi.stubGlobal("confirm", confirm);
      const calls = stubFetch({
        ...baseStubs,
        "GET /api/staff": () =>
          json({
            staff: [
              {
                id: "33333333-3333-3333-3333-333333333333",
                email: "chef@villa.dev",
                createdAt: "2026-07-01T00:00:00.000Z",
                properties: [],
              },
            ],
          }),
      });
      renderAt("/app/settings");

      fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
      expect(confirm).toHaveBeenCalled();
      // Declined: nothing was sent. Losing a colleague's account to a stray
      // click is not recoverable with another click.
      expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    });

    it("revokes a pending invite", async () => {
      const calls = stubFetch({
        ...baseStubs,
        "GET /api/auth/invites": () =>
          json({
            invites: [
              {
                id: "dddddddd-0000-0000-0000-000000000001",
                email: "chef@villa.dev",
                expiresAt: "2026-07-29T00:00:00.000Z",
                createdAt: "2026-07-22T00:00:00.000Z",
                properties: [{ id: VILLA.id, name: VILLA.name }],
              },
            ],
          }),
        "DELETE /api/auth/invites/dddddddd-0000-0000-0000-000000000001": () =>
          new Response(null, { status: 204 }),
      });
      renderAt("/app/settings");

      fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
      await waitFor(() =>
        expect(
          calls.some((c) =>
            c.startsWith(
              "DELETE /api/auth/invites/dddddddd-0000-0000-0000-000000000001",
            ),
          ),
        ).toBe(true),
      );
    });
  });

  describe("as staff", () => {
    beforeEach(() => setSession(staffAuthResponse()));

    it("sees the section explained, not an invite form that would 403", async () => {
      const calls = stubFetch(baseStubs);
      renderAt("/app/settings");

      expect(
        await screen.findByText(
          /Only an account owner can invite staff or change who can see which properties/,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
      // ...and it does not even ask for data it may not have: the owner-only
      // reads are never issued, so the console has no stray 403s in it.
      expect(calls.some((c) => c.includes("/api/staff"))).toBe(false);
      expect(calls.some((c) => c.includes("/api/auth/invites"))).toBe(false);
    });
  });
});
