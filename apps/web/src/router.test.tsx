import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./router";
import { propertySearchSchema } from "./features/public-booking/property-search";

// Renders the real route tree at a given URL, the same way main.tsx does -
// only the history is swapped for an in-memory one so no browser is needed.
function renderAt(url: string) {
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
}

// jsdom has no scrollTo; the router calls it on navigation (scroll restoration).
window.scrollTo = () => {};

afterEach(cleanup);

describe("route tree", () => {
  it("renders the home page at /", async () => {
    renderAt("/");
    expect(await screen.findByText("Sambung")).toBeInTheDocument();
  });

  it("renders the dashboard at /app", async () => {
    renderAt("/app");
    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
  });

  it("renders the property page at /p/$slug with typed params and dates", async () => {
    renderAt("/p/villa-sunset?from=2026-08-01&to=2026-08-05");
    expect(await screen.findByText("villa-sunset")).toBeInTheDocument();
    expect(screen.getByText(/2026-08-01/)).toBeInTheDocument();
    expect(screen.getByText(/2026-08-05/)).toBeInTheDocument();
  });

  it("drops malformed date params instead of crashing the funnel", async () => {
    renderAt("/p/villa-sunset?from=not-a-date&to=2026-08-05");
    expect(await screen.findByText("villa-sunset")).toBeInTheDocument();
    expect(screen.queryByText(/not-a-date/)).not.toBeInTheDocument();
  });
});

describe("propertySearchSchema", () => {
  it("passes through valid ISO dates", () => {
    expect(
      propertySearchSchema.parse({ from: "2026-08-01", to: "2026-08-05" }),
    ).toEqual({ from: "2026-08-01", to: "2026-08-05" });
  });

  it("degrades malformed values to undefined instead of throwing", () => {
    expect(
      propertySearchSchema.parse({ from: "01/08/2026", to: 42 }),
    ).toEqual({ from: undefined, to: undefined });
  });

  it("accepts missing params", () => {
    expect(propertySearchSchema.parse({})).toEqual({});
  });
});
