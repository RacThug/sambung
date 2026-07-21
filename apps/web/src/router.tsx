import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { propertySearchSchema } from "./features/public-booking/property-search";
import { authSearchSchema } from "./features/auth/auth-search";
import { calendarSearchSchema } from "./features/calendar/calendar-search";
import { reservationsSearchSchema } from "./features/reservations/reservations-search";
import { ensureSession } from "./lib/auth";
import { I18nProvider } from "@/i18n/provider";
import { PublicShell } from "@/components/public-shell";

// Two faces, one SPA: public funnel + auth-guarded dashboard (architecture.md
// §4.2). The two surfaces are also two BUNDLES (#125, ADR-0023): every route's
// component is loaded through `lazyRouteComponent`, so each page emits its own
// chunk and a guest on /p/:slug never downloads the dashboard (or the checkout's
// libphonenumber-js). The route TREE below stays static - paths, search-param
// zod schemas, and the auth `beforeLoad` guards must be known before a match to
// route, validate, and redirect; only the leaf components defer.
//
// `lazyRouteComponent(importer, exportName)` wraps a dynamic `import()` into a
// component the router suspends on while the chunk loads (its own Suspense
// boundary), so no route file has to be split into a `.lazy.tsx` stub and the
// whole tree stays readable in one place.
// The i18n provider wraps the whole tree (ADR-0024), so `useI18n` is available to
// any route and every test that renders the real tree gets it. The PublicShell adds
// the language switcher bar on the public funnel + auth pages only (page-spec §2:
// "public pages + login"); it renders nothing on /app, so the dashboard stays
// English. Kept at the root - not a pathless layout route - so the route tree and
// every absolute path stay exactly as they were.
const rootRoute = createRootRoute({
  component: () => (
    <I18nProvider>
      <PublicShell />
      <Outlet />
    </I18nProvider>
  ),
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(
    () => import("./features/public-booking/home-page"),
    "HomePage",
  ),
});

// Public funnel entry. Search params are external input (someone can paste
// ?from=garbage into the URL bar), so they go through zod at the boundary -
// same rule as HTTP bodies and webhooks.
const propertyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$slug",
  validateSearch: propertySearchSchema,
  component: lazyRouteComponent(
    () => import("./features/public-booking/property-page"),
    "PropertyPage",
  ),
});

// Checkout (page-spec §3.2). The picker's "Book" CTA lands here carrying the
// quoted range in the same typed `?unit&from&to` params as the property page.
const checkoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$slug/book",
  validateSearch: propertySearchSchema,
  component: lazyRouteComponent(
    () => import("./features/public-booking/checkout-page"),
    "CheckoutPage",
  ),
});

// Confirmation (page-spec §3.3, #54) - where the Provider returns the guest after
// Snap, and the link in their email. Public: a Guest has no token. Reconciles on
// read and polls to confirmed (ADR-0020).
const bookingLandingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/booking/$bookingId",
  component: lazyRouteComponent(
    () => import("./features/public-booking/confirmation-page"),
    "ConfirmationPage",
  ),
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
  component: lazyRouteComponent(
    () => import("./features/auth/login-page"),
    "LoginPage",
  ),
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
  component: lazyRouteComponent(
    () => import("./features/auth/register-page"),
    "RegisterPage",
  ),
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
  component: lazyRouteComponent(
    () => import("./features/dashboard/app-shell"),
    "AppShell",
  ),
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
  component: lazyRouteComponent(
    () => import("./features/calendar/calendar-page"),
    "CalendarPage",
  ),
});

// Reservations list (page-spec §4.2, #51). Every filter is a typed search param,
// AND-ed, so any combination is a shareable URL; like the calendar, bad params
// degrade to no-filter rather than crashing (validateSearch at the boundary).
const reservationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "reservations",
  validateSearch: reservationsSearchSchema,
  component: lazyRouteComponent(
    () => import("./features/reservations/reservations-page"),
    "ReservationsPage",
  ),
});

// The operations inbox: sync conflicts (#38, ADR-0027) + paid-but-lapsed payments
// (#120, ADR-0022). Both are "the system did the safe thing and now needs a human" -
// a double-sold room, or money captured for dates that no longer hold. No search
// params - each is a whole (small) list, acted on in place.
const inboxRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "inbox",
  component: lazyRouteComponent(
    () => import("./features/dashboard/inbox-page"),
    "InboxPage",
  ),
});

const propertiesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "properties",
  component: lazyRouteComponent(
    () => import("./features/properties/properties-page"),
    "PropertiesPage",
  ),
});

const propertyEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "properties/$propertyId",
  component: lazyRouteComponent(
    () => import("./features/properties/property-edit-page"),
    "PropertyEditPage",
  ),
});

// Tenant settings (page-spec §4.6, #67). One knob today - the gallery cap - and
// the home #57 will hang staff/Team settings on. Readable by staff; the write is
// owner-only and the server enforces that.
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "settings",
  component: lazyRouteComponent(
    () => import("./features/settings/settings-page"),
    "SettingsPage",
  ),
});

// Booking detail (page-spec §4.3, #50). Deep-linkable: fetches its own row, so a
// bookmarked/forwarded link opens with a cold cache. $bookingId is the path param.
const bookingDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "bookings/$bookingId",
  component: lazyRouteComponent(
    () => import("./features/bookings/booking-detail-page"),
    "BookingDetailPage",
  ),
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
    inboxRoute,
    propertiesRoute,
    propertyEditRoute,
    bookingDetailRoute,
    settingsRoute,
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
