import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { HomePage } from "./features/public-booking/home-page";
import { PropertyPage } from "./features/public-booking/property-page";
import { propertySearchSchema } from "./features/public-booking/property-search";
import { DashboardPage } from "./features/dashboard/dashboard-page";

// Two faces, one SPA: public funnel + (auth-guarded, later) dashboard.
// (architecture.md §4.2)
const rootRoute = createRootRoute({
  component: Outlet,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

// Public funnel entry. Search params are external input (someone can paste
// ?from=garbage into the URL bar), so they go through zod at the boundary -
// same rule as HTTP bodies and webhooks.
const propertyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$slug",
  validateSearch: propertySearchSchema,
  component: PropertyPage,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  component: DashboardPage,
});

// Exported for tests: they build routers with a memory history over the same tree.
export const routeTree = rootRoute.addChildren([
  homeRoute,
  propertyRoute,
  dashboardRoute,
]);

export const router = createRouter({ routeTree });

// Registers this router's route tree with TanStack Router's types, so every
// <Link>, useParams, and useSearch across the app is checked against real routes.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
