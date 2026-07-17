import { vi } from "vitest";
import { render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  rupiahSchema,
  type AuthResponse,
  type PropertyResponse,
  type PublicPropertyResponse,
  type PublicUnit,
  type UnitResponse,
} from "@sambung/shared";
import { routeTree } from "./router";

// jsdom has no scrollTo; the router calls it on navigation (scroll restoration).
window.scrollTo = () => {};

/**
 * Stub responses keyed by "METHOD /api/path". Unmatched requests 404.
 * Handlers receive the RequestInit so tests can assert on request bodies.
 */
export type FetchStubs = Record<string, (init?: RequestInit) => Response>;

export function stubFetch(stubs: FetchStubs) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const key = `${init?.method ?? "GET"} ${url}`;
      calls.push(key);
      const handler = stubs[key];
      return Promise.resolve(
        handler ? handler(init) : new Response(null, { status: 404 }),
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
    photos: [],
    verified: false,
    publishable: false,
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
    createdAt: "2026-07-01T00:00:00.000Z",
    ...rest,
    basePriceIdr: rupiahSchema.parse(basePriceIdr),
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
