import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { api } from "../../lib/api-client";
import { clearSession } from "../../lib/auth";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { Wordmark } from "@/components/wordmark";

// Nav-link styling, split so exactly one colour class applies at a time: the base
// carries no colour (concatenating an active + idle colour would leave precedence
// to CSS source order), TanStack swaps in the active or idle colour by route.
const navLink = "text-sm font-medium hover:text-primary";
const navLinkActive = { className: "text-primary" };
const navLinkIdle = { className: "text-foreground" };

// Dashboard chrome for every /app/* page: brand, nav, session controls.
// The unified calendar joins the nav in M2, channels in M4. (page-spec §4)
export function AppShell() {
  const navigate = useNavigate();

  async function logout() {
    await api.post("/auth/logout").catch(() => {
      // Even if the server call fails, drop the local session.
    });
    clearSession();
    void navigate({ to: "/login" });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <nav className="flex items-center gap-6">
            <Link to="/app/calendar" aria-label="Sambung home">
              <Wordmark className="text-lg" />
            </Link>
            <Link to="/app/calendar" className={navLink} activeProps={navLinkActive} inactiveProps={navLinkIdle}>
              Calendar
            </Link>
            <Link to="/app/reservations" className={navLink} activeProps={navLinkActive} inactiveProps={navLinkIdle}>
              Reservations
            </Link>
            <Link to="/app/inbox" className={navLink} activeProps={navLinkActive} inactiveProps={navLinkIdle}>
              Inbox
            </Link>
            <Link to="/app/properties" className={navLink} activeProps={navLinkActive} inactiveProps={navLinkIdle}>
              Properties
            </Link>
            <Link to="/app/settings" className={navLink} activeProps={navLinkActive} inactiveProps={navLinkIdle}>
              Settings
            </Link>
          </nav>
          <div className="flex items-center gap-4">
            <WorkspaceSwitcher />
            <button
              type="button"
              onClick={() => void logout()}
              className="text-sm font-medium text-foreground hover:text-primary"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
