import { useRouterState } from "@tanstack/react-router";
import { LanguageSwitcher } from "./language-switcher";

/**
 * The public shell's language-switcher bar (page-spec §2, ADR-0024). Rendered once
 * at the route-tree root, above the matched page, but ONLY on the public funnel +
 * auth pages - it returns null under /app, so the dashboard stays English
 * (owner-facing). Gating by pathname keeps the route tree and every absolute path
 * untouched (no pathless layout route).
 *
 * Deliberately NO wordmark here - the home and auth pages render their own, and a
 * second would be a duplicate lockup.
 */
export function PublicShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // /app is the dashboard. /invite is an account page for an incoming STAFF
  // member - operator-facing like the dashboard, and its invite email is English
  // too, so offering three languages there would be a promise the rest of that
  // journey doesn't keep (#57).
  if (pathname.startsWith("/app") || pathname.startsWith("/invite")) return null;
  return (
    <header className="flex items-center justify-end px-6 py-3">
      <LanguageSwitcher />
    </header>
  );
}
