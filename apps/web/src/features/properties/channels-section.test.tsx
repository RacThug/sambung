import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { clearSession, setSession } from "../../lib/auth";
import {
  authResponse,
  channelConnectionResponse,
  json,
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
    vi.spyOn(window, "confirm").mockReturnValue(true);
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
