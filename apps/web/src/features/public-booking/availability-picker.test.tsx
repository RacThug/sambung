import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { json, publicPropertyResponse, renderAt, stubFetch } from "../../test-utils";

/**
 * The availability picker on `/p/:slug` (page-spec §3.1, FR-CAL-1/2, #93).
 *
 * Date is pinned to 2026-08-15 (local) so "past" and the visible month are
 * deterministic; only Date is faked, so the ~300 ms quote debounce runs on a
 * real timer and `findBy*` waits it out honestly.
 */

const UNIT_ID = "bbbbbbbb-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 15, 12, 0, 0)); // 15 Aug 2026, local noon
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type PropUnits = NonNullable<
  NonNullable<Parameters<typeof publicPropertyResponse>[0]>["units"]
>;

/** The one property read, plus the availability endpoint answered by a responder
 * that branches on the query's `from`/`to` (month sweep vs concrete selection). */
function stub(units: PropUnits, responder: (from: string, to: string) => unknown) {
  return stubFetch({
    "GET /api/public/properties/villa": () =>
      json(publicPropertyResponse({ slug: "villa", name: "Villa X", units })),
    [`GET /api/public/units/${UNIT_ID}/availability`]: (_init, url) => {
      const u = new URL(url!, "http://t");
      const from = u.searchParams.get("from")!;
      const to = u.searchParams.get("to")!;
      const body = responder(from, to);
      return json(body, (body as { _status?: number })._status ?? 200);
    },
  });
}

const quote = (o: Record<string, unknown> = {}) => ({
  available: true,
  nights: 3,
  totalPriceIdr: 3_600_000,
  minStay: 1,
  reasons: [],
  blockedRanges: [],
  ...o,
});

const noBlocks = quote({ available: false, reasons: [], blockedRanges: [] });

describe("availability picker", () => {
  it("queries the visible month to grey booked nights, and prompts for dates", async () => {
    const calls = stub([{ basePriceIdr: 1_200_000 }], () => noBlocks);
    renderAt(`/p/villa?unit=${UNIT_ID}`);

    // Empty state: no dates picked yet.
    expect(
      await screen.findByText(/select your check-in and check-out/i),
    ).toBeInTheDocument();

    // Mode 1 (api-spec §5.1): the whole August window is swept for booked nights.
    expect(calls).toContain(
      `GET /api/public/units/${UNIT_ID}/availability?from=2026-08-01&to=2026-09-01`,
    );
  });

  it("disables past dates - today's browser-local past is unbookable", async () => {
    stub([{ basePriceIdr: 1_200_000 }], () => noBlocks);
    renderAt(`/p/villa?unit=${UNIT_ID}`);

    // The 10th is before the pinned today (the 15th) -> disabled; the 20th is not.
    const past = (await screen.findByText("10")).closest("button")!;
    const future = screen.getByText("20").closest("button")!;
    expect(past).toBeDisabled();
    expect(future).toBeEnabled();
  });

  it("reproduces the available quote from a shared ?from&to URL, with a Book CTA", async () => {
    stub([{ basePriceIdr: 1_200_000 }], (from) =>
      from === "2026-09-10"
        ? quote({ available: true, nights: 3, totalPriceIdr: 3_600_000 })
        : noBlocks,
    );
    renderAt(`/p/villa?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);

    expect(await screen.findByText("Available")).toBeInTheDocument();
    expect(screen.getByText("Rp 3.600.000")).toBeInTheDocument();

    const book = screen.getByRole("link", { name: /book these dates/i });
    const href = book.getAttribute("href")!;
    expect(href).toContain("/p/villa/book");
    expect(href).toContain(`unit=${UNIT_ID}`);
    expect(href).toContain("from=2026-09-10");
    expect(href).toContain("to=2026-09-13");
  });

  it("selecting a range writes ?from&to, shows checking, then the quote", async () => {
    stub([{ basePriceIdr: 1_200_000 }], (from, to) =>
      from === "2026-08-20" && to === "2026-08-23"
        ? quote({ available: true, nights: 3, totalPriceIdr: 3_600_000 })
        : noBlocks,
    );
    // Check-in already chosen; one click on the 23rd completes the stay.
    const router = renderAt(`/p/villa?unit=${UNIT_ID}&from=2026-08-20`);
    await screen.findByText(/select your check-in and check-out/i);

    fireEvent.click(screen.getByText("23").closest("button")!);

    // The 300 ms debounce guarantees a real "checking" window findBy will catch.
    expect(await screen.findByText(/checking availability/i)).toBeInTheDocument();
    expect(await screen.findByText("Available")).toBeInTheDocument();

    // State lives in the URL (AC): the checkout write landed in ?to.
    expect(router.state.location.search).toMatchObject({
      from: "2026-08-20",
      to: "2026-08-23",
    });
  });

  it("shows the minimum for a too-short stay, and no Book CTA", async () => {
    stub([{ basePriceIdr: 1_200_000, minStay: 3 }], (from) =>
      from === "2026-09-10"
        ? quote({ available: false, nights: 1, minStay: 3, reasons: ["min_stay"] })
        : noBlocks,
    );
    renderAt(`/p/villa?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-11`);

    expect(
      await screen.findByText(/3 nights minimum stay/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /book/i }),
    ).not.toBeInTheDocument();
  });

  it("highlights the clipped booked nights on an overlap, and no Book CTA", async () => {
    stub([{ basePriceIdr: 1_200_000 }], (from) =>
      from === "2026-09-10"
        ? quote({
            available: false,
            nights: 6,
            reasons: ["overlap"],
            blockedRanges: [{ from: "2026-09-13", to: "2026-09-15" }],
          })
        : noBlocks,
    );
    renderAt(`/p/villa?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-16`);

    expect(
      await screen.findByText(/already booked/i),
    ).toBeInTheDocument();
    // The clipped nights (13th-14th; the 15th is a free checkout day) are named.
    const booked = screen.getByText(/booked:/i).closest("li")!;
    expect(booked).toHaveTextContent(/13/);
    expect(booked).toHaveTextContent(/14/);
    expect(booked).not.toHaveTextContent(/15/);
    expect(
      screen.queryByRole("link", { name: /book/i }),
    ).not.toBeInTheDocument();
  });

  it("renders a zero-priced unit as not bookable, with no picker or CTA", async () => {
    stub([{ basePriceIdr: 0 }], () => noBlocks);
    renderAt(`/p/villa?unit=${UNIT_ID}`);

    expect(await screen.findByText(/not bookable yet/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /check availability/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /book/i }),
    ).not.toBeInTheDocument();
  });

  it("offers an inline retry on an availability error, page still usable", async () => {
    stub([{ basePriceIdr: 1_200_000 }], (from) =>
      from === "2026-09-10"
        ? { _status: 500, statusCode: 500, message: "boom" }
        : noBlocks,
    );
    renderAt(`/p/villa?unit=${UNIT_ID}&from=2026-09-10&to=2026-09-13`);

    expect(await screen.findByText(/couldn’t check those dates/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // The property page around the picker is untouched.
    expect(screen.getByRole("heading", { name: "Villa X" })).toBeInTheDocument();
  });
});
