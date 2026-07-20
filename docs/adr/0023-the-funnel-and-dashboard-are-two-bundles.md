# ADR-0023: The funnel and the dashboard are two bundles, and libphonenumber is a leaf chunk

- **Date**: 2026-07-20
- **Status**: Accepted
- **Issue**: #125 (M5, polish; follow-up from the #54 / PR #123 review)
- **Builds on**: ADR-0007 (one brand, two surfaces)

## Context

The web app is a single SPA with two surfaces (architecture §4.2, ADR-0007): the
public funnel (`/p/:slug` → checkout → confirmation), where a stranger decides to
pay, and the auth-guarded dashboard (`/app/*`), where an owner works. Until now
every route component was **statically imported** in `router.tsx`, so Vite
emitted **one** JS chunk (~838 KB raw / ~234 KB gzipped). A guest opening a
property page downloaded the entire dashboard - the calendar, the reservations
table, the property editor - plus `libphonenumber-js` (~30 KB gzipped), a
dependency the funnel touches only at the checkout phone step.

That inverts ADR-0007's whole premise. The funnel is "hand-design where guests
look"; its first-load weight matters more than anywhere else in the app, and the
market is Indonesia - often mobile, variable bandwidth. The #54 review surfaced
this when it added `libphonenumber-js`: a 25 KB leaf dep on the phone field lit up
the fact that *nothing* was split, so the whole SPA paid for it.

## Decision

**Two surfaces, two bundles - and heavy leaf deps load where they're used.**

1. **Every route component loads through `lazyRouteComponent`.** The route *tree*
   stays static in `router.tsx` - paths, zod `validateSearch` schemas, and the
   auth `beforeLoad` guards must be known before a match to route, validate, and
   redirect. Only the leaf **components** defer, each behind a dynamic `import()`,
   so Vite emits one chunk per page and factors shared code (react-query, the API
   client) into common chunks the entry pulls once. A guest on `/p/:slug` gets the
   property chunk and never the dashboard's.

   Chosen over splitting each route into a `.lazy.tsx` stub (the file-based
   idiom): `lazyRouteComponent(() => import(...), "Name")` keeps the whole tree
   readable in one file and needs no per-route boilerplate. Chosen over a coarse
   "funnel eager / dashboard lazy" split because that still ships the checkout's
   `libphonenumber` in the entry every page loads - the split has to be per-route
   to keep it off the property page.

2. **`libphonenumber-js` is loaded lazily at the checkout phone step.** `phone.ts`
   (the country list + E.164 resolver) is a **dynamic** import of the checkout
   page, fetched when the form mounts, not a static one. So even the checkout
   chunk's first paint doesn't block on it, and the property and confirmation
   pages never carry it at all. `phone.ts` itself is unchanged (still a pure,
   tested module); the lazy boundary lives at its import site.

3. **A build-time guard keeps it split.** `vite build` emits a manifest;
   `scripts/check-bundle.mjs` (Node built-ins only, no new dependency) reads it,
   computes the property route's initial-JS closure, and fails if the dashboard or
   the phone chunk is statically reachable from it, if `phone.ts` stops being a
   dynamic import of checkout, or if the gzipped total crosses a budget (185 KB,
   between the ~161 KB measured today and the ~234 KB monolith). The guard is
   **chained into the web `build` script** (`… && node scripts/check-bundle.mjs`),
   so it runs on every build - and since there is no cloud CI and deploy always
   builds, a regression fails there rather than silently regrowing. It stays out of
   the pre-push hook, which is lint+typecheck only: a full web build on every push
   would tax unrelated pushes, and the manifest only exists after a build anyway.

## Consequences

- **The property page's initial JS drops ~234 → ~161 KB gzipped** (10 chunks),
  and no longer contains any dashboard code or `libphonenumber-js`. The dashboard
  and funnel are distinct chunks, provable from the Vite build output.
- **Every navigation now fetches a chunk.** In production these are pre-built and
  served over HTTP in milliseconds; the router shows its pending state and then
  the page. The cost is a per-page round trip, paid once and cached - the right
  trade for a funnel that must be light on first paint.
- **The country `<select>` has a brief loading state** while the phone chunk
  arrives (a disabled "Loading…" placeholder); the rest of the checkout form is
  usable meanwhile, and E.164 assembly at submit awaits the (by then cached)
  module. This is the one visible UX change. If that chunk **fails to fetch** (a
  network blip mid-funnel), the guest gets a **Retry** affordance instead of a
  stuck "Loading…" select, and submit stops cleanly rather than throwing an
  unhandled rejection - one `loadPhoneKit` loader backs the mount, the retry, and
  the submit path (covered by `checkout-phone-load.test.tsx`).
- **Tests get a raised async timeout.** Under vitest each route chunk is
  transformed on first import; that cold transform can exceed testing-library's 1 s
  default before the component resolves, so the first render of a lazy route in a
  file would flake while later ones (chunk cached) pass. `src/test-setup.ts` gives
  async queries headroom - a test-transformer concern, invisible in production.
- **The guard is a real regression fence, not a vanity number.** It asserts the
  *structure* (what's reachable from the property route), not just bytes, so
  re-merging a surface fails the build even if the total happened to stay small.
