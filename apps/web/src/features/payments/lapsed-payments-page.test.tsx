import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { setSession, clearSession } from "../../lib/auth";
import { authResponse, json, renderAt, stubFetch } from "../../test-utils";

const PAYMENT_ID = "dddddddd-0000-0000-0000-000000000001";
const BOOKING_ID = "eeeeeeee-0000-0000-0000-000000000001";
const LIST_KEY = "GET /api/payments/lapsed";
const HANDLE_KEY = `POST /api/payments/${PAYMENT_ID}/handle`;

// One paid-but-lapsed payment as the wire delivers it (a plain object; the
// api-client doesn't re-parse). Amounts arrive as plain integers (api-spec §1).
const lapsedPayment = (over: Record<string, unknown> = {}) => ({
  paymentId: PAYMENT_ID,
  bookingId: BOOKING_ID,
  bookingStatus: "expired",
  provider: "midtrans",
  amountIdr: 4_000_000,
  guestName: "Late Larry",
  guestPhone: "+62 811 2233 4455",
  guestEmail: "larry@example.com",
  checkIn: "2030-01-10",
  checkOut: "2030-01-13",
  propertyName: "Seminyak Beach Villa",
  unitName: "Garden Room 1",
  createdAt: "2030-01-14T00:00:00.000Z",
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

describe("paid-but-lapsed inbox page (#120)", () => {
  it("renders an item with amount, guest, dates and a link to the booking", async () => {
    stubFetch({ [LIST_KEY]: () => json([lapsedPayment()]) });
    renderAt("/app/inbox");

    // Enough to act: amount, guest + contact, the stay, where, and why (Expired).
    expect(await screen.findByText("Rp 4.000.000")).toBeInTheDocument();
    expect(screen.getByText("Late Larry")).toBeInTheDocument();
    expect(screen.getByText(/\+62 811 2233 4455/)).toBeInTheDocument();
    expect(
      screen.getByText("Seminyak Beach Villa — Garden Room 1"),
    ).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();

    // The booking link is deep-linkable to the detail page.
    expect(
      screen.getByRole("link", { name: /View booking/ }),
    ).toHaveAttribute("href", `/app/bookings/${BOOKING_ID}`);
  });

  it("shows the all-clear empty state when nothing needs attention", async () => {
    stubFetch({ [LIST_KEY]: () => json([]) });
    renderAt("/app/inbox");

    expect(await screen.findByText("All clear")).toBeInTheDocument();
  });

  it("marks an item handled and refetches so it drops from the list", async () => {
    let handled = false;
    const calls = stubFetch({
      // After the handle POST, the server no longer lists the item.
      [LIST_KEY]: () => json(handled ? [] : [lapsedPayment()]),
      [HANDLE_KEY]: () => {
        handled = true;
        return json({
          paymentId: PAYMENT_ID,
          handledAt: "2030-01-15T00:00:00.000Z",
        });
      },
    });
    renderAt("/app/inbox");

    fireEvent.click(await screen.findByRole("button", { name: "Mark handled" }));

    // The handle endpoint was hit...
    await waitFor(() => expect(calls).toContain(HANDLE_KEY));
    // ...and the refetch shows it gone (the all-clear state replaces it).
    expect(await screen.findByText("All clear")).toBeInTheDocument();
  });

  it("shows an error state when the inbox fails to load", async () => {
    stubFetch({ [LIST_KEY]: () => json({ message: "boom" }, 500) });
    renderAt("/app/inbox");

    expect(
      await screen.findByText(/couldn’t load this inbox/),
    ).toBeInTheDocument();
  });
});
