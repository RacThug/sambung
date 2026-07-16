import { vi } from "vitest";
import { render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthResponse } from "@sambung/shared";
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
