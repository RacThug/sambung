import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { setSession, clearSession } from "../../lib/auth";
import {
  authResponse,
  json,
  minutesAgo,
  propertyResponse,
  renderAt,
  stubFetch,
  syncHealthResponse,
  unitResponse,
} from "../../test-utils";

// A booking row as the wire delivers it - a plain object (api-client doesn't
// re-parse), so no Rupiah-branding ceremony here.
const bookingRow = (over: Record<string, unknown> = {}) => ({
  id: "cccccccc-0000-0000-0000-000000000001",
  unitId: unitResponse().id,
  source: "direct",
  status: "confirmed",
  checkIn: "2027-03-10",
  checkOut: "2027-03-15",
  guestName: "Wayan Test",
  guestCount: 2,
  holdExpiresAt: null,
  totalPriceIdr: 6_000_000,
  ...over,
});

// A fixed window in the URL makes the /bookings request deterministic, regardless
// of what month "today" is when the suite runs.
const CAL_URL = "/app/calendar?from=2027-03-01&to=2027-04-01";
const BOOKINGS_KEY =
  "GET /api/bookings?from=2027-03-01&to=2027-04-01&status=pending_payment&status=confirmed";

beforeEach(() => {
  setSession(authResponse());
});

afterEach(() => {
  cleanup();
  clearSession();
  vi.unstubAllGlobals();
});

describe("unified calendar page", () => {
  it("renders the month, a unit row, and its booking as a bar", async () => {
    stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse()]),
      [BOOKINGS_KEY]: () => json([bookingRow()]),
    });
    renderAt(CAL_URL);

    expect(await screen.findByText("March 2027")).toBeInTheDocument();
    // property name appears in both the grid header and the filter dropdown
    expect(
      (await screen.findAllByText("Seminyak Beach Villa")).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText("Garden Room 1")).toBeInTheDocument();
    // the booking's bar carries the guest name (5-night stay, wide enough to label)
    expect(await screen.findByText("Wayan Test")).toBeInTheDocument();
  });

  it("names exactly the two occupying statuses in the bookings request", async () => {
    const calls = stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse()]),
      [BOOKINGS_KEY]: () => json([]),
    });
    renderAt(CAL_URL);

    // Wait for the grid (the unit row) so the bookings fetch has fired.
    await screen.findByText("Garden Room 1");
    // The occupying pair is named via a repeatable status filter (ADR-0010).
    expect(calls).toContain(BOOKINGS_KEY);
  });

  it("shows the onboarding CTA for a tenant with no inventory", async () => {
    stubFetch({
      "GET /api/properties": () => json([]),
      "GET /api/units": () => json([]),
      [BOOKINGS_KEY]: () => json([]),
    });
    renderAt(CAL_URL);

    expect(
      await screen.findByText("Add your first property"),
    ).toBeInTheDocument();
  });

  it("keeps an empty active unit as a wide-open row (no bookings, still shown)", async () => {
    stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse({ name: "Wide Open Room" })]),
      [BOOKINGS_KEY]: () => json([]),
    });
    renderAt(CAL_URL);

    // The row renders even though the unit has no bookings this month.
    expect(await screen.findByText("Wide Open Room")).toBeInTheDocument();
    // ...and it is not mistaken for the empty-tenant onboarding state.
    expect(
      screen.queryByText("Add your first property"),
    ).not.toBeInTheDocument();
  });

  it("opens the block / walk-in dialog when an empty day is clicked (#50)", async () => {
    stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse()]),
      [BOOKINGS_KEY]: () => json([]),
    });
    renderAt(CAL_URL);

    // Each active day cell is a labelled button (page-spec §4.1 "click empty range").
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add a booking on 2027-03-10 in Garden Room 1",
      }),
    );

    expect(await screen.findByText("Add to Garden Room 1")).toBeInTheDocument();
    // Both modes are offered; a walk-in needs a guest name (ADR-0011).
    expect(
      screen.getByRole("button", { name: /Walk-in/ }),
    ).toBeInTheDocument();
  });

  // --- Sync now (#201) -------------------------------------------------------

  it("sweeps every feed on demand and reports what the pull did", async () => {
    const calls = stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse()]),
      [BOOKINGS_KEY]: () => json([bookingRow()]),
      "POST /api/channels/sync": () =>
        json({
          feeds: 3,
          errored: 1,
          imported: 2,
          cancelled: 0,
          conflicts: 1,
        }),
    });
    renderAt(CAL_URL);

    fireEvent.click(await screen.findByRole("button", { name: /Sync now/ }));

    // ONE request for all feeds - not a loop in the browser over each connection.
    expect(
      (await screen.findByText(/3 feeds checked/)).textContent,
    ).toMatch(/2 imported/);
    // A clash is the one outcome that needs the owner elsewhere, so it says where.
    expect(screen.getByText(/1 clashed - see Inbox/)).toBeInTheDocument();
    expect(
      calls.filter((c) => c.startsWith("POST /api/channels/sync")),
    ).toHaveLength(1);
  });

  it("says so plainly when no OTA calendar is connected yet", async () => {
    stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse()]),
      [BOOKINGS_KEY]: () => json([bookingRow()]),
      "POST /api/channels/sync": () =>
        json({ feeds: 0, errored: 0, imported: 0, cancelled: 0, conflicts: 0 }),
    });
    renderAt(CAL_URL);

    fireEvent.click(await screen.findByRole("button", { name: /Sync now/ }));

    // "0 imported" would be true and useless - the real answer is that there is
    // nothing to sync yet, which is a different next action for the owner.
    expect(
      await screen.findByText("No OTA calendars connected yet."),
    ).toBeInTheDocument();
  });

  it("reports a failed sweep instead of looking like it worked", async () => {
    stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse()]),
      [BOOKINGS_KEY]: () => json([bookingRow()]),
      "POST /api/channels/sync": () =>
        json({ statusCode: 500, error: "Internal Server Error" }, 500),
    });
    renderAt(CAL_URL);

    fireEvent.click(await screen.findByRole("button", { name: /Sync now/ }));

    expect(
      await screen.findByText("Sync failed. Please try again."),
    ).toBeInTheDocument();
  });

  it("links a booking bar to its detail page (#50)", async () => {
    stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse()]),
      [BOOKINGS_KEY]: () => json([bookingRow()]),
    });
    renderAt(CAL_URL);

    const bar = await screen.findByText("Wayan Test");
    expect(bar.closest("a")).toHaveAttribute(
      "href",
      "/app/bookings/cccccccc-0000-0000-0000-000000000001",
    );
  });
});

