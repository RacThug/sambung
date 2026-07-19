import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setSession, clearSession } from "../../lib/auth";
import { authResponse, json, stubFetch } from "../../test-utils";
import { ExportCsvButton } from "./export-csv-button";
import { reservationsExportPath } from "./reservations-export";
import type { ReservationFilters } from "./use-reservations";

const filters: ReservationFilters = {
  window: { from: "2027-03-01", to: "2027-03-31" },
  propertyId: "aaaaaaaa-0000-0000-0000-000000000001",
  status: ["confirmed"],
  source: undefined,
};

// The export endpoint the button hits, from the active filters. Kept in sync with
// the list's own query builder (both call bookingsQueryString), so the file mirrors
// the on-screen table.
const EXPORT_PATH = `/api${reservationsExportPath(filters)}`;

let clickedDownload: string | null = null;

beforeEach(() => {
  setSession(authResponse());
  clickedDownload = null;
  // jsdom implements neither of these; the download flow needs both.
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn();
  // Capture the anchor's download name instead of letting jsdom navigate.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clickedDownload = this.download;
  });
});

afterEach(() => {
  cleanup();
  clearSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reservationsExportPath", () => {
  it("builds the CSV twin URL from the active filters, repeating set-params", () => {
    expect(reservationsExportPath(filters)).toBe(
      "/bookings/export.csv?from=2027-03-01&to=2027-03-31" +
        "&propertyId=aaaaaaaa-0000-0000-0000-000000000001&status=confirmed",
    );
  });
});

describe("ExportCsvButton", () => {
  it("downloads the filtered CSV under a windowed filename", async () => {
    const calls = stubFetch({
      [`GET ${EXPORT_PATH}`]: () =>
        new Response("Booking ID\r\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        }),
    });

    render(<ExportCsvButton filters={filters} />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    await waitFor(() => expect(calls).toContain(`GET ${EXPORT_PATH}`));
    // A download was triggered, named for the exported window.
    await waitFor(() =>
      expect(clickedDownload).toBe("reservations-2027-03-01_2027-03-31.csv"),
    );
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("surfaces a failed export instead of a silent no-op", async () => {
    stubFetch({
      [`GET ${EXPORT_PATH}`]: () =>
        json({ statusCode: 500, message: "boom" }, 500),
    });

    render(<ExportCsvButton filters={filters} />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(await screen.findByText(/export failed/i)).toBeInTheDocument();
    expect(clickedDownload).toBeNull(); // no download on failure
  });
});
