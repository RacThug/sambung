import { useSyncExternalStore } from "react";
import { getSession, subscribeToSession } from "./auth";

/**
 * The current session, re-rendering when it changes (#154).
 *
 * `getSession()` alone is a plain read of a module-level `let`, which is fine
 * for anything decided once per mount - `isOwner()` still works that way. This
 * hook exists for the one thing that changes WHILE a page is mounted: switching
 * workspace. Same `useSyncExternalStore` shape as the locale store (ADR-0024),
 * for the same reason - one value, no library.
 */
export function useSession(): ReturnType<typeof getSession> {
  return useSyncExternalStore(subscribeToSession, getSession, getSession);
}
