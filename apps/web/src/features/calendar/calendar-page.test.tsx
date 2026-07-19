import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { setSession, clearSession } from "../../lib/auth";
import {
  authResponse,
  json,
  propertyResponse,
  renderAt,
  stubFetch,
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
