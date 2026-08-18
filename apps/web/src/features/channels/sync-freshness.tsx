import { Link } from "@tanstack/react-router";
import type { SyncHealthResponse } from "@sambung/shared";
import { formatAge } from "../../lib/relative-time";
import { STALE_HINT } from "./stale-hint";
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

  // A failed health read must NOT render as silence. Silence here reads exactly
  // like a healthy calendar, which is the false comfort this whole feature exists
  // to remove - "we could not tell you" and "everything is fine" are different
  // answers, and only one of them is true. First load (no data, no error) stays
  // quiet: that is a moment, not a state.
  if (isError) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-destructive">
        Can’t tell how current this calendar is right now - the sync check
        didn’t answer.
      </p>
    );
  }
  if (!data) return null;

  const warning = data.erroring > 0 || data.stale > 0;

  return (
    <p
      role="status"
      aria-live="polite"
      className={`text-sm ${warning ? "text-destructive" : "text-muted-foreground"}`}
    >
      {freshnessSentence(data)}{" "}
      {warning && (
        // Channels are configured per Property, so the property LIST is the
        // nearest real destination - there is no channels route to send them to
        // (sitemap §3). The label names the errand, the link starts it.
        <Link to="/app/properties" className="font-medium underline">
          Check channels
        </Link>
      )}
    </p>
  );
}

/**
 * One sentence for the whole fleet. Ordered by what the owner should do next, not
 * by severity: an erroring feed needs its URL looked at, and a stale one means the
 * pull itself has stopped.
 */
function freshnessSentence(h: SyncHealthResponse): string {
  if (h.feeds === 0) return "No OTA calendar connected yet.";

  const feeds = `${h.feeds} OTA calendar${h.feeds === 1 ? "" : "s"}`;
  // The age travels with the bad news, never instead of it. Saying only "could
  // not be reached" repeats at fleet level the exact mistake FR-05 names at feed
  // level: a red line that hides HOW FAR BEHIND understates the damage, and "for
  // ten minutes" and "for three days" are not the same emergency.
  const age =
    h.oldestSyncedAt === null ? null : formatAge(h.oldestSyncedAt, new Date());

  if (h.erroring > 0) {
    const since = age === null ? "" : `; last good check ${age}`;
    return `${h.erroring} of ${feeds} could not be reached${since}.`;
  }
  if (h.stale > 0) {
    const when = age === null ? "not been checked recently" : `last checked ${age}`;
    return `${h.stale} of ${feeds} ${when} - ${STALE_HINT}.`;
  }
  // Unreachable against today's server, and kept because the CONTRACT says it is
  // possible: `oldestSyncedAt` is nullable, and TypeScript is right to make us
  // answer for that. The reason it cannot happen now is narrow - `connect` stamps
  // `error` whenever the probe fails, so a null `last_synced_at` always travels
  // with an erroring feed, and the branch above claims it first. A future route
  // that creates a connection WITHOUT probing would land here, and this sentence
  // is what it should say. It is deliberately not claimed as tested (spec §3).
  if (h.oldestSyncedAt === null) {
    return `${feeds} connected, not checked yet.`;
  }
  return `${feeds} checked ${formatAge(h.oldestSyncedAt, new Date())}.`;
}
