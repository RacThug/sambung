import { useEffect, useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { Menu } from "lucide-react";
import { AccountMenu } from "./account-menu";
import { Sidebar } from "./sidebar";
import { useInboxCount } from "./use-inbox-count";

/**
 * Dashboard shell for every `/app/*` page (grill session 2026-07-23, ADR-0037).
 *
 * Reverses the old flat top-nav boxed to `max-w-4xl` into the shape a dashboard
 * you operate all day wants: a left SIDEBAR (workspace + grouped nav, `sidebar.tsx`)
 * + a slim TOP BAR (mobile nav trigger + account menu) + CONTENT whose width
 * follows the page's job - full-bleed for the wide data views, capped for forms.
 * On mobile the sidebar collapses into a Radix Dialog drawer (focus-trap, Escape,
 * scroll-lock from the headless primitive, per design-system.md).
 */

// The two data-heavy pages go full-width so their wide timeline/table can breathe;
// everything else (forms, detail, lists) caps at ~1024px for a readable measure.
// A route not listed defaults to capped - the safe default for a form-shaped page.
const WIDE_ROUTES = new Set<string>(["/app/calendar", "/app/reservations"]);

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const inboxCount = useInboxCount();

  // Close the drawer whenever the route changes - a nav link inside it was tapped,
  // or a redirect fired. Without this the drawer would sit open over the new page.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  const isWide = WIDE_ROUTES.has(pathname);

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop rail: hidden < md, shown as a fixed column from md up. (The badge
          query lives in AppShell, so it runs regardless of this aside.) */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-card md:flex">
        <Sidebar inboxCount={inboxCount} />
      </aside>

      {/* Mobile drawer: the same nav as a left sheet. Radix Dialog gives the
          focus-trap / Escape / scroll-lock so we don't hand-roll a11y. */}
      <Dialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/40 md:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 w-64 border-r border-border bg-card focus:outline-none md:hidden"
          >
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Sidebar inboxCount={inboxCount} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="-ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
          >
            <Menu className="size-5" />
          </button>
          <div className="ml-auto">
            <AccountMenu />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
          <div className={isWide ? "w-full" : "mx-auto w-full max-w-5xl"}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
