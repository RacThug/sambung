import type { AuthResponse } from "@sambung/shared";

// The access token lives in MEMORY ONLY - never localStorage (XSS = full
// account takeover). A page reload loses it by design; the httpOnly refresh
// cookie silently restores the session. (architecture.md §4.4)
type Session = Pick<AuthResponse, "user" | "tenant" | "memberships">;

let session: Session | null = null;
let accessToken: string | null = null;

// The switcher has to re-render when the tenant changes, and `session` is a
// module-level `let` by design (see above), so subscribers are how a component
// learns. Deliberately not a store library: one value, one event (#154).
const listeners = new Set<() => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function getSession(): Session | null {
  return session;
}

export function setSession(auth: AuthResponse): void {
  accessToken = auth.accessToken;
  session = {
    user: auth.user,
    tenant: auth.tenant,
    memberships: auth.memberships,
  };
  notify();
}

export function clearSession(): void {
  accessToken = null;
  session = null;
  notify();
}

/** Subscribe to session changes (login, refresh, tenant switch, logout). */
export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Try to restore a session from the refresh cookie. Raw fetch, not the api
 * client - the client itself calls this on a 401, so going through it would
 * recurse.
 */
export async function refreshSession(): Promise<boolean> {
  const res = await fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    clearSession();
    return false;
  }
  setSession((await res.json()) as AuthResponse);
  return true;
}

/** Auth-guard entry: token in memory, or one silent refresh. (page-spec §2) */
export async function ensureSession(): Promise<boolean> {
  if (accessToken) return true;
  return refreshSession();
}
