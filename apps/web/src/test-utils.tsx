import { vi } from "vitest";
import { render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_GALLERY_CAP,
  PHOTO_GALLERY_CEILING,
  rupiahSchema,
  type AuthResponse,
  type ChannelConnectionResponse,
  type PropertyResponse,
  type PublicPropertyResponse,
  type PublicUnit,
  type TenantSettingsResponse,
  type UnitResponse,
} from "@sambung/shared";
import { routeTree } from "./router";

// jsdom has no scrollTo; the router calls it on navigation (scroll restoration).
window.scrollTo = () => {};

/**
 * Stub responses keyed by "METHOD /api/path". Unmatched requests 404.
 * Handlers receive the RequestInit (so tests can assert on request bodies) and
 * the full request URL.
 *
 * Matching is exact first, then falls back to "METHOD /api/pathname" - the URL
 * with its query string stripped. That lets a caller stub an endpoint whose
 * query varies per call (the availability quote fires once per visible month and
 * once per selection) without pinning every from/to combination; the handler
 * reads the URL to branch. Exact keys still win, so existing stubs are unchanged.
 */
export type FetchStubs = Record<
  string,
  (init?: RequestInit, url?: string) => Response
>;

export function stubFetch(stubs: FetchStubs) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      const pathname = url.split("?")[0];
      const handler = stubs[`${method} ${url}`] ?? stubs[`${method} ${pathname}`];
      return Promise.resolve(
        handler ? handler(init, url) : new Response(null, { status: 404 }),
      );
    },
  );
  return calls;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * One PropertyResponse factory for all tests: a new field on the contract
 * means one edit here, not one per test file.
 */
export function propertyResponse(
  overrides: Partial<PropertyResponse> = {},
): PropertyResponse {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    tenantId: authResponse().tenant.id,
    name: "Seminyak Beach Villa",
    slug: "seminyak-beach-villa",
    address: "Jl. Kayu Aya, Seminyak",
    latitude: null,
    longitude: null,
    description: null,
    licenseNo: null,
    depositPct: 100,
    timeZone: "Asia/Makassar",
    photos: [],
    verified: false,
    publishable: false,
    archivedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * One PublicPropertyResponse factory, same reason as above.
 *
 * A separate factory rather than a slice of propertyResponse(), because the
 * public payload is a deliberate subset and not a projection of the owner's one
 * (api-spec §4.7): deriving it here would quietly re-couple the two shapes the
 * API works to keep apart, and a test built on that could not notice licenseNo
 * arriving. Prices come in as plain numbers and are branded here, exactly as
 * unitResponse does below.
 */
export function publicPropertyResponse(
  overrides: Partial<Omit<PublicPropertyResponse, "units">> & {
    units?: Array<Partial<Omit<PublicUnit, "basePriceIdr">> & { basePriceIdr?: number }>;
  } = {},
): PublicPropertyResponse {
  const { units, ...rest } = overrides;
  return {
    slug: "seminyak-beach-villa",
    name: "Seminyak Beach Villa",
    address: "Jl. Kayu Aya, Seminyak",
    description: null,
    verified: false,
    depositPct: 100,
    photos: [],
    units: (units ?? []).map((u, i) => ({
      id: `bbbbbbbb-0000-0000-0000-00000000000${i + 1}`,
      name: "Garden Room",
      maxGuests: 2,
      minStay: 1,
      ...u,
      basePriceIdr: rupiahSchema.parse(u.basePriceIdr ?? 1_200_000),
    })),
    ...rest,
  };
}

/**
 * One UnitResponse factory for all tests, for the same reason as above.
 *
 * `basePriceIdr` is taken as a plain number and branded here. That keeps the
 * brand strict where it earns its keep - production code can't put a bare number
 * on the wire without going through toRupiah()/rupiahSchema, which is what makes
 * "one serialization helper" (api-spec §8.4) a type error rather than a
 * convention - while sparing every test a rupiahSchema.parse() ceremony.
 */
export function unitResponse(
  overrides: Partial<Omit<UnitResponse, "basePriceIdr">> & {
    basePriceIdr?: number;
  } = {},
): UnitResponse {
  const { basePriceIdr = 1_200_000, ...rest } = overrides;
  return {
    id: "bbbbbbbb-0000-0000-0000-000000000001",
    propertyId: propertyResponse().id,
    tenantId: authResponse().tenant.id,
    name: "Garden Room 1",
    maxGuests: 2,
    minStay: 1,
    archivedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...rest,
    basePriceIdr: rupiahSchema.parse(basePriceIdr),
  };
}

/** One ChannelConnectionResponse factory, same reason as the others. */
export function channelConnectionResponse(
  overrides: Partial<ChannelConnectionResponse> = {},
): ChannelConnectionResponse {
  return {
    id: "cccccccc-0000-0000-0000-000000000001",
    unitId: unitResponse().id,
    channel: "airbnb",
    importIcalUrl: "https://www.airbnb.com/calendar/ical/12345.ics",
    lastSyncedAt: "2026-07-19T00:00:00.000Z",
    lastStatus: "ok",
    lastError: null,
    openConflicts: 0,
    createdAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

/** One TenantSettingsResponse factory, same reason as the others (#67). */
export function tenantSettingsResponse(
  overrides: Partial<TenantSettingsResponse> = {},
): TenantSettingsResponse {
  return {
    galleryCap: DEFAULT_GALLERY_CAP,
    galleryCeiling: PHOTO_GALLERY_CEILING,
    ...overrides,
  };
}

export function authResponse(): AuthResponse {
  return {
    accessToken: "test-token",
    user: {
      id: "11111111-1111-1111-1111-111111111111",
      email: "owner@test.dev",
      role: "owner",
      tenantId: "22222222-2222-2222-2222-222222222222",
    },
    tenant: {
      id: "22222222-2222-2222-2222-222222222222",
      name: "Test Tenant",
    },
  };
}

/** Renders the real route tree at a URL, the same way main.tsx does. */
export function renderAt(url: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
