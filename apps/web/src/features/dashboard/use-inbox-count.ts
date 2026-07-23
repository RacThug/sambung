import { useSyncConflicts } from "../channels/use-sync-conflicts";
import { useLapsedPayments } from "../payments/use-lapsed-payments";

/**
 * The count badged on the Inbox nav item (page-spec §4.6). It is the two inbox
 * queues summed: open sync conflicts (#38) + paid-but-lapsed payments (#120) -
 * the same two lists `/app/inbox` shows, so the badge and the page can't disagree.
 *
 * Reuses the inbox sections' own query hooks, so both share one cache key each:
 * the shell's badge and the inbox page read the same data, never two fetches. The
 * shell mounts on every `/app` page, so the badge is current wherever you are.
 * A load error or empty cache reads as 0 - a nav badge is best-effort, never a
 * blocker.
 */
export function useInboxCount(): number {
  const conflicts = useSyncConflicts();
  const lapsed = useLapsedPayments();
  return (conflicts.data?.length ?? 0) + (lapsed.data?.length ?? 0);
}
