import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { setSession, clearSession } from "../../lib/auth";
import { authResponse, json, renderAt, stubFetch } from "../../test-utils";

const CONFLICT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BLOCKING_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const LIST_KEY = "GET /api/sync-conflicts";
const DISMISS_KEY = `POST /api/sync-conflicts/${CONFLICT_ID}/dismiss`;
const LAPSED_KEY = "GET /api/payments/lapsed";

/** One conflict as the wire delivers it (a plain object; the api-client doesn't
 * re-parse). Half-open `stay`: `to` is the check-out date, not a night. */
const syncConflict = (over: Record<string, unknown> = {}) => ({
  id: CONFLICT_ID,
  propertyId: "cccccccc-0000-0000-0000-000000000001",
  propertyName: "Seminyak Beach Villa",
  unitId: "dddddddd-0000-0000-0000-000000000001",
  unitName: "Garden Room 1",
  channel: "airbnb",
  externalUid: "ota-uid-1",
  stay: { from: "2030-02-10", to: "2030-02-13" },
  status: "open",
  firstDetectedAt: "2030-02-01T00:00:00.000Z",
  lastSeenAt: "2030-02-02T00:00:00.000Z",
  closedAt: null,
  blockingBookings: [
    {
      id: BLOCKING_ID,
      source: "direct",
      status: "confirmed",
      checkIn: "2030-02-11",
      checkOut: "2030-02-14",
      guestName: "Wayan",
    },
  ],
  ...over,
});

beforeEach(() => {
  setSession(authResponse());
});

afterEach(() => {
  cleanup();
  clearSession();
  vi.unstubAllGlobals();
});

describe("sync-conflict inbox section (#38)", () => {
  it("names the clash and links to the blocking booking", async () => {
    stubFetch({
      [LIST_KEY]: () => json([syncConflict()]),
      [LAPSED_KEY]: () => json([]),
    });
    renderAt("/app/inbox");

    // Which channel, which inventory, which nights.
    expect(
      await screen.findByText(/Airbnb booking couldn’t be imported/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Seminyak Beach Villa - Garden Room 1"),
    ).toBeInTheDocument();
    expect(screen.getByText(/10 Feb 2030 → 13 Feb 2030 \(3 nights\)/))
      .toBeInTheDocument();

    // ...and what is in the way, one click from being cancelled. This is the
    // difference between a notification and something the owner can act on.
    expect(screen.getByText("Already booked here")).toBeInTheDocument();
    expect(screen.getByText("Wayan")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View booking/ })).toHaveAttribute(
      "href",
      `/app/bookings/${BLOCKING_ID}`,
    );
  });

  it("shows when it was first seen in the reader's zone, with the time (#188)", async () => {
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Makassar";
    try {
      stubFetch({
        [LIST_KEY]: () => json([syncConflict()]),
        [LAPSED_KEY]: () => json([]),
      });
      renderAt("/app/inbox");

      // The fixture is midnight UTC = 08:00 in WITA. A card that sliced the
      // instant to its UTC day could not render a time at all, so asserting the
      // clock proves the whole moment reaches the formatter - not just its date.
      // Separator left open (":" or "." by locale); the digits are not.
      expect(await screen.findByText(/First seen .*08[.:]00/)).toBeInTheDocument();
    } finally {
      process.env.TZ = tz;
    }
  });

  it("dismisses an item and refetches so it drops from the list", async () => {
    let dismissed = false;
    const calls = stubFetch({
      [LIST_KEY]: () => json(dismissed ? [] : [syncConflict()]),
      [DISMISS_KEY]: () => {
        dismissed = true;
        return json({
          id: CONFLICT_ID,
          status: "dismissed",
          closedAt: "2030-02-03T00:00:00.000Z",
        });
      },
      [LAPSED_KEY]: () => json([]),
    });
    renderAt("/app/inbox");

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(calls).toContain(DISMISS_KEY));
    await waitFor(() =>
      expect(
        screen.queryByText(/Airbnb booking couldn’t be imported/),
      ).not.toBeInTheDocument(),
    );
  });

  it("says so when there are no conflicts, rather than vanishing", async () => {
    // Was: "stays out of the way entirely". The section used to `return null` for
    // loading, empty AND error alike, so a failed read was indistinguishable from
    // a quiet one - on the page whose whole job is surfacing what needs attention
    // (divergences D3/D5). It now renders its heading and an explicit all-clear.
    stubFetch({ "GET /api/sync-conflicts": () => json([]) });
    renderAt("/app/inbox");

    expect(
      await screen.findByRole("heading", { name: "Calendar conflicts" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("No conflicts")).toBeInTheDocument();
  });

  it("surfaces a failed read instead of looking empty", async () => {
    stubFetch({
      "GET /api/sync-conflicts": () => new Response("nope", { status: 500 }),
    });
    renderAt("/app/inbox");

    expect(
      await screen.findByText(/couldn.t load your calendar conflicts/i),
    ).toBeInTheDocument();
    // The all-clear must NOT appear: "we could not ask" and "there is nothing"
    // are different answers.
    expect(screen.queryByText("No conflicts")).not.toBeInTheDocument();
  });

  it("offers no way to mark a conflict resolved (only the next sync decides that)", async () => {
    stubFetch({
      [LIST_KEY]: () => json([syncConflict()]),
      [LAPSED_KEY]: () => json([]),
    });
    renderAt("/app/inbox");

    await screen.findByRole("button", { name: "Dismiss" });
    // api-spec §7.5: resolution is cancelling the blocking booking, which the next
    // sync MEASURES. A resolve button would let the UI assert something the
    // exclusion constraint has not agreed to.
    expect(screen.queryByRole("button", { name: /resolve/i })).toBeNull();
  });
});
