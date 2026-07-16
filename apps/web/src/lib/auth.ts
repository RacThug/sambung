import type { AuthResponse } from "@sambung/shared";

// The access token lives in MEMORY ONLY - never localStorage (XSS = full
// account takeover). A page reload loses it by design; the httpOnly refresh
// cookie silently restores the session. (architecture.md §4.4)
let session: Pick<AuthResponse, "user" | "tenant"> | null = null;
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function getSession(): Pick<AuthResponse, "user" | "tenant"> | null {
  return session;
}

export function setSession(auth: AuthResponse): void {
  accessToken = auth.accessToken;
  session = { user: auth.user, tenant: auth.tenant };
}

export function clearSession(): void {
  accessToken = null;
  session = null;
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
