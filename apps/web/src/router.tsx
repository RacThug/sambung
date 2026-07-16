import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { HomePage } from "./features/public-booking/home-page";
import { PropertyPage } from "./features/public-booking/property-page";
import { propertySearchSchema } from "./features/public-booking/property-search";
import { LoginPage } from "./features/auth/login-page";
import { loginSearchSchema } from "./features/auth/login-search";
import { AppShell } from "./features/dashboard/app-shell";
import { PropertiesPage } from "./features/properties/properties-page";
import { PropertyEditPage } from "./features/properties/property-edit-page";
import { ensureSession } from "./lib/auth";

// Two faces, one SPA: public funnel + auth-guarded dashboard.
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

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: loginSearchSchema,
  // Already authed → straight to the dashboard (page-spec §3.4). ensureSession
  // (not just the in-memory token) so a reload with a live refresh cookie
  // skips the form too.
  beforeLoad: async () => {
    if (await ensureSession()) {
      throw redirect({ to: "/app" });
    }
  },
  component: LoginPage,
});

// Auth guard for everything under /app: no token in memory → one silent
// refresh → otherwise bounce to /login carrying the intended URL. (page-spec §2)
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app",
  beforeLoad: async ({ location }) => {
    if (!(await ensureSession())) {
      throw redirect({ to: "/login", search: { next: location.href } });
    }
  },
  component: AppShell,
});

// Dashboard home. Properties for now; the unified calendar takes over in M2.
const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/app/properties" });
  },
});

const propertiesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "properties",
  component: PropertiesPage,
});

const propertyEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "properties/$propertyId",
  component: PropertyEditPage,
});

// Exported for tests: they build routers with a memory history over the same tree.
export const routeTree = rootRoute.addChildren([
  homeRoute,
  propertyRoute,
  loginRoute,
  appRoute.addChildren([appIndexRoute, propertiesRoute, propertyEditRoute]),
]);

export const router = createRouter({ routeTree });

// Registers this router's route tree with TanStack Router's types, so every
// <Link>, useParams, and useSearch across the app is checked against real routes.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
