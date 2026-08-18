import { Link } from "@tanstack/react-router";
import type { SyncHealthResponse } from "@sambung/shared";
import { formatAge } from "../../lib/relative-time";
import { useSyncHealth } from "./use-sync-health";

/**
 * How current is this calendar? - stated on the page where availability is
 * actually read, without anyone having to click "Sync now" first (REQ-AV-04,
 * spec UX-01/03).
 *
 * The number shown is the fleet's OLDEST successful pull (ADR-0040): a calendar
 * is only as current as its stalest feed, and the freshest one's timestamp would
 * be a flattering answer to the question the owner is really asking.
 *
 * The `stale`/`erroring` judgement comes from the server; this component only
 * phrases it. And when something IS wrong it says so here, next to the calendar -
 * a red pill on a settings page nobody opens is not a warning.
 */
export function SyncFreshness() {
  const { data, isError } = useSyncHealth();

  // Silent while unknown. A freshness widget that renders "unknown" on every page
  // load teaches the owner to ignore it before it ever has something to say.
  if (isError || !data) return null;

  const message = describe(data);
  const warning = data.erroring > 0 || data.stale > 0;

  return (
    <p
      role="status"
      aria-live="polite"
      className={`text-sm ${warning ? "text-destructive" : "text-muted-foreground"}`}
    >
      {message}{" "}
      {warning && (
        <Link to="/app/properties" className="font-medium underline">
          Check channels
        </Link>
      )}
    </p>
  );
}

/**
 * One sentence for the whole fleet. Ordered by what the owner should do next, not
 * by severity: an erroring feed needs its URL looked at, a stale one means the
 * pull itself has stopped, and "never synced" only means wait.
 */
function describe(h: SyncHealthResponse): string {
  if (h.feeds === 0) return "No OTA calendar connected yet.";

  const feeds = `${h.feeds} OTA calendar${h.feeds === 1 ? "" : "s"}`;
  if (h.erroring > 0) {
    return `${h.erroring} of ${feeds} could not be reached.`;
  }
  if (h.stale > 0) {
    return `${h.stale} of ${feeds} ${h.stale === 1 ? "has" : "have"} not been checked recently - syncing may have stopped.`;
  }
  if (h.oldestSyncedAt === null) {
    return `${feeds} connected, not checked yet.`;
  }
  return `${feeds} checked ${formatAge(h.oldestSyncedAt, new Date())}.`;
}
