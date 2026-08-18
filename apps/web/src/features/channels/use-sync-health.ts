import { useQuery } from "@tanstack/react-query";
import type { SyncHealthResponse } from "@sambung/shared";
import { api } from "../../lib/api-client";

/** The one key both sync verbs invalidate. Exported so "Sync now" (fleet and
 * per-feed) cannot invalidate a near-miss of it - a freshness line that survives
 * the sync that just moved it is the bug this feature exists to remove. */
export const SYNC_HEALTH_KEY = ["channels", "health"] as const;

/**
 * How current the whole calendar is (api-spec §7.7, spec UX-01/UX-07).
 *
 * Polled, because this value ages on screen: a "checked 4 minutes ago" line left
 * to sit for an hour is itself a stale claim about staleness. One minute is well
 * inside the 30-minute sweep it reports on, and the read is a single aggregate
 * with no outbound fetch, so the cost is noise.
 *
 * `staleTime: 0` overrides the client default (30s): this query's whole value is
 * that it is current, and serving it from cache after a refetch interval fired
 * would defeat the interval.
 */
export function useSyncHealth() {
  return useQuery({
    queryKey: SYNC_HEALTH_KEY,
    queryFn: () => api.get<SyncHealthResponse>("/channels/health"),
    refetchInterval: 60_000,
    // Stated, not inherited. It is TanStack's default too, but this one is load
    // bearing - a tab left open all afternoon is exactly when the sweeper dies -
    // and a default someone tunes globally later would silently take it away.
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}
