/**
 * The two global surfaces `page-spec.md` §2 promised and the router never had:
 * a "full-page error boundary with retry as last resort" and a "404 route for
 * unknown paths" (divergence D6).
 *
 * Until now a render-time throw took the app to a blank white screen and an
 * unknown `/app/typo` matched nothing at all. Both are the last resort behind
 * every per-page state in `_list-pattern.md` §3 - a page that handles its own
 * failed read should never reach these, and reaching one means something threw
 * where nobody expected it.
 *
 * Deliberately plain and dependency-free: the funnel and the dashboard are two
 * bundles (ADR-0023) and these mount on both, so they speak semantic tokens and
 * import nothing but the router.
 */
import { Link, type ErrorComponentProps } from "@tanstack/react-router";

/**
 * A render-time throw. Offers `reset`, which re-mounts the route subtree - the
 * "retry" page-spec §2 asks for, and enough for the transient case (a lazy chunk
 * that failed to fetch, a render that raced a cache reset).
 *
 * The message is deliberately not the thrown error's: an exception string is
 * developer output, and showing it to an owner leaks internals for no benefit.
 * The error still reaches the console.
 */
export function RouteError({ reset }: ErrorComponentProps) {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="text-lg font-semibold text-foreground">
        Something went wrong
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This page didn’t load properly. Trying again usually fixes it.
      </p>
      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Try again
        </button>
        <Link
          to="/app"
          className="rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          Go to the dashboard
        </Link>
      </div>
    </main>
  );
}

/**
 * An unmatched path. Links to the dashboard rather than the landing page: a
 * stranger who mistypes a property URL gets the API's own 404 on `/p/:slug`
 * (which is a real page, handled there), so anything reaching THIS is someone
 * already inside the app who followed a stale link.
 */
export function RouteNotFound() {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="text-lg font-semibold text-foreground">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        That address doesn’t exist. It may have moved, or the link may be
        incomplete.
      </p>
      <Link
        to="/app"
        className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Go to the dashboard
      </Link>
    </main>
  );
}
