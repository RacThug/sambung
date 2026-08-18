import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { clearSession, setSession } from "../../lib/auth";
import {
  authResponse,
  channelConnectionResponse,
  json,
  minutesAgo,
  propertyResponse,
  renderAt,
  stubFetch,
  unitResponse,
  type FetchStubs,
} from "../../test-utils";

const propertyId = propertyResponse().id;
const unitId = unitResponse().id;
const editUrl = `/app/properties/${propertyId}`;
const exportUrl = `${window.location.origin}/api/public/units/${unitId}/calendar.ics`;

/** The edit page fetches the property, its units, and each unit's channels. */
function stubEditPage(extra: FetchStubs = {}, connections = [channelConnectionResponse()]) {
  return stubFetch({
    [`GET /api/properties/${propertyId}`]: () => json(propertyResponse()),
    [`GET /api/properties/${propertyId}/units`]: () => json([unitResponse()]),
    [`GET /api/units/${unitId}/channels`]: () => json(connections),
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

describe("channels section (§4.5, #55)", () => {
  it("shows the copyable export URL with the paste-into-OTA helper", async () => {
    stubEditPage({}, []);
    renderAt(editUrl);

    expect(await screen.findByText(/paste into the OTA/i)).toBeInTheDocument();
    expect(screen.getByText(exportUrl)).toBeInTheDocument();
  });

  it("copies the export URL to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    stubEditPage({}, []);
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(exportUrl));
  });

  it("lists a connection with its status and iCal URL", async () => {
    stubEditPage({}, [
      channelConnectionResponse({ channel: "airbnb", lastStatus: "ok" }),
    ]);
    renderAt(editUrl);

    // Wait on the status badge (only present once the connections query resolves);
    // "Airbnb" alone would match the connect-form <option> before that.
    expect(await screen.findByText("Synced")).toBeInTheDocument();
    expect(screen.getByText("Airbnb")).toBeInTheDocument();
  });

  it("surfaces a connection's sync error", async () => {
    stubEditPage({}, [
      channelConnectionResponse({
        channel: "vrbo",
        lastStatus: "error",
        lastError: "Feed responded 404",
      }),
    ]);
    renderAt(editUrl);

    expect(await screen.findByText("Sync error")).toBeInTheDocument();
    expect(screen.getByText("Feed responded 404")).toBeInTheDocument();
  });

  it("connects a channel from the typed values", async () => {
    let posted: unknown;
    stubEditPage(
      {
        [`POST /api/units/${unitId}/channels`]: (init) => {
          posted = JSON.parse(String(init?.body));
          return json(channelConnectionResponse(), 201);
        },
      },
      [],
    );
    renderAt(editUrl);

    fireEvent.change(await screen.findByLabelText("iCal URL"), {
      target: { value: "https://www.airbnb.com/calendar/ical/9.ics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(posted).toBeDefined());
    expect(posted).toEqual({
      channel: "airbnb",
      importIcalUrl: "https://www.airbnb.com/calendar/ical/9.ics",
    });
  });

  it("rejects a non-https URL on the field without calling the API", async () => {
    const calls = stubEditPage({}, []);
    renderAt(editUrl);

    fireEvent.change(await screen.findByLabelText("iCal URL"), {
      target: { value: "http://insecure.example/x.ics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText(/https/i)).toBeInTheDocument();
    expect(calls).not.toContain(`POST /api/units/${unitId}/channels`);
  });

  // The 409 carries a slug (channel_already_connected); the web renders its own
  // copy, never the server's prose (#82).
  it("renders a duplicate-channel 409 on the field", async () => {
    stubEditPage(
      {
        [`POST /api/units/${unitId}/channels`]: () =>
          json(
            {
              statusCode: 409,
              error: "Conflict",
              code: "channel_already_connected",
              message: "This channel is already connected to this unit",
            },
            409,
          ),
      },
      [],
    );
    renderAt(editUrl);

    fireEvent.change(await screen.findByLabelText("iCal URL"), {
      target: { value: "https://www.airbnb.com/calendar/ical/9.ics" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText(/already connected to this unit/i),
    ).toBeInTheDocument();
  });

  // Disconnect KEEPS imported bookings and reports how many remain (api-spec §7.4);
  // the web composes the sentence from the count.
  it("disconnects and reports how many imported bookings were kept", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const conn = channelConnectionResponse();
    stubEditPage(
      {
        [`DELETE /api/channels/${conn.id}`]: () =>
          json({ importedBookingsKept: 3 }),
      },
      [conn],
    );
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/3 imported bookings kept/i)).toBeInTheDocument();
    // The confirm names the UNIT (unitResponse().name), not the raw channel slug.
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("Garden Room 1"),
    );
    expect(confirmSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('from “airbnb”'),
    );
  });

  it("retries one feed on demand and reports what that pull did (#201)", async () => {
    const conn = channelConnectionResponse();
    const calls = stubEditPage(
      {
        [`POST /api/channels/${conn.id}/sync`]: () =>
          json({
            lastStatus: "ok",
            lastSyncedAt: "2027-03-01T02:00:00.000Z",
            lastError: null,
            imported: 2,
            cancelled: 1,
            conflicts: 0,
          }),
      },
      [conn],
    );
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    // Per-feed, not the calendar's total: this is the view an owner is on when a
    // feed is erroring, so the answer has to be about THIS feed.
    expect(
      await screen.findByText(/2 imported, 1 cancelled/),
    ).toBeInTheDocument();
    expect(
      calls.filter((c) => c.startsWith(`POST /api/channels/${conn.id}/sync`)),
    ).toHaveLength(1);
    // The list is refetched, because lastStatus/lastSyncedAt just moved.
    await waitFor(() =>
      expect(
        calls.filter((c) => c.startsWith(`GET /api/units/${unitId}/channels`))
          .length,
      ).toBeGreaterThan(1),
    );
  });

  it("hides Sync now on an archived unit, like every other write", async () => {
    // Read-only means read-only: an archived unit keeps serving its export feed
    // (ADR-0016) but offers no button that would write.
    stubFetch({
      [`GET /api/properties/${propertyId}`]: () => json(propertyResponse()),
      [`GET /api/properties/${propertyId}/units`]: () =>
        json([unitResponse({ archivedAt: "2027-01-01T00:00:00.000Z" })]),
      [`GET /api/units/${unitId}/channels`]: () =>
        json([channelConnectionResponse()]),
    });
    renderAt(editUrl);

    expect(await screen.findByText(/Export calendar/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sync now" }),
    ).not.toBeInTheDocument();
  });

  it("does not disconnect when the confirm is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const conn = channelConnectionResponse();
    const calls = stubEditPage({}, [conn]);
    renderAt(editUrl);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(calls).not.toContain(`DELETE /api/channels/${conn.id}`);
  });

  // An archived unit keeps its export link (the feed is archive-blind, ADR-0016)
  // but offers no connect/disconnect.
  it("goes read-only for an archived unit but keeps the export link", async () => {
    stubFetch({
      [`GET /api/properties/${propertyId}`]: () => json(propertyResponse()),
      [`GET /api/properties/${propertyId}/units`]: () =>
        json([unitResponse({ archivedAt: "2026-07-18T00:00:00.000Z" })]),
      [`GET /api/units/${unitId}/channels`]: () => json([]),
    });
    renderAt(editUrl);

    expect(await screen.findByText(/unarchive it to connect/i)).toBeInTheDocument();
    // Export link still present.
    expect(
      screen.getByText(exportUrl),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect" }),
    ).not.toBeInTheDocument();
  });
});

/**
 * Honesty sync UX (REQ-AV-04, spec §3). The feed's health was already on screen;
 * what was missing is WHEN it last worked, and what iCal cannot promise at all.
 */
describe("channels section - sync honesty (REQ-AV-04)", () => {
  it("says when the feed last synced, not only that it did", async () => {
    stubEditPage({}, [
      channelConnectionResponse({ lastSyncedAt: minutesAgo(12), stale: false }),
    ]);
    renderAt(editUrl);

    expect(await screen.findByText(/Last synced 12 minutes ago/)).toBeInTheDocument();
    expect(screen.getByText("Synced")).toBeInTheDocument();
  });

  it("marks a stale feed and names the likely cause", async () => {
    stubEditPage({}, [
      channelConnectionResponse({ lastSyncedAt: minutesAgo(5 * 60), stale: true }),
    ]);
    renderAt(editUrl);

    // The pill still reads "Synced" - which is exactly the lie this line closes.
    const line = await screen.findByText(/Last synced 5 hours ago/);
    expect(line.textContent).toMatch(/syncing may have stopped/);
  });

  it("does not age a feed that has never synced", async () => {
    stubEditPage({}, [
      channelConnectionResponse({
        lastSyncedAt: null,
        lastStatus: "never",
        stale: false,
      }),
    ]);
    renderAt(editUrl);

    expect(await screen.findByText("Not synced yet")).toBeInTheDocument();
    // "Never checked" is not "checked, long ago" - no age, no stale warning.
    expect(screen.queryByText(/Last synced/)).not.toBeInTheDocument();
    expect(screen.queryByText(/may have stopped/)).not.toBeInTheDocument();
  });

  it("explains the OTA's lag BEFORE its own, and names the manual refresh", async () => {
    stubEditPage({}, [channelConnectionResponse()]);
    renderAt(editUrl);

    // The lead is emphasised in its own span, so climb to the paragraph: the
    // ORDER of the two legs is the requirement, and it only exists in the whole.
    const lead = await screen.findByText(/OTAs re-read your calendar/);
    const text = lead.closest("p")?.textContent ?? "";
    // The dangerous leg is the outbound one (3 hours, Airbnb's schedule), not our
    // 30-minute pull - so it has to be read first, not buried after reassurance.
    expect(text.indexOf("3 hours")).toBeLessThan(text.indexOf("30 minutes"));
    expect(text).toMatch(/cannot prevent every double booking/i);
    expect(text).toMatch(/Refresh/);
  });

  it("re-reads the feed's age after a per-feed sync", async () => {
    const conn = channelConnectionResponse({
      lastSyncedAt: minutesAgo(200),
      stale: true,
    });
    let synced = false;
    stubFetch({
      [`GET /api/properties/${propertyId}`]: () => json(propertyResponse()),
      [`GET /api/properties/${propertyId}/units`]: () => json([unitResponse()]),
      // The list answers differently once the pull has landed - which is the only
      // way an age on screen can be shown to have MOVED rather than been re-rendered.
      [`GET /api/units/${unitId}/channels`]: () =>
        json([
          synced
            ? channelConnectionResponse({ lastSyncedAt: minutesAgo(0), stale: false })
            : conn,
        ]),
      [`POST /api/channels/${conn.id}/sync`]: () => {
        synced = true;
        return json({
          lastStatus: "ok",
          lastSyncedAt: minutesAgo(0),
          lastError: null,
          imported: 1,
          cancelled: 0,
          conflicts: 0,
        });
      },
    });
    renderAt(editUrl);

    expect(await screen.findByText(/Last synced 3 hours ago/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    // The stale warning clears because the row was re-read, not because the button
    // was clicked. (The fleet-freshness key is invalidated by the same handler;
    // the calendar suite is where an observer exists to prove that it refetches.)
    expect(await screen.findByText(/Last synced just now/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/may have stopped/)).not.toBeInTheDocument(),
    );
  });
});
