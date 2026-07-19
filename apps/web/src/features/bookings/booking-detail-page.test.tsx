import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { setSession, clearSession } from "../../lib/auth";
import {
  authResponse,
  json,
  propertyResponse,
  renderAt,
  stubFetch,
  unitResponse,
} from "../../test-utils";

const ID = "cccccccc-0000-0000-0000-000000000009";
const DETAIL_URL = `/app/bookings/${ID}`;
const DETAIL_KEY = `GET /api/bookings/${ID}`;
const CANCEL_KEY = `POST /api/bookings/${ID}/cancel`;

// A booking detail as the wire delivers it (plain object; no Rupiah ceremony).
const bookingDetail = (over: Record<string, unknown> = {}) => ({
  id: ID,
  unitId: unitResponse().id,
  source: "direct",
  status: "confirmed",
  checkIn: "2027-03-10",
  checkOut: "2027-03-14",
  guestName: "Made Detail",
  guestCount: 2,
  holdExpiresAt: null,
  totalPriceIdr: 4_000_000,
  guestPhone: "+62 812 0000 1111",
  guestEmail: "made@example.com",
  propertyId: propertyResponse().id,
  propertyName: "Seminyak Beach Villa",
  unitName: "Garden Room 1",
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

describe("booking detail page (#50)", () => {
  it("renders the reservation's guest, dates, price and contact", async () => {
    stubFetch({ [DETAIL_KEY]: () => json(bookingDetail()) });
    renderAt(DETAIL_URL);

    expect(await screen.findByText("Made Detail")).toBeInTheDocument();
    expect(screen.getByText("Seminyak Beach Villa")).toBeInTheDocument();
    expect(screen.getByText("Garden Room 1")).toBeInTheDocument();
    expect(screen.getByText("Rp 4.000.000")).toBeInTheDocument();
    expect(screen.getByText("+62 812 0000 1111")).toBeInTheDocument();
  });

  it("labels a manual block as such and offers Remove block", async () => {
    stubFetch({
      [DETAIL_KEY]: () =>
        json(
          bookingDetail({
            source: "manual_block",
            guestName: null,
            guestPhone: null,
            guestEmail: null,
            guestCount: null,
            totalPriceIdr: null,
          }),
        ),
    });
    renderAt(DETAIL_URL);

    expect(await screen.findByText("Manual block")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove block" }),
    ).toBeInTheDocument();
  });

  it("cancels a confirmed booking through the confirm dialog (#50)", async () => {
    let cancelled = false;
    const calls = stubFetch({
      [DETAIL_KEY]: () =>
        json(bookingDetail({ status: cancelled ? "cancelled" : "confirmed" })),
      [CANCEL_KEY]: () => {
        cancelled = true;
        return json({ status: "cancelled", refund: "none" });
      },
    });
    renderAt(DETAIL_URL);

    // Open the confirm dialog, then confirm.
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel booking" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Yes, cancel" }));

    // The cancel endpoint was hit, and the page reflects the freed booking.
    await waitFor(() => expect(calls).toContain(CANCEL_KEY));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    // Once terminal, the cancel action is gone.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Cancel booking" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows a not-found state for an unknown / cross-tenant booking", async () => {
    stubFetch({
      [DETAIL_KEY]: () => json({ message: "Booking not found" }, 404),
    });
    renderAt(DETAIL_URL);

    expect(
      await screen.findByText(/isn’t yours|doesn’t exist/),
    ).toBeInTheDocument();
  });
});
