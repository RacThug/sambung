import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, LogOut } from "lucide-react";
import { api } from "../../lib/api-client";
import { clearSession } from "../../lib/auth";
import { useSession } from "../../lib/use-session";

/**
 * The account menu in the top bar - the shell's one place for "who am I / sign
 * out" (grill session 2026-07-23). The old top-nav had a bare "Log out" link and
 * never showed the signed-in user; this surfaces the email + role and folds logout
 * into it.
 *
 * Hand-rolled rather than pulling in a Radix dropdown-menu dependency: a small
 * disclosure with the a11y that actually matters here - `aria-haspopup`/
 * `aria-expanded`, Escape to close, outside-click to close. (The mobile nav DOES
 * use Radix Dialog, where the focus-trap is load-bearing; a corner menu is not.)
 */
export function AccountMenu() {
  const session = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!session) return null;
  const { email, role } = session.user;

  async function logout() {
    await api.post("/auth/logout").catch(() => {
      // Even if the server call fails, drop the local session.
    });
    clearSession();
    void navigate({ to: "/login" });
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent"
      >
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-full bg-accent text-xs font-semibold uppercase text-accent-foreground"
        >
          {email.charAt(0)}
        </span>
        <ChevronDown className="size-4 text-muted-foreground" />
        <span className="sr-only">Account menu</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-md border border-border bg-popover shadow-md"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-sm font-medium text-popover-foreground">
              {email}
            </p>
            <p className="text-xs capitalize text-muted-foreground">{role}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <LogOut className="size-4" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
