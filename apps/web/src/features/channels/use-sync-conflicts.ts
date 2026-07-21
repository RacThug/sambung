import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DismissSyncConflictResponse,
  SyncConflict,
} from "@sambung/shared";
import { api } from "../../lib/api-client";

/** One cache key for the conflict inbox. Dismiss invalidates it so the list
 * re-reads the server truth rather than removing a row client-side - the same rule
 * the lapsed-payment inbox follows, and for the same reason: a local removal is a
 * second opinion about what is open. */
const CONFLICTS_KEY = ["sync-conflicts"] as const;

/** The conflict inbox read (#38): `GET /sync-conflicts`, owner-scoped, `open` by
 * default (the server's schema supplies that default, so the URL stays bare). */
export function useSyncConflicts() {
  return useQuery({
    queryKey: CONFLICTS_KEY,
    queryFn: () => api.get<SyncConflict[]>("/sync-conflicts"),
  });
}

/**
 * The "dismiss" action, per row so each owns its pending state. Invalidates on
 * settle either way: a 404 means the row is already gone, and refetching shows the
 * truth instead of leaving a stuck item.
 *
 * There is no "resolve" mutation, deliberately (api-spec §7.5): resolving means
 * cancelling the blocking booking, after which the next sync measures that the clash
 * is gone. A button here that marked it resolved would be the UI asserting something
 * the exclusion constraint has not agreed to.
 */
export function useDismissConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<DismissSyncConflictResponse>(`/sync-conflicts/${id}/dismiss`, {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CONFLICTS_KEY });
    },
  });
}
