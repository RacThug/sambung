import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { HomePage } from "./features/public-booking/home-page";
import { PropertyPage } from "./features/public-booking/property-page";
import { CheckoutPage } from "./features/public-booking/checkout-page";
import { ConfirmationPage } from "./features/public-booking/confirmation-page";
import { propertySearchSchema } from "./features/public-booking/property-search";
import { LoginPage } from "./features/auth/login-page";
import { RegisterPage } from "./features/auth/register-page";
import { authSearchSchema } from "./features/auth/auth-search";
import { AppShell } from "./features/dashboard/app-shell";
import { CalendarPage } from "./features/calendar/calendar-page";
import { calendarSearchSchema } from "./features/calendar/calendar-search";
import { PropertiesPage } from "./features/properties/properties-page";
import { PropertyEditPage } from "./features/properties/property-edit-page";
import { ReservationsPage } from "./features/reservations/reservations-page";
import { reservationsSearchSchema } from "./features/reservations/reservations-search";
import { BookingDetailPage } from "./features/bookings/booking-detail-page";
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

// Checkout (page-spec §3.2). The picker's "Book" CTA lands here carrying the
// quoted range in the same typed `?unit&from&to` params as the property page.
const checkoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$slug/book",
  validateSearch: propertySearchSchema,
  component: CheckoutPage,
});

// Confirmation (page-spec §3.3, #54) - where the Provider returns the guest after
// Snap, and the link in their email. Public: a Guest has no token. Reconciles on
// read and polls to confirmed (ADR-0020).
const bookingLandingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/booking/$bookingId",
  component: ConfirmationPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: authSearchSchema,
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

// Signup (page-spec §3.4). Same already-authed guard and ?next contract as
// /login - an account holder has nothing to register.
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  validateSearch: authSearchSchema,
  beforeLoad: async () => {
    if (await ensureSession()) {
      throw redirect({ to: "/app" });
    }
  },
  component: RegisterPage,
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

// Dashboard home = the unified calendar (page-spec §4.1, #49). /app lands there.
const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/app/calendar" });
  },
});

const calendarRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "calendar",
  // ?from&to&propertyId are external input (a pasted URL); zod at the boundary,
  // degrading bad values to the default month rather than crashing the home page.
  validateSearch: calendarSearchSchema,
  component: CalendarPage,
});

// Reservations list (page-spec §4.2, #51). Every filter is a typed search param,
// AND-ed, so any combination is a shareable URL; like the calendar, bad params
// degrade to no-filter rather than crashing (validateSearch at the boundary).
const reservationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "reservations",
  validateSearch: reservationsSearchSchema,
  component: ReservationsPage,
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

// Booking detail (page-spec §4.3, #50). Deep-linkable: fetches its own row, so a
// bookmarked/forwarded link opens with a cold cache. $bookingId is the path param.
const bookingDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "bookings/$bookingId",
  component: BookingDetailPage,
});

// Exported for tests: they build routers with a memory history over the same tree.
export const routeTree = rootRoute.addChildren([
  homeRoute,
  propertyRoute,
  checkoutRoute,
  bookingLandingRoute,
  loginRoute,
  registerRoute,
  appRoute.addChildren([
    appIndexRoute,
    calendarRoute,
    reservationsRoute,
    propertiesRoute,
    propertyEditRoute,
    bookingDetailRoute,
  ]),
]);

export const router = createRouter({ routeTree });

// Registers this router's route tree with TanStack Router's types, so every
// <Link>, useParams, and useSearch across the app is checked against real routes.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
