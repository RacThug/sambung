import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { setSession, clearSession } from "../../lib/auth";
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
      "GET /api/bookings": () => json([bookingRow()]),
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

  it("has no default window - it lists the whole ledger", async () => {
    const calls = stubFetch({
      ...inventory,
      "GET /api/bookings": () => json([bookingRow()]),
    });
    renderAt("/app/reservations");

    await screen.findByText("Wayan Test");
    // The bookings request carries no from/to: absence means all time, not a month.
    expect(calls).toContain("GET /api/bookings");
    expect(calls.some((c) => c.includes("from="))).toBe(false);
  });

  it("distinguishes empty-tenant from empty-with-filters", async () => {
    stubFetch({
      ...inventory,
      "GET /api/bookings": () => json([]),
    });
    renderAt("/app/reservations");

    // No filters + no rows = the tenant simply has none yet.
    expect(await screen.findByText("No reservations yet")).toBeInTheDocument();
  });

  it("shows the no-matches state when a filter excludes everything", async () => {
    stubFetch({
      ...inventory,
      "GET /api/bookings?status=cancelled": () => json([]),
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
      "GET /api/bookings": () => json([]),
    });
    renderAt("/app/reservations?from=2027-03-01");

    // The pair hint appears...
    expect(
      await screen.findByText("Pick both a start and end date."),
    ).toBeInTheDocument();
    // ...and the request went out with NO from param (a lone edge would 400).
    expect(calls).toContain("GET /api/bookings");
    expect(calls.some((c) => c.includes("from="))).toBe(false);
  });

  it("toggling a status chip narrows the request via the URL", async () => {
    const calls = stubFetch({
      ...inventory,
      "GET /api/bookings": () => json([bookingRow()]),
      "GET /api/bookings?status=confirmed": () => json([bookingRow()]),
    });
    renderAt("/app/reservations");

    fireEvent.click(await screen.findByRole("button", { name: "Confirmed" }));

    // The repeatable status filter reaches the API as a query param.
    await vi.waitFor(() =>
      expect(calls).toContain("GET /api/bookings?status=confirmed"),
    );
  });
});
