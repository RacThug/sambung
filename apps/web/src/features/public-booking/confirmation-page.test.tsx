import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { json, renderAt, stubFetch } from "../../test-utils";

const ID = "cccccccc-0000-0000-0000-000000000054";
const URL = `/booking/${ID}`;
const KEY = `GET /api/public/bookings/${ID}`;

// A confirmation payload as the wire delivers it (plain numbers; no branding).
const confirmation = (over: Record<string, unknown> = {}) => ({
  status: "confirmed",
  checkIn: "2027-03-10",
  checkOut: "2027-03-14",
  propertyName: "Seminyak Beach Villa",
  unitName: "Garden Room 1",
  totalPriceIdr: 4_000_000,
  amountPaidIdr: 1_200_000,
  waLink: "https://wa.me/6281234567890?text=Here",
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("confirmation page (#54)", () => {
  it("renders the confirmed party view with paid amount, balance and wa.me link", async () => {
    stubFetch({ [KEY]: () => json(confirmation()) });
    renderAt(URL);

    expect(await screen.findByText("You're all set")).toBeInTheDocument();
    expect(
      screen.getByText("Seminyak Beach Villa - Garden Room 1"),
    ).toBeInTheDocument();
    expect(screen.getByText("Rp 1.200.000")).toBeInTheDocument(); // paid online
    expect(screen.getByText("Rp 2.800.000")).toBeInTheDocument(); // balance

    const wa = screen.getByRole("link", {
      name: "Send WhatsApp confirmation",
    });
    expect(wa).toHaveAttribute("href", "https://wa.me/6281234567890?text=Here");
    expect(wa).toHaveAttribute("target", "_blank");
  });

  it("hides the WhatsApp button when there is no deeplink", async () => {
    stubFetch({ [KEY]: () => json(confirmation({ waLink: null })) });
    renderAt(URL);

    await screen.findByText("You're all set");
    expect(
      screen.queryByRole("link", { name: "Send WhatsApp confirmation" }),
    ).not.toBeInTheDocument();
  });

  it("polls a pending booking and flips to confirmed with no manual refresh", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      stubFetch({
        [KEY]: () => {
          calls += 1;
          return json(
            confirmation({
              status: calls >= 2 ? "confirmed" : "pending_payment",
            }),
          );
        },
      });
      renderAt(URL);

      // First load resolves to pending.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Confirming your payment…")).toBeInTheDocument();

      // Advance through the ~5s poll (a few ticks to flush react-query's
      // deferred re-render notify). The page flips itself - no user action.
      for (let i = 0; i < 12 && !screen.queryByText("You're all set"); i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(screen.getByText("You're all set")).toBeInTheDocument();
      expect(calls).toBeGreaterThanOrEqual(2); // it polled, not a single fetch
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the expired (hold lapsed) state", async () => {
    stubFetch({ [KEY]: () => json(confirmation({ status: "expired" })) });
    renderAt(URL);
    expect(await screen.findByText("Your hold has lapsed")).toBeInTheDocument();
  });

  it("renders the cancelled state", async () => {
    stubFetch({ [KEY]: () => json(confirmation({ status: "cancelled" })) });
    renderAt(URL);
    expect(
      await screen.findByText("This booking was cancelled"),
    ).toBeInTheDocument();
  });

  it("shows a not-found state for an unknown booking id (404)", async () => {
    stubFetch({ [KEY]: () => json({ message: "Booking not found" }, 404) });
    renderAt(URL);
    expect(await screen.findByText("Booking not found")).toBeInTheDocument();
  });
});
