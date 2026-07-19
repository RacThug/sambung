import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { setSession, clearSession } from "../../lib/auth";
import { todayIso } from "../../lib/date";
import { defaultWindow } from "./reservations-model";
import {
  authResponse,
  json,
  propertyResponse,
  renderAt,
  stubFetch,
  unitResponse,
} from "../../test-utils";

// A booking row as the wire delivers it (a plain object - api-client doesn't
// re-parse), matching the calendar test's fixture shape.
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

// The default "upcoming" window the page opens on, computed the same way the page
// does (today -> today + 366). Every bookings request carries it unless the owner
// sets a custom range, so the request key is deterministic without faking the clock.
const WIN = defaultWindow(todayIso());
const DEFAULT_BOOKINGS = `GET /api/bookings?from=${WIN.from}&to=${WIN.to}`;

const inventory = {
  "GET /api/properties": () => json([propertyResponse()]),
  "GET /api/units": () => json([unitResponse()]),
};

beforeEach(() => {
  setSession(authResponse());
});

afterEach(() => {
  cleanup();
  clearSession();
  vi.unstubAllGlobals();
});

describe("reservations list page", () => {
  it("renders a booking as a row joined to its unit and property", async () => {
    stubFetch({
      ...inventory,
      [DEFAULT_BOOKINGS]: () => json([bookingRow()]),
    });
    renderAt("/app/reservations");

    // Guest name links to the detail page (a11y + middle-click path).
    const guest = await screen.findByRole("link", { name: "Wayan Test" });
    expect(guest).toHaveAttribute(
      "href",
      "/app/bookings/cccccccc-0000-0000-0000-000000000001",
    );
    // Assert the row itself (scoped to the table): the property name also appears
    // in the filter dropdown and "Confirmed" is also a filter chip.
    const table = screen.getByRole("table");
    expect(within(table).getByText("Garden Room 1")).toBeInTheDocument();
    expect(within(table).getByText("Seminyak Beach Villa")).toBeInTheDocument();
    expect(within(table).getByText("Confirmed")).toBeInTheDocument();
  });

  it("opens on the upcoming window - from today, no owner input", async () => {
    const calls = stubFetch({
      ...inventory,
      [DEFAULT_BOOKINGS]: () => json([bookingRow()]),
    });
    renderAt("/app/reservations");

    await screen.findByText("Wayan Test");
    // The default window is queried (from today), and no lone/empty edge is sent.
    expect(calls).toContain(DEFAULT_BOOKINGS);
    expect(WIN.from).toBe(todayIso());
    // The caption explains the default rather than silently hiding past bookings.
    expect(
      screen.getByText(/Showing upcoming reservations/i),
    ).toBeInTheDocument();
  });

  it("shows the upcoming empty state when nothing is coming up", async () => {
    stubFetch({
      ...inventory,
      [DEFAULT_BOOKINGS]: () => json([]),
    });
    renderAt("/app/reservations");

    // No explicit filters + nothing upcoming = the default-window empty state, which
    // points at the date range (a past-only tenant isn't "empty").
    expect(
      await screen.findByText("No upcoming reservations"),
    ).toBeInTheDocument();
  });

  it("shows the no-matches state when a filter excludes everything", async () => {
    stubFetch({
      ...inventory,
      [`${DEFAULT_BOOKINGS}&status=cancelled`]: () => json([]),
    });
    renderAt("/app/reservations?status=cancelled");

    expect(await screen.findByText("No matches")).toBeInTheDocument();
    // ...and the cancelled chip reads as pressed (the URL drove the filter).
    expect(
      screen.getByRole("button", { name: "Cancelled" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("never sends a lone window edge; it hints for the pair instead", async () => {
    const calls = stubFetch({
      ...inventory,
      [DEFAULT_BOOKINGS]: () => json([]),
    });
    renderAt("/app/reservations?from=2027-03-01");

    // The pair hint appears...
    expect(
      await screen.findByText("Pick both a start and end date."),
    ).toBeInTheDocument();
    // ...and the request went out with the DEFAULT window, never the lone edge.
    expect(calls).toContain(DEFAULT_BOOKINGS);
    expect(calls.some((c) => c.includes("from=2027-03-01"))).toBe(false);
  });

  it("toggling a status chip narrows the request via the URL", async () => {
    const calls = stubFetch({
      ...inventory,
      [DEFAULT_BOOKINGS]: () => json([bookingRow()]),
      [`${DEFAULT_BOOKINGS}&status=confirmed`]: () => json([bookingRow()]),
    });
    renderAt("/app/reservations");

    fireEvent.click(await screen.findByRole("button", { name: "Confirmed" }));

    // The repeatable status filter reaches the API as a query param (atop the window).
    await vi.waitFor(() =>
      expect(calls).toContain(`${DEFAULT_BOOKINGS}&status=confirmed`),
    );
  });
});
