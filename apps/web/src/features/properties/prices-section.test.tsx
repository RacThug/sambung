import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { PriceOverrideResponse } from "@sambung/shared";
import { rupiahSchema } from "@sambung/shared";
import { clearSession, setSession } from "../../lib/auth";
import {
  authResponse,
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
const overridesUrl = `GET /api/units/${unitId}/price-overrides`;

function priceOverride(
  overrides: Partial<Omit<PriceOverrideResponse, "nightlyPriceIdr">> & {
    nightlyPriceIdr?: number;
  } = {},
): PriceOverrideResponse {
  const { nightlyPriceIdr = 2_500_000, ...rest } = overrides;
  return {
    id: "cccccccc-0000-0000-0000-000000000001",
    unitId,
    from: "2027-12-20",
    to: "2028-01-05",
    createdAt: "2026-08-17T03:00:00.000Z",
    ...rest,
    nightlyPriceIdr: rupiahSchema.parse(nightlyPriceIdr),
  };
}

function stubEditPage(
  extra: FetchStubs = {},
  overrides: PriceOverrideResponse[] = [priceOverride()],
) {
  return stubFetch({
    [`GET /api/properties/${propertyId}`]: () => json(propertyResponse()),
    [`GET /api/properties/${propertyId}/units`]: () => json([unitResponse()]),
    [`GET /api/units/${unitId}/channels`]: () => json([]),
    [overridesUrl]: () => json(overrides),
    ...extra,
  });
}

/** The panel is collapsed by default; this opens it for the unit. */
async function expandPrices() {
  fireEvent.click(
    await screen.findByRole("button", { name: /seasonal prices/i }),
  );
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

describe("prices section (P0-2, page-spec §4.5 amendment)", () => {
  it("is collapsed by default and only fetches overrides on expand", async () => {
    const calls = stubEditPage();
    renderAt(editUrl);

    // The section renders from the shared units query alone.
    await screen.findByRole("button", { name: /seasonal prices/i });
    expect(calls).not.toContain(overridesUrl);

    await expandPrices();
    await waitFor(() => expect(calls).toContain(overridesUrl));
  });

  it("lists an override as inclusive first-last night with its price", async () => {
    stubEditPage({}, [
      priceOverride({
        from: "2027-12-20",
        to: "2028-01-05",
        nightlyPriceIdr: 2_500_000,
      }),
    ]);
    renderAt(editUrl);
    await expandPrices();

    // Wire [2027-12-20, 2028-01-05) -> the human reads "20 Dec - 4 Jan": the
    // checkout day is not a night (lastNightOf, the one shared half-open rule).
    expect(await screen.findByText(/20 Dec 2027/)).toBeInTheDocument();
    expect(screen.getByText(/4 Jan 2028/)).toBeInTheDocument();
    expect(screen.getByText(/Rp\s*2\.500\.000/)).toBeInTheDocument();
  });

  it("adds an override, sending the wire's half-open `to` (last night + 1)", async () => {
    let posted: unknown;
    stubEditPage(
      {
        [`POST /api/units/${unitId}/price-overrides`]: (init) => {
          posted = JSON.parse(String(init?.body));
          return json(priceOverride(), 201);
        },
      },
      [],
    );
    renderAt(editUrl);
    await expandPrices();

    fireEvent.change(await screen.findByLabelText("First night"), {
      target: { value: "2027-08-01" },
    });
    fireEvent.change(screen.getByLabelText("Last night"), {
      target: { value: "2027-08-31" },
    });
    fireEvent.change(screen.getByLabelText("Price per night (IDR)"), {
      target: { value: "1800000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add price" }));

    await waitFor(() => expect(posted).toBeDefined());
    expect(posted).toEqual({
      from: "2027-08-01",
      to: "2027-09-01", // 31 Aug is the LAST NIGHT; the wire's `to` is exclusive
      nightlyPriceIdr: 1_800_000,
    });
  });

  it("renders the overlap 409 as our own copy on the form", async () => {
    stubEditPage(
      {
        [`POST /api/units/${unitId}/price-overrides`]: () =>
          json(
            {
              statusCode: 409,
              error: "Conflict",
              code: "price_override_overlap",
              message: "server prose that must never render",
            },
            409,
          ),
      },
      [priceOverride()],
    );
    renderAt(editUrl);
    await expandPrices();

    fireEvent.change(await screen.findByLabelText("First night"), {
      target: { value: "2027-12-24" },
    });
    fireEvent.change(screen.getByLabelText("Last night"), {
      target: { value: "2027-12-30" },
    });
    fireEvent.change(screen.getByLabelText("Price per night (IDR)"), {
      target: { value: "3000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add price" }));

    expect(
      await screen.findByText("These dates already have a price override"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/server prose that must never render/),
    ).not.toBeInTheDocument();
  });

  it("removes an override and refetches the list", async () => {
    let deleted = false;
    stubEditPage({
      [`DELETE /api/price-overrides/${priceOverride().id}`]: () => {
        deleted = true;
        return new Response(null, { status: 204 });
      },
    });
    renderAt(editUrl);
    await expandPrices();

    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it("an archived unit shows its prices read-only - no add form, no remove", async () => {
    stubFetch({
      [`GET /api/properties/${propertyId}`]: () => json(propertyResponse()),
      [`GET /api/properties/${propertyId}/units`]: () =>
        json([unitResponse({ archivedAt: "2026-08-01T00:00:00.000Z" })]),
      [`GET /api/units/${unitId}/channels`]: () => json([]),
      [overridesUrl]: () => json([priceOverride()]),
    });
    renderAt(editUrl);
    await expandPrices();

    expect(await screen.findByText(/20 Dec 2027/)).toBeInTheDocument();
    expect(
      screen.getByText(/unarchive it to change prices/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add price" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });
});
