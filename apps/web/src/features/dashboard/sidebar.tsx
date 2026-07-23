import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Building2,
  CalendarDays,
  ClipboardList,
  Inbox,
  Settings,
} from "lucide-react";
import { Wordmark } from "@/components/wordmark";
import { WorkspaceSwitcher } from "./workspace-switcher";

// Nav-link styling, split so exactly one state applies at a time (concatenating
// active + idle would leave precedence to CSS source order): the base carries
// layout only, TanStack swaps in the active or idle set by route. Active = the
// terracotta tint (accent), the "you are here" fill; idle is quiet until hover.
const navLink =
  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors";
const navLinkActive = {
  className: "bg-accent font-medium text-accent-foreground",
};
const navLinkIdle = {
  className: "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
};
const iconClass = "size-4 shrink-0";

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

/**
 * The sidebar contents - shared by the desktop rail (always mounted) and the
 * mobile drawer (the Radix Dialog in app-shell). Rewrites the old flat top-nav
 * into: the workspace context at the top, then nav grouped Operate / Manage with
 * icons (grill session 2026-07-23, ADR-0037).
 *
 * `inboxCount` is passed in (owned by the shell) rather than read here, so the
 * badge query subscribes once at the shell and both this desktop + drawer copy
 * render the same number.
 */
export function SidebarNav({ inboxCount }: { inboxCount: number }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-3 border-b border-border p-4">
        <Link to="/app/calendar" aria-label="Sambung home" className="w-fit">
          <Wordmark className="text-lg" />
        </Link>
        <WorkspaceSwitcher />
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        <NavGroup label="Operate">
          <Link
            to="/app/calendar"
            className={navLink}
            activeProps={navLinkActive}
            inactiveProps={navLinkIdle}
          >
            <CalendarDays className={iconClass} />
            Calendar
          </Link>
          <Link
            to="/app/reservations"
            className={navLink}
            activeProps={navLinkActive}
            inactiveProps={navLinkIdle}
          >
            <ClipboardList className={iconClass} />
            Reservations
          </Link>
          <Link
            to="/app/inbox"
            className={navLink}
            activeProps={navLinkActive}
            inactiveProps={navLinkIdle}
          >
            <Inbox className={iconClass} />
            Inbox
            {inboxCount > 0 && (
              <span
                aria-label={`${inboxCount} items need attention`}
                className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold tabular-nums text-primary-foreground"
              >
                {inboxCount}
              </span>
            )}
          </Link>
        </NavGroup>

        <NavGroup label="Manage">
          <Link
            to="/app/properties"
            className={navLink}
            activeProps={navLinkActive}
            inactiveProps={navLinkIdle}
          >
            <Building2 className={iconClass} />
            Properties
          </Link>
          <Link
            to="/app/settings"
            className={navLink}
            activeProps={navLinkActive}
            inactiveProps={navLinkIdle}
          >
            <Settings className={iconClass} />
            Settings
          </Link>
        </NavGroup>
      </nav>
    </div>
  );
}
