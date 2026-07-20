import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  json,
  publicPropertyResponse,
  renderAt,
  stubFetch,
} from "../test-utils";
import { getLocale, setLocale } from "./locale";

/**
 * The public funnel in EN / ID / ZH end to end (issue #58 ACs, ADR-0024): copy is
 * localized, the choice persists per visitor, the wire format stays YYYY-MM-DD
 * while displayed dates follow the locale, and the API request carries the
 * visitor's Accept-Language.
 */

const UNIT_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const BOOKING_ID = "cccccccc-0000-0000-0000-000000000001";
const REDIRECT = "https://sandbox.midtrans.example/snap/xyz";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Reset the persisted choice so each test starts from the same ground.
  localStorage.clear();
  setLocale("en");
});

describe("public funnel i18n (#58)", () => {
  it("renders the property page copy in Bahasa Indonesia", async () => {
    setLocale("id");
    stubFetch({
      "GET /api/public/properties/villa": () =>
        json(
          publicPropertyResponse({
            slug: "villa",
            name: "Villa X",
            units: [{ name: "Garden Room", basePriceIdr: 1_200_000 }],
          }),
        ),
    });
    renderAt("/p/villa");

    await screen.findByRole("heading", { name: "Villa X" });
    // "Rooms" -> "Kamar"; "Check availability" -> "Cek ketersediaan".
    expect(screen.getByRole("heading", { name: "Kamar" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cek ketersediaan" }),
    ).toBeInTheDocument();
  });

  it("renders the property page copy in Chinese", async () => {
    setLocale("zh");
    stubFetch({
      "GET /api/public/properties/villa": () =>
        json(
          publicPropertyResponse({
            slug: "villa",
            name: "Villa X",
            units: [{ name: "Garden Room", basePriceIdr: 1_200_000 }],
          }),
        ),
    });
    renderAt("/p/villa");

    await screen.findByRole("heading", { name: "Villa X" });
    expect(screen.getByRole("heading", { name: "房间" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "查看空房" }),
    ).toBeInTheDocument();
  });

  it("localizes availability blocked-reasons from the slug (AC: reasons localized)", async () => {
    // The wire carries a language-neutral slug; the SPA renders localized copy.
    setLocale("zh");
    stubFetch({
      "GET /api/public/properties/villa": () =>
        json(
          publicPropertyResponse({
            slug: "villa",
            name: "Villa X",
            units: [{ id: UNIT_ID, name: "Garden Room", basePriceIdr: 1_200_000, minStay: 3 }],
          }),
        ),
      [`GET /api/public/units/${UNIT_ID}/availability`]: (_i, url) => {
        const u = new URL(url!, "http://t");
        return json({
          available: u.searchParams.get("from") !== "2026-09-10",
          nights: 1,
          totalPriceIdr: 1_200_000,
          minStay: 3,
          reasons: u.searchParams.get("from") === "2026-09-10" ? ["min_stay"] : [],
          blockedRanges: [],
        });
      },
    });
    renderAt(`/p/villa?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-11`);

    // "This room has a 3 nights minimum stay." in Chinese, count uninflected.
    expect(await screen.findByText("此房间最少需入住 3 晚。")).toBeInTheDocument();
  });

  it("persists the visitor's choice via the switcher (AC: choice persists)", async () => {
    stubFetch({
      "GET /api/public/properties/villa": () =>
        json(publicPropertyResponse({ slug: "villa", name: "Villa X", units: [] })),
    });
    renderAt("/p/villa");
    await screen.findByRole("heading", { name: "Villa X" });

    // Starts English (the switcher is labelled "Language").
    const switcher = screen.getByRole("combobox", { name: "Language" });
    fireEvent.change(switcher, { target: { value: "id" } });

    // The choice is written to localStorage (the token rule is unaffected).
    expect(localStorage.getItem("sambung.lang")).toBe("id");
    expect(getLocale()).toBe("id");
    // And the UI re-renders in the new language.
    expect(
      await screen.findByRole("combobox", { name: "Bahasa" }),
    ).toBeInTheDocument();
  });

  it("books end to end in Chinese: display follows locale, wire stays YYYY-MM-DD", async () => {
    setLocale("zh");
    // Redirect target for the Provider handoff.
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "http://localhost/", origin: "http://localhost" },
    });

    let createInit: RequestInit | undefined;
    stubFetch({
      "GET /api/public/properties/villa": () =>
        json(publicPropertyResponse({ slug: "villa", depositPct: 100 })),
      [`GET /api/public/units/${UNIT_ID}/availability`]: () =>
        json({
          available: true,
          nights: 3,
          totalPriceIdr: 3_600_000,
          minStay: 1,
          reasons: [],
          blockedRanges: [],
        }),
      "POST /api/public/bookings": (init) => {
        createInit = init;
        return json(
          {
            bookingId: BOOKING_ID,
            status: "pending_payment",
            holdExpiresAt: "2026-09-10T12:15:00.000Z",
            totalPriceIdr: 3_600_000,
            nights: 3,
          },
          201,
        );
      },
      [`POST /api/public/bookings/${BOOKING_ID}/pay`]: () =>
        json(
          {
            provider: "midtrans",
            token: "snap-token",
            redirectUrl: REDIRECT,
            amountIdr: 3_600_000,
            deposit: false,
          },
          201,
        ),
    });

    renderAt(`/p/villa/book?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);

    // The checkout heading is Chinese ("Request to book" -> "提交预订").
    expect(await screen.findByText("提交预订")).toBeInTheDocument();
    // The displayed stay follows the ZH date locale (year-first with CJK markers),
    // never the raw ISO string.
    expect(screen.getByText(/2026年9月10日/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("全名"), {
      target: { value: "Wang" },
    });
    fireEvent.change(screen.getByLabelText("WhatsApp 号码"), {
      target: { value: "0812 3456 7890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续付款" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));

    // The wire format is language-neutral YYYY-MM-DD regardless of the locale.
    const body = JSON.parse(String(createInit?.body ?? "{}"));
    expect(body.checkIn).toBe("2026-09-10");
    expect(body.checkOut).toBe("2026-09-13");
    // And the request advertised the visitor's language (api-spec §1, ADR-0024).
    const headers = createInit?.headers as Record<string, string>;
    expect(headers["Accept-Language"]).toBe("zh");
  });

  it("books end to end in Bahasa Indonesia: display follows locale, wire stays YYYY-MM-DD", async () => {
    setLocale("id");
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { assign, href: "http://localhost/", origin: "http://localhost" },
    });

    let createInit: RequestInit | undefined;
    stubFetch({
      "GET /api/public/properties/villa": () =>
        json(publicPropertyResponse({ slug: "villa", depositPct: 100 })),
      [`GET /api/public/units/${UNIT_ID}/availability`]: () =>
        json({
          available: true,
          nights: 3,
          totalPriceIdr: 3_600_000,
          minStay: 1,
          reasons: [],
          blockedRanges: [],
        }),
      "POST /api/public/bookings": (init) => {
        createInit = init;
        return json(
          {
            bookingId: BOOKING_ID,
            status: "pending_payment",
            holdExpiresAt: "2026-09-10T12:15:00.000Z",
            totalPriceIdr: 3_600_000,
            nights: 3,
          },
          201,
        );
      },
      [`POST /api/public/bookings/${BOOKING_ID}/pay`]: () =>
        json(
          {
            provider: "midtrans",
            token: "snap-token",
            redirectUrl: REDIRECT,
            amountIdr: 3_600_000,
            deposit: false,
          },
          201,
        ),
    });

    renderAt(`/p/villa/book?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);

    // The checkout heading is Indonesian ("Request to book" -> "Ajukan pemesanan").
    expect(await screen.findByText("Ajukan pemesanan")).toBeInTheDocument();
    // The displayed stay follows the id-ID date locale ("10 Sep 2026"), never the
    // raw ISO string.
    expect(screen.getByText(/10 Sep 2026/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Nama lengkap"), {
      target: { value: "Budi" },
    });
    fireEvent.change(screen.getByLabelText("Nomor WhatsApp"), {
      target: { value: "0812 3456 7890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lanjutkan ke pembayaran" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));

    // The wire format is language-neutral YYYY-MM-DD regardless of the locale.
    const body = JSON.parse(String(createInit?.body ?? "{}"));
    expect(body.checkIn).toBe("2026-09-10");
    expect(body.checkOut).toBe("2026-09-13");
    const headers = createInit?.headers as Record<string, string>;
    expect(headers["Accept-Language"]).toBe("id");
  });

  it("renders the confirmation party view in Bahasa Indonesia", async () => {
    setLocale("id");
    stubFetch({
      [`GET /api/public/bookings/${BOOKING_ID}`]: () =>
        json({
          status: "confirmed",
          checkIn: "2027-03-10",
          checkOut: "2027-03-14",
          propertyName: "Villa X",
          unitName: "Garden Room",
          totalPriceIdr: 4_000_000,
          amountPaidIdr: 4_000_000,
          waLink: null,
        }),
    });
    renderAt(`/booking/${BOOKING_ID}`);

    // "You're all set" -> "Anda sudah siap".
    expect(await screen.findByText("Anda sudah siap")).toBeInTheDocument();
  });
});
