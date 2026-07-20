import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  json,
  publicPropertyResponse,
  renderAt,
  stubFetch,
} from "../../test-utils";

/**
 * Checkout `/p/:slug/book` (page-spec §3.2, #52) - the guest details form, then
 * the create -> pay -> redirect handoff. The Provider redirect is a
 * `window.location.assign`, mocked here so the test can assert the guest is sent
 * to the returned URL. The router uses memory history, so replacing
 * `window.location` doesn't disturb navigation.
 */

const UNIT_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const BOOKING_ID = "cccccccc-0000-0000-0000-000000000001";
const REDIRECT = "https://sandbox.midtrans.example/snap/xyz";

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign, href: "http://localhost/", origin: "http://localhost" },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const availableQuote = {
  available: true,
  nights: 3,
  totalPriceIdr: 3_600_000,
  minStay: 1,
  reasons: [],
  blockedRanges: [],
};

/** The checkout also fetches the property for the Deposit % (ADR-0015). */
const propertyStub = (depositPct = 100) => ({
  "GET /api/public/properties/villa": () =>
    json(publicPropertyResponse({ slug: "villa", depositPct })),
});

/** Fill the required guest fields. The phone is a bare national number typed with
 * the country selector on its default (Indonesia) - the case the fix targets. */
function fillForm() {
  fireEvent.change(screen.getByLabelText(/full name/i), {
    target: { value: "Made A." },
  });
  fireEvent.change(screen.getByLabelText(/whatsapp number/i), {
    target: { value: "0812 3456 7890" },
  });
}

/** Read the guestPhone the checkout put on the create request. */
function postedGuestPhone(init?: RequestInit): string {
  return JSON.parse(String(init?.body ?? "{}")).guestPhone as string;
}

