import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { api } from "../../lib/api-client";
import { clearSession, getSession } from "../../lib/auth";

// Dashboard chrome for every /app/* page: brand, nav, session controls.
// The unified calendar joins the nav in M2, channels in M4. (page-spec §4)
export function AppShell() {
  const navigate = useNavigate();
  const session = getSession();

  async function logout() {
    await api.post("/auth/logout").catch(() => {
      // Even if the server call fails, drop the local session.
    });
    clearSession();
    void navigate({ to: "/login" });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <nav className="flex items-center gap-6">
            <span className="font-bold text-brand-600">Sambung</span>
            <Link
              to="/app/properties"
              className="text-sm font-medium text-gray-700 hover:text-brand-600"
            >
              Properties
            </Link>
          </nav>
          <div className="flex items-center gap-4">
            {session && (
              <span className="text-sm text-gray-500">
                {session.tenant.name}
              </span>
            )}
            <button
              type="button"
              onClick={() => void logout()}
              className="text-sm font-medium text-gray-700 hover:text-brand-600"
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
