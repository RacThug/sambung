import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AvailabilityResponse } from "@sambung/shared";
import { api } from "../../lib/api-client";
import { sameStay } from "./availability-model";

type Stay = { from: string; to: string };

/** `GET /public/units/:id/availability?from&to` - the one quote endpoint, used in
 * both modes (api-spec §5.1). Encoded so a `?` in a date can't ever break out. */
function availabilityPath(unitId: string, from: string, to: string): string {
  const q = new URLSearchParams({ from, to });
  return `/public/units/${unitId}/availability?${q.toString()}`;
}

/** Trailing debounce: settles to `value` `ms` after it last changed. Keeps the
 * quote from firing on every intermediate click while the guest picks a range. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (ms <= 0) {
      setSettled(value);
      return;
    }
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * Mode 1 (api-spec §5.1): query the visible month's window to learn which nights
 * are booked, so the calendar can grey them. Only `blockedRanges` is used - the
 * window's own `available`/price is meaningless for a whole month. Cached by
 * `(unitId, from, to)`, the same key shape as the quote, so a selection that
 * happens to match a fetched window is a cache hit.
 */
export function useMonthBlocked(unitId: string, window: Stay) {
  return useQuery({
    queryKey: ["availability", unitId, window.from, window.to],
    queryFn: () =>
      api.get<AvailabilityResponse>(
        availabilityPath(unitId, window.from, window.to),
      ),
    staleTime: 60_000,
  });
}

/**
 * Mode 2 (api-spec §5.1): quote the concrete `[from, to)` selection - debounced,
 * enabled only once a full stay is picked. Returns the query plus `syncing`:
 * true while the live selection is ahead of the debounced one, so the card can
 * say "checking" instead of flashing the previous stay's price for ~300 ms.
 */
export function useQuote(unitId: string, stay: Stay | null, debounceMs: number) {
  const debounced = useDebounced(stay, debounceMs);
  const query = useQuery({
    queryKey: [
      "availability",
      unitId,
      debounced?.from ?? null,
      debounced?.to ?? null,
    ],
    queryFn: () =>
      api.get<AvailabilityResponse>(
        availabilityPath(unitId, debounced!.from, debounced!.to),
      ),
    enabled: debounced !== null,
  });
  return { query, syncing: stay !== null && !sameStay(stay, debounced) };
}