describe("checkout page", () => {
  const bookingCreated = {
    bookingId: BOOKING_ID,
    status: "pending_payment",
    holdExpiresAt: "2026-09-10T12:15:00.000Z",
    totalPriceIdr: 3_600_000,
    nights: 3,
  };
  const paySession = {
    provider: "midtrans",
    token: "snap-token",
    redirectUrl: REDIRECT,
    amountIdr: 3_600_000,
    deposit: false,
  };

  it("creates the booking, opens the pay session, and redirects to the Provider", async () => {
    let createInit: RequestInit | undefined;
    const calls = stubFetch({
      ...propertyStub(),
      [`GET /api/public/units/${UNIT_ID}/availability`]: () =>
        json(availableQuote),
      "POST /api/public/bookings": (init) => {
        createInit = init;
        return json(bookingCreated, 201);
      },
      [`POST /api/public/bookings/${BOOKING_ID}/pay`]: () => json(paySession, 201),
    });

    renderAt(`/p/villa/book?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);

    // The fresh price shows from the re-quote (page-spec §3.2 quote summary).
    expect(await screen.findByText("Rp 3.600.000")).toBeInTheDocument();

    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));

    // The bare ID national number was assembled into E.164 before submit (#54).
    expect(postedGuestPhone(createInit)).toBe("+6281234567890");
    // The two-step handoff happened in order: create, then pay.
    expect(calls).toContain("POST /api/public/bookings");
    expect(calls).toContain(`POST /api/public/bookings/${BOOKING_ID}/pay`);
  });

  it("assembles E.164 for a non-Indonesian country when the selector is switched (#54)", async () => {
    let createInit: RequestInit | undefined;
    stubFetch({
      ...propertyStub(),
      [`GET /api/public/units/${UNIT_ID}/availability`]: () =>
        json(availableQuote),
      "POST /api/public/bookings": (init) => {
        createInit = init;
        return json(bookingCreated, 201);
      },
      [`POST /api/public/bookings/${BOOKING_ID}/pay`]: () => json(paySession, 201),
    });

    renderAt(`/p/villa/book?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);
    await screen.findByText("Rp 3.600.000");

    fireEvent.change(screen.getByLabelText(/full name/i), {
      target: { value: "Alex UK" },
    });
    // The country list (with libphonenumber-js) now loads as its own chunk (#125),
    // so wait for the options before switching - the option's presence is the
    // signal the phone kit has arrived.
    await screen.findByRole("option", { name: /United Kingdom/i });
    // Switch the country to the UK, then type a UK national number.
    fireEvent.change(screen.getByLabelText(/country/i), {
      target: { value: "GB" },
    });
    fireEvent.change(screen.getByLabelText(/whatsapp number/i), {
      target: { value: "07911 123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));
    expect(postedGuestPhone(createInit)).toBe("+447911123456");
  });

  it("blocks submit with an inline error for an invalid number, no request sent (#54)", async () => {
    const calls = stubFetch({
      ...propertyStub(),
      [`GET /api/public/units/${UNIT_ID}/availability`]: () =>
        json(availableQuote),
    });

    renderAt(`/p/villa/book?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);
    await screen.findByText("Rp 3.600.000");

    fireEvent.change(screen.getByLabelText(/full name/i), {
      target: { value: "Made A." },
    });
    fireEvent.change(screen.getByLabelText(/whatsapp number/i), {
      target: { value: "123" }, // not a valid number for Indonesia
    });
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    expect(
      await screen.findByText(/valid whatsapp number for the selected country/i),
    ).toBeInTheDocument();
    expect(calls).not.toContain("POST /api/public/bookings");
    expect(assign).not.toHaveBeenCalled();
  });

  it("previews the deposit split for a partial-deposit property", async () => {
    stubFetch({
      ...propertyStub(30), // Canggu-style: 30% online, balance at the property
      [`GET /api/public/units/${UNIT_ID}/availability`]: () =>
        json(availableQuote),
    });

    renderAt(`/p/villa/book?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);

    // 30% of Rp 3.600.000 = Rp 1.080.000 now; the rest at the property.
    expect(await screen.findByText(/deposit due now/i)).toBeInTheDocument();
    expect(screen.getByText(/Rp 1\.080\.000/)).toBeInTheDocument();
    expect(screen.getByText(/\(30%\)/)).toBeInTheDocument();
    expect(screen.getByText(/Rp 2\.520\.000 due at the property/i)).toBeInTheDocument();
  });

  it("shows the just-taken copy when the dates were booked before submit (409)", async () => {
    stubFetch({
      ...propertyStub(),
      [`GET /api/public/units/${UNIT_ID}/availability`]: () =>
        json(availableQuote),
      "POST /api/public/bookings": () =>
        json(
          { statusCode: 409, error: "Conflict", code: "dates_unavailable", reasons: ["overlap"] },
          409,
        ),
    });

    renderAt(`/p/villa/book?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);
    await screen.findByText("Rp 3.600.000");

    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    // The web composes its own copy from the machine-readable slug (#82).
    expect(await screen.findByText(/those dates were just taken/i)).toBeInTheDocument();
    // No redirect happened.
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends the guest back to pick dates when the hold lapsed before pay (409)", async () => {
    stubFetch({
      ...propertyStub(),
      [`GET /api/public/units/${UNIT_ID}/availability`]: () =>
        json(availableQuote),
      "POST /api/public/bookings": () =>
        json(
          {
            bookingId: BOOKING_ID,
            status: "pending_payment",
            holdExpiresAt: "2026-09-10T12:15:00.000Z",
            totalPriceIdr: 3_600_000,
            nights: 3,
          },
          201,
        ),
      [`POST /api/public/bookings/${BOOKING_ID}/pay`]: () =>
        json(
          { statusCode: 409, error: "Conflict", code: "booking_not_payable", status: "expired" },
          409,
        ),
    });

    renderAt(`/p/villa/book?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);
    await screen.findByText("Rp 3.600.000");

    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    expect(await screen.findByText(/your hold has lapsed/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /pick dates again/i }),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("bounces back to the property when the stay params are missing", async () => {
    stubFetch({});
    renderAt(`/p/villa/book`);
    expect(
      await screen.findByText(/choose your dates on the property page/i),
    ).toBeInTheDocument();
  });
});