/**
 * Ambient sync freshness (REQ-AV-04, spec §3). The calendar is where availability
 * is READ, so it is where how-current-is-this has to be answered - before anyone
 * clicks anything, and in the owner's face when the answer is bad.
 */
describe("calendar - sync freshness (REQ-AV-04)", () => {
  const withHealth = (health: unknown, extra: Record<string, unknown> = {}) =>
    stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse()]),
      [BOOKINGS_KEY]: () => json([bookingRow()]),
      "GET /api/channels/health": () => json(health),
      ...extra,
    });

  it("states how current the calendar is without anyone clicking Sync now", async () => {
    withHealth(syncHealthResponse({ feeds: 2, oldestSyncedAt: minutesAgo(12) }));
    renderAt(CAL_URL);

    expect(
      await screen.findByText(/2 OTA calendars checked 12 minutes ago/),
    ).toBeInTheDocument();

    // And the standing truth about iCal sits beside it, on this page too - the
    // SAME component, so this page makes the same promise in the same order:
    // the OTA's lag first, ours second, the manual Refresh named (UX-05a/05b).
    const lead = screen.getByText(/OTAs re-read your calendar/);
    const note = lead.closest("p")?.textContent ?? "";
    expect(note.indexOf("3 hours")).toBeLessThan(note.indexOf("30 minutes"));
    expect(note).toMatch(/cannot prevent every double booking/i);
    expect(note).toMatch(/Refresh/);
  });

  it("says it cannot tell, rather than looking healthy, when the check fails", async () => {
    stubFetch({
      "GET /api/properties": () => json([propertyResponse()]),
      "GET /api/units": () => json([unitResponse()]),
      [BOOKINGS_KEY]: () => json([bookingRow()]),
      "GET /api/channels/health": () =>
        json({ statusCode: 500, error: "Internal Server Error" }, 500),
    });
    renderAt(CAL_URL);

    // Silence here would read exactly like a healthy calendar - the precise false
    // comfort this feature exists to remove.
    expect(
      await screen.findByText(/Can’t tell how current this calendar is/),
    ).toBeInTheDocument();
  });

  it("warns and points at Channels when a feed has gone quiet", async () => {
    withHealth(
      syncHealthResponse({ feeds: 3, stale: 1, oldestSyncedAt: minutesAgo(400) }),
    );
    renderAt(CAL_URL);

    // The age rides along with the warning: "for 10 minutes" and "for 7 hours"
    // are not the same emergency, and a warning that hides which one understates
    // the damage (the FR-05 rule, applied to the fleet).
    expect(
      await screen.findByText(
        /1 of 3 OTA calendars last checked 6 hours ago - syncing may have stopped/,
      ),
    ).toBeInTheDocument();
    // A warning the owner has to go looking for is not a warning.
    expect(screen.getByRole("link", { name: "Check channels" })).toBeInTheDocument();
  });

  it("leads with an unreachable feed over a merely old one, and dates it", async () => {
    withHealth(
      syncHealthResponse({
        feeds: 2,
        erroring: 1,
        stale: 1,
        oldestSyncedAt: minutesAgo(3 * 24 * 60),
      }),
    );
    renderAt(CAL_URL);

    // Erroring first: its next action is "go look at the URL", which is a
    // different errand from "the sweep may have stopped". But the age comes with
    // it - three days unreachable is a different sentence from three minutes.
    expect(
      await screen.findByText(
        /1 of 2 OTA calendars could not be reached; last good check 3 days ago/,
      ),
    ).toBeInTheDocument();
  });

  it("says nothing is connected rather than implying a successful sync", async () => {
    withHealth(
      syncHealthResponse({ feeds: 0, oldestSyncedAt: null }),
    );
    renderAt(CAL_URL);

    expect(
      await screen.findByText("No OTA calendar connected yet."),
    ).toBeInTheDocument();
  });

  it("re-reads freshness after a sweep, so the line cannot outlive its own claim", async () => {
    const calls = withHealth(syncHealthResponse(), {
      "POST /api/channels/sync": () =>
        json({ feeds: 1, errored: 0, imported: 0, cancelled: 0, conflicts: 0 }),
    });
    renderAt(CAL_URL);
    await screen.findByText(/1 OTA calendar checked/);

    const before = calls.filter((c) => c === "GET /api/channels/health").length;
    fireEvent.click(screen.getByRole("button", { name: /Sync now/ }));

    await waitFor(() =>
      expect(
        calls.filter((c) => c === "GET /api/channels/health").length,
      ).toBeGreaterThan(before),
    );
  });
});
