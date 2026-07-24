import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { SyncAllResponse } from "@sambung/shared";
import { Button } from "@/components/ui/button";
import { api } from "../../lib/api-client";

/**
 * "Sync now" for every feed the owner can see - the calendar's primary action
 * (#201). The import otherwise runs on a 30-min cron (ADR-0025), which is right
 * for a background reconcile and wrong for the moment someone has just changed a
 * calendar on Airbnb and wants to see it here.
 *
 * Server-side fan-out (`POST /channels/sync`), not a loop in the browser: one
 * request means one aggregate answer, sequential outbound fetches, and no
 * N-requests-per-click against a third party. Which feeds is RLS's answer, so
 * staff sweep only their assigned properties without the client knowing that.
 *
 * On success every read the sync could have changed is invalidated - bookings
 * (new bars), sync conflicts and the Inbox badge (a refused VEVENT files one).
 */
export function SyncNowButton() {
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationFn: () => api.post<SyncAllResponse>("/channels/sync"),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bookings"] }),
        queryClient.invalidateQueries({ queryKey: ["sync-conflicts"] }),
      ]);
    },
  });

  return (
    <div className="flex min-w-0 items-center gap-3">
      {/* The result lives beside the button, not in a toast: it is a summary the
          owner may want to read twice ("1 clashed" sends them to the Inbox), and
          it is gone on the next click anyway. */}
      <span
        // Announced politely so a screen-reader user learns the outcome without
        // being interrupted mid-sentence.
        role="status"
        aria-live="polite"
        className="truncate text-sm text-muted-foreground"
      >
        {sync.isPending
          ? "Syncing…"
          : sync.isError
            ? "Sync failed. Please try again."
            : sync.data
              ? summarise(sync.data)
              : ""}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={sync.isPending}
        onClick={() => sync.mutate()}
      >
        <RefreshCw
          className={`mr-2 size-4 ${sync.isPending ? "animate-spin" : ""}`}
          aria-hidden
        />
        Sync now
      </Button>
    </div>
  );
}

/**
 * The one-line result. `feeds: 0` is its own sentence because "nothing imported"
 * would be a lie by omission when the real answer is "you have not connected an
 * OTA calendar yet" - the same reason the endpoint reports `feeds` rather than
 * leaving it to be inferred.
 */
function summarise(r: SyncAllResponse): string {
  if (r.feeds === 0) return "No OTA calendars connected yet.";
  const parts = [`${r.feeds} feed${r.feeds === 1 ? "" : "s"} checked`];
  if (r.imported > 0) parts.push(`${r.imported} imported`);
  if (r.cancelled > 0) parts.push(`${r.cancelled} cancelled`);
  if (r.conflicts > 0)
    parts.push(`${r.conflicts} clashed - see Inbox`);
  if (r.errored > 0) parts.push(`${r.errored} erroring`);
  // Nothing changed is a real, common answer, and saying so beats a bare count.
  if (parts.length === 1) parts.push("nothing new");
  return parts.join(" · ");
}
